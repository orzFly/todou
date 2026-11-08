import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { describe, expect, it, vi } from "vitest";
import { serveOpenAPIDocument } from "../src/routes/openapi-doc.ts";

const pingRoute = (path: string) =>
  createRoute({
    method: "get",
    path,
    responses: {
      200: {
        description: "pong",
        content: { "application/json": { schema: z.object({}) } },
      },
    },
  });

const config = { openapi: "3.1.0", info: { title: "t", version: "0" } };

describe("serveOpenAPIDocument (T-628)", () => {
  it("generates the document once across requests", async () => {
    const api = new OpenAPIHono();
    api.openapi(pingRoute("/ping"), (c) => c.json({}, 200));
    const generate = vi.spyOn(api, "getOpenAPI31Document");
    serveOpenAPIDocument(api, "/doc", config);

    const first = await (await api.request("/doc")).json();
    const second = await (await api.request("/doc")).json();
    expect(second).toEqual(first);
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it("includes routes registered after it", async () => {
    const api = new OpenAPIHono();
    serveOpenAPIDocument(api, "/doc", config);
    api.openapi(pingRoute("/later"), (c) => c.json({}, 200));

    const doc = (await (await api.request("/doc")).json()) as {
      paths: Record<string, unknown>;
    };
    expect(Object.keys(doc.paths)).toContain("/later");
  });
});
