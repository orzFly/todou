import { createHash, createHmac } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * In-process S3 stand-in for tests: object CRUD over a Map, plus real
 * SigV4 verification. Verifying for real (the fake knows the secret) is
 * what makes the interesting assertions possible at all — a presigned PUT
 * whose body length differs from the signed content-length must fail with
 * 403 here exactly like it does on MinIO/AWS.
 */

export const FAKE_S3_ACCESS_KEY = "test-ak";
export const FAKE_S3_SECRET_KEY = "test-sk";

export type FakeS3 = {
  url: string;
  bucket: string;
  objects: Map<string, Buffer>;
  /**
   * LastModified as listings report it, written on every PUT; a test may
   * backdate an entry. An object set in `objects` directly lists as now.
   */
  modified: Map<string, Date>;
  /** Every request observed, oldest first — for retry/traffic assertions. */
  requests: Array<{ method: string; key: string }>;
  /** Make the next `n` object requests fail with `status`. */
  failNext(n: number, status?: number): void;
  close(): Promise<void>;
};

export async function startFakeS3(bucket = "test-bucket"): Promise<FakeS3> {
  const objects = new Map<string, Buffer>();
  const modified = new Map<string, Date>();
  const requests: FakeS3["requests"] = [];
  let failures = 0;
  let failureStatus = 500;

  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      const url = new URL(req.url ?? "/", "http://localhost");
      const method = req.method ?? "GET";

      const verdict = verifySigV4(req.headers, url, method, body);
      if (verdict !== null) {
        res.writeHead(verdict.status, { "content-type": "application/xml" });
        res.end(`<Error><Code>${verdict.code}</Code></Error>`);
        return;
      }

      const path = url.pathname.replace(/^\//, "");
      if (!path.startsWith(`${bucket}/`) && path !== bucket) {
        res.writeHead(404).end();
        return;
      }
      if (path === bucket && url.searchParams.get("list-type") === "2") {
        res.writeHead(200, { "content-type": "application/xml" });
        res.end(listObjectsV2(objects, modified, url.searchParams));
        return;
      }
      // HEAD on the bare bucket is the startup probe.
      if (path === bucket) {
        res.writeHead(200).end();
        return;
      }
      const key = path.slice(bucket.length + 1);
      requests.push({ method, key });

      if (failures > 0) {
        failures--;
        res.writeHead(failureStatus).end();
        return;
      }

      switch (method) {
        case "PUT": {
          const copySource = req.headers["x-amz-copy-source"];
          if (typeof copySource === "string") {
            const source = decodeURIComponent(copySource).replace(/^\//, "");
            const data = source.startsWith(`${bucket}/`)
              ? objects.get(source.slice(bucket.length + 1))
              : undefined;
            if (!data) {
              res.writeHead(404, { "content-type": "application/xml" });
              res.end("<Error><Code>NoSuchKey</Code></Error>");
              return;
            }
            objects.set(key, Buffer.from(data));
            modified.set(key, new Date());
            res.writeHead(200, { "content-type": "application/xml" });
            res.end("<CopyObjectResult></CopyObjectResult>");
            return;
          }
          const declared = req.headers["x-amz-checksum-sha256"];
          if (typeof declared === "string") {
            const actual = createHash("sha256").update(body).digest("base64");
            if (actual !== declared) {
              res.writeHead(400, { "content-type": "application/xml" });
              res.end(
                "<Error><Code>XAmzContentChecksumMismatch</Code></Error>",
              );
              return;
            }
          }
          objects.set(key, body);
          modified.set(key, new Date());
          res.writeHead(200, {
            etag: `"${createHash("md5").update(body).digest("hex")}"`,
          });
          res.end();
          return;
        }
        case "GET":
        case "HEAD": {
          const data = objects.get(key);
          if (!data) {
            res.writeHead(404).end();
            return;
          }
          const headers: Record<string, string> = {
            "content-length": String(data.byteLength),
            "content-type":
              url.searchParams.get("response-content-type") ??
              "application/octet-stream",
          };
          const disposition = url.searchParams.get(
            "response-content-disposition",
          );
          if (disposition) headers["content-disposition"] = disposition;
          res.writeHead(200, headers);
          res.end(method === "GET" ? data : undefined);
          return;
        }
        case "DELETE": {
          modified.delete(key);
          if (!objects.delete(key)) {
            res.writeHead(404).end();
            return;
          }
          res.writeHead(204).end();
          return;
        }
        default:
          res.writeHead(405).end();
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    bucket,
    objects,
    modified,
    requests,
    failNext(n, status = 500) {
      failures = n;
      failureStatus = status;
    },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

const escapeXml = (value: string) =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");

/**
 * ListObjectsV2 over the map: lexical order, `prefix`, `max-keys` (default
 * 1000), and a continuation token that is simply the last key returned.
 */
function listObjectsV2(
  objects: Map<string, Buffer>,
  modified: Map<string, Date>,
  query: URLSearchParams,
): string {
  const prefix = query.get("prefix") ?? "";
  const maxKeys = Number(query.get("max-keys") ?? 1000);
  const after = query.get("continuation-token") ?? "";
  const keys = [...objects.keys()]
    .filter((k) => k.startsWith(prefix) && k > after)
    .sort();
  const page = keys.slice(0, maxKeys);
  const truncated = keys.length > page.length;
  const contents = page
    .map(
      (k) =>
        `<Contents><Key>${escapeXml(k)}</Key>` +
        `<LastModified>${(modified.get(k) ?? new Date()).toISOString()}</LastModified>` +
        `<Size>${objects.get(k)?.byteLength ?? 0}</Size></Contents>`,
    )
    .join("");
  const last = page.at(-1);
  return (
    '<?xml version="1.0" encoding="UTF-8"?>' +
    "<ListBucketResult><Name>bucket</Name>" +
    `<Prefix>${escapeXml(prefix)}</Prefix><KeyCount>${page.length}</KeyCount>` +
    `<MaxKeys>${maxKeys}</MaxKeys><IsTruncated>${truncated}</IsTruncated>` +
    (truncated && last
      ? `<NextContinuationToken>${escapeXml(last)}</NextContinuationToken>`
      : "") +
    `${contents}</ListBucketResult>`
  );
}

const encodeRfc3986 = (value: string) =>
  encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );

/** null = accepted; otherwise the rejection to send. */
function verifySigV4(
  headers: Record<string, string | string[] | undefined>,
  url: URL,
  method: string,
  body: Buffer,
): { status: number; code: string } | null {
  const query = url.searchParams;
  const isQueryAuth = query.has("X-Amz-Signature");
  const authHeader =
    typeof headers.authorization === "string" ? headers.authorization : "";
  if (!isQueryAuth && !authHeader.startsWith("AWS4-HMAC-SHA256 ")) {
    return { status: 403, code: "AccessDenied" };
  }

  let signature: string;
  let signedHeaderNames: string[];
  let credentialScope: string;
  let amzDate: string;
  let payloadHash: string;

  if (isQueryAuth) {
    signature = query.get("X-Amz-Signature") ?? "";
    signedHeaderNames = (query.get("X-Amz-SignedHeaders") ?? "").split(";");
    credentialScope = (query.get("X-Amz-Credential") ?? "")
      .split("/")
      .slice(1)
      .join("/");
    amzDate = query.get("X-Amz-Date") ?? "";
    payloadHash = "UNSIGNED-PAYLOAD";
    const expires = Number(query.get("X-Amz-Expires") ?? 0);
    const issued = Date.parse(
      amzDate.replace(
        /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/,
        "$1-$2-$3T$4:$5:$6Z",
      ),
    );
    if (Number.isNaN(issued) || Date.now() > issued + expires * 1000) {
      return { status: 403, code: "AccessDenied" };
    }
  } else {
    const match = authHeader.match(
      /Credential=[^/]+\/([^,]+), SignedHeaders=([^,]+), Signature=(\w+)/,
    );
    if (!match?.[1] || !match[2] || !match[3]) {
      return { status: 403, code: "AccessDenied" };
    }
    credentialScope = match[1];
    signedHeaderNames = match[2].split(";");
    signature = match[3];
    amzDate = String(headers["x-amz-date"] ?? "");
    payloadHash =
      String(headers["x-amz-content-sha256"] ?? "") ||
      createHash("sha256").update(body).digest("hex");
  }

  const canonicalQuery = [...query.entries()]
    .filter(([k]) => k !== "X-Amz-Signature")
    .map(([k, v]) => [encodeRfc3986(k), encodeRfc3986(v)] as const)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  const canonicalHeaders = signedHeaderNames
    .map((name) => {
      // content-length reaches Node lower-cased already; values are what the
      // client actually transmitted — the whole point of the verification.
      const value =
        name === "content-length" && headers[name] === undefined
          ? String(body.byteLength)
          : String(headers[name] ?? "");
      return `${name}:${value.trim()}\n`;
    })
    .join("");
  const canonicalRequest = [
    method,
    url.pathname,
    canonicalQuery,
    canonicalHeaders,
    signedHeaderNames.join(";"),
    payloadHash,
  ].join("\n");

  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    credentialScope,
    createHash("sha256").update(canonicalRequest).digest("hex"),
  ].join("\n");

  const [date = "", region = "", service = ""] = credentialScope.split("/");
  let key: Buffer = Buffer.from(`AWS4${FAKE_S3_SECRET_KEY}`);
  for (const part of [date, region, service, "aws4_request"]) {
    key = createHmac("sha256", key).update(part).digest();
  }
  const expected = createHmac("sha256", key).update(stringToSign).digest("hex");

  return expected === signature
    ? null
    : { status: 403, code: "SignatureDoesNotMatch" };
}
