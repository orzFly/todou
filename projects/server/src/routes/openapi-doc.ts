import type { OpenAPIHono } from "@hono/zod-openapi";

type DocumentConfig = Parameters<OpenAPIHono["getOpenAPI31Document"]>[0];

/**
 * `doc31` with the generated document kept (T-628). The stock handler
 * rebuilds the whole document on every request — some 160 ms of blocked
 * event loop for an unauthenticated GET, multiplied by however many times a
 * batch envelope names it. Generation waits for the first request rather
 * than running here because routes registered after this call still belong
 * in the document; nothing registers once the app is serving, so the first
 * build is final.
 */
export function serveOpenAPIDocument(
  // biome-ignore lint/suspicious/noExplicitAny: accepts any env / basePath
  api: OpenAPIHono<any, any, any>,
  path: string,
  config: DocumentConfig,
): void {
  let document: ReturnType<typeof api.getOpenAPI31Document> | undefined;
  api.get(path, (c) => {
    document ??= api.getOpenAPI31Document(config);
    return c.json(document);
  });
}
