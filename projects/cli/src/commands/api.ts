import { readFileSync } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { TodouClient } from "@todou/shared";
import { Command, Option } from "clipanion";
import { ApiCommand } from "../api-command.ts";
import { drain } from "../body.ts";
import { CliError } from "../errors.ts";
import { parseChoice } from "../parse.ts";

const METHODS = ["get", "post", "patch", "put", "delete"] as const;

/** Matches application/json and its suffix forms (application/problem+json). */
const JSON_CONTENT_TYPE = /[+/]json\b/i;

/** Escape hatch for endpoints without a dedicated command. */
export class ApiPassthroughCommand extends ApiCommand {
  static paths = [["api"]];
  static usage = Command.Usage({
    description: "Raw API call: todou api <method> </path>",
    details:
      "The path is relative to /api. --body takes inline JSON, @file, or - for stdin; -f k=v adds query parameters. JSON responses are pretty-printed; anything else (an attachment download, an export) streams to stdout byte for byte, so it can be redirected to a file.",
  });

  method = Option.String({ required: true });
  endpoint = Option.String({ required: true });
  body = Option.String("--body", {
    description: "JSON body: inline, @file, or -",
  });
  fields = Option.Array("-f,--field", [], {
    description: "Query parameter k=v",
  });

  protected async run(client: TodouClient): Promise<void> {
    const method = parseChoice(
      this.method.toLowerCase(),
      METHODS,
      "method",
    ).toUpperCase();
    if (!this.endpoint.startsWith("/")) {
      throw new CliError(`path must start with /, got "${this.endpoint}"`);
    }

    const query: Record<string, string> = {};
    for (const field of this.fields) {
      const eq = field.indexOf("=");
      if (eq <= 0) {
        throw new CliError(`-f expects k=v, got "${field}"`);
      }
      query[field.slice(0, eq)] = field.slice(eq + 1);
    }

    const res = await client.requestRaw(method, this.endpoint, {
      json: await this.readJsonBody(),
      query,
    });
    if (res.status === 204 || res.body === null) return;
    if (JSON_CONTENT_TYPE.test(res.headers.get("content-type") ?? "")) {
      const parsed: unknown = await res.json();
      this.context.stdout.write(`${JSON.stringify(parsed, null, 2)}\n`);
      return;
    }
    // Unconditional parsing used to make every binary endpoint unusable and
    // push people into hand-rolling an authenticated curl (T-176).
    // `end: false`: stdout belongs to the process, not to this pipeline.
    await pipeline(
      Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]),
      this.context.stdout,
      { end: false },
    );
  }

  private async readJsonBody(): Promise<unknown> {
    if (this.body === undefined) return undefined;
    let raw: string;
    if (this.body === "-") {
      raw = await drain(this.context.stdin);
    } else if (this.body.startsWith("@")) {
      const file = this.body.slice(1);
      try {
        raw = readFileSync(file, "utf8");
      } catch (cause) {
        throw new CliError(`cannot read ${file}: ${String(cause)}`);
      }
    } else {
      raw = this.body;
    }
    try {
      return JSON.parse(raw);
    } catch {
      throw new CliError("--body is not valid JSON");
    }
  }
}
