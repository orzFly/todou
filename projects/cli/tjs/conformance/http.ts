import type * as http from "node:http";
import { type Cases, equal } from "./assert.ts";

type Http = typeof http;

/** The login listener's shape: GET with a query, POST with a form, a redirect. */
async function withServer(
  mod: Http,
  run: (base: string) => Promise<void>,
): Promise<void> {
  const server = mod.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (req.method === "POST") {
      const chunks: Uint8Array[] = [];
      req.on("data", (chunk: Uint8Array) => chunks.push(chunk));
      req.on("end", () => {
        const body = new TextDecoder().decode(
          new Uint8Array(chunks.flatMap((chunk) => [...chunk])),
        );
        res.writeHead(303, { location: `/done?${body}` });
        res.end();
      });
      return;
    }
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    res.end(`${req.method} ${url.pathname} ${url.searchParams.get("q")}`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

export const cases: Cases<Http> = {
  "GET reaches the handler with path and query": (mod) =>
    withServer(mod, async (base) => {
      const res = await fetch(`${base}/callback?q=1`);
      equal(res.status, 200, "status");
      equal(
        res.headers.get("content-type"),
        "text/plain; charset=utf-8",
        "type",
      );
      equal(await res.text(), "GET /callback 1", "body");
    }),

  "POST body arrives and a 303 carries its location": (mod) =>
    withServer(mod, async (base) => {
      const res = await fetch(`${base}/callback`, {
        method: "POST",
        body: new URLSearchParams({ token: "t", state: "s" }),
        redirect: "manual",
      });
      equal(res.status, 303, "status");
      equal(res.headers.get("location"), "/done?token=t&state=s", "location");
    }),
};
