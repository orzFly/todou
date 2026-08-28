import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { AwsClient, AwsV4Signer } from "aws4fetch";
import { type Config, ConfigError, type S3Credentials } from "../config.ts";
import { NotFoundError, UpstreamError } from "../errors.ts";
import { contentDisposition } from "../http/content-disposition.ts";
import type { StorageBackend } from "./types.ts";

type S3Settings = Config["storage"]["s3"];

/** Grows 300ms → 600ms → 1.2s …; the cap keeps long retry runs sane. */
const RETRY_BASE_MS = 300;
const RETRY_CAP_MS = 5_000;

export class S3Storage implements StorageBackend {
  #settings: S3Settings;
  #credentials: S3Credentials;
  #client: AwsClient;

  constructor(settings: S3Settings, credentials: S3Credentials) {
    this.#settings = settings;
    this.#credentials = credentials;
    this.#client = new AwsClient({
      accessKeyId: credentials.accessKeyId,
      secretAccessKey: credentials.secretAccessKey,
      sessionToken: credentials.sessionToken,
      service: "s3",
      region: settings.region,
      // aws4fetch ships its own retry loop (default 10 attempts); #call owns
      // the policy, config-driven, so the layers must not multiply.
      retries: 0,
    });
  }

  /** Startup probe: misconfiguration stops the boot, not the first download. */
  async checkBucket(): Promise<void> {
    let url: URL;
    if (this.#settings.force_path_style) {
      url = new URL(`${this.#settings.endpoint}/${this.#settings.bucket}`);
    } else {
      url = new URL(this.#settings.endpoint);
      url.host = `${this.#settings.bucket}.${url.host}`;
    }
    let res: Response;
    try {
      res = await this.#client.fetch(url.toString(), {
        method: "HEAD",
        signal: AbortSignal.timeout(this.#settings.request_timeout_ms),
      });
    } catch (cause) {
      throw new ConfigError(
        `storage.s3: cannot reach ${this.#settings.endpoint}: ${String(cause)}`,
      );
    }
    if (!res.ok) {
      throw new ConfigError(
        `storage.s3: HEAD bucket "${this.#settings.bucket}" returned HTTP ${res.status}` +
          (res.status === 404
            ? " (bucket missing?)"
            : res.status === 403
              ? " (credentials or permissions?)"
              : ""),
      );
    }
  }

  /**
   * The DB stores prefix-less keys; the prefix is deployment layout, not
   * identity, so re-prefixing must never require a data migration.
   */
  #objectUrl(key: string, base: string): URL {
    const path = `${this.#settings.key_prefix}${key}`;
    if (this.#settings.force_path_style) {
      return new URL(`${base}/${this.#settings.bucket}/${path}`);
    }
    const url = new URL(base);
    url.host = `${this.#settings.bucket}.${url.host}`;
    url.pathname = `/${path}`;
    return url;
  }

  async #call(
    op: string,
    key: string,
    init: {
      method: string;
      body?: Uint8Array;
      headers?: Record<string, string>;
    },
  ): Promise<Response> {
    const url = this.#objectUrl(key, this.#settings.endpoint);
    let lastFailure = "";
    for (let attempt = 0; ; attempt++) {
      let res: Response | undefined;
      try {
        res = await this.#client.fetch(url.toString(), {
          ...init,
          signal: AbortSignal.timeout(this.#settings.request_timeout_ms),
        });
      } catch (cause) {
        lastFailure = String(cause);
      }
      if (res) {
        if (res.ok) return res;
        if (res.status === 404) {
          throw new NotFoundError("attachment blob not found");
        }
        lastFailure = `HTTP ${res.status}`;
        // 4xx (other than 429) means the request itself is wrong; retrying
        // resends the same bytes to the same verdict.
        if (res.status < 500 && res.status !== 429) {
          await res.body?.cancel();
          break;
        }
        await res.body?.cancel();
      }
      if (attempt >= this.#settings.retries) break;
      const delay = Math.min(RETRY_BASE_MS * 2 ** attempt, RETRY_CAP_MS);
      await new Promise((r) => setTimeout(r, delay + Math.random() * 100));
    }
    console.error(`s3 ${op} failed for ${key}: ${lastFailure}`);
    throw new UpstreamError(`storage ${op} failed`, {
      op,
      upstream: lastFailure,
    });
  }

  async put(key: string, data: Uint8Array): Promise<void> {
    await this.#call("put", key, {
      method: "PUT",
      body: data,
      headers: {
        // The store verifies the digest before accepting the write, so a
        // successful PUT doubles as an integrity check.
        "x-amz-checksum-sha256": createHash("sha256")
          .update(data)
          .digest("base64"),
        "content-length": String(data.byteLength),
      },
    });
  }

  async getStream(key: string) {
    const res = await this.#call("get", key, { method: "GET" });
    if (!res.body) throw new UpstreamError("storage get returned no body");
    return {
      stream: Readable.fromWeb(
        res.body as import("node:stream/web").ReadableStream,
      ),
      size: Number(res.headers.get("content-length") ?? 0),
    };
  }

  async delete(key: string): Promise<void> {
    try {
      await this.#call("delete", key, { method: "DELETE" });
    } catch (err) {
      // Matches FsStorage's rm(force: true): deleting the absent is success.
      if (!(err instanceof NotFoundError)) throw err;
    }
  }

  async head(key: string): Promise<{ size: number } | null> {
    try {
      const res = await this.#call("head", key, { method: "HEAD" });
      return { size: Number(res.headers.get("content-length") ?? 0) };
    } catch (err) {
      if (err instanceof NotFoundError) return null;
      throw err;
    }
  }

  async urlFor(
    key: string,
    opts?: { filename?: string; contentType?: string },
  ): Promise<string | null> {
    const url = this.#objectUrl(key, this.#settings.public_endpoint);
    url.searchParams.set(
      "X-Amz-Expires",
      String(this.#settings.presign_expiry_seconds),
    );
    if (opts?.filename) {
      // The store replays this parameter back as the response header
      // verbatim, so it has to be header-legal here too (T-147).
      url.searchParams.set(
        "response-content-disposition",
        contentDisposition("attachment", opts.filename),
      );
    }
    if (opts?.contentType) {
      url.searchParams.set("response-content-type", opts.contentType);
    }
    return (await this.#presign(url, "GET")).toString();
  }

  /**
   * Presigned PUT for browser direct upload. content-length goes into
   * SignedHeaders, making the declared size a hard limit — a body of any
   * other length fails signature validation at the store. The client's
   * sha256, when provided, is pinned the same way.
   */
  async presignPut(
    key: string,
    size: number,
    sha256?: string,
  ): Promise<{ url: string; headers: Record<string, string> }> {
    const url = this.#objectUrl(key, this.#settings.public_endpoint);
    url.searchParams.set(
      "X-Amz-Expires",
      String(this.#settings.upload_expiry_seconds),
    );
    const headers: Record<string, string> = {
      "content-length": String(size),
    };
    if (sha256) headers["x-amz-checksum-sha256"] = sha256;
    const signed = await this.#presign(url, "PUT", headers);
    // content-length is set by the HTTP stack (browsers forbid setting it
    // manually), so only the checksum header travels back to the client.
    const clientHeaders: Record<string, string> = {};
    if (sha256) clientHeaders["x-amz-checksum-sha256"] = sha256;
    return { url: signed.toString(), headers: clientHeaders };
  }

  async #presign(
    url: URL,
    method: string,
    headers?: Record<string, string>,
  ): Promise<URL> {
    const signer = new AwsV4Signer({
      url: url.toString(),
      method,
      headers,
      accessKeyId: this.#credentials.accessKeyId,
      secretAccessKey: this.#credentials.secretAccessKey,
      sessionToken: this.#credentials.sessionToken,
      service: "s3",
      region: this.#settings.region,
      signQuery: true,
      allHeaders: true,
    });
    const { url: signed } = await signer.sign();
    return new URL(signed.toString());
  }
}
