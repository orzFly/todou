import type { App } from "../src/app.ts";

/**
 * A `fetch` that stands in for a reverse proxy mounting the app under a path
 * prefix, so a real `TodouClient` can be driven against a real app the way a
 * subpath deployment actually reaches it (T-246).
 *
 * Two behaviours are what make this worth having over a plain
 * `t.app.request` shim: the proxy puts the service prefix back onto a
 * response's `Location` before the client ever sees it, and a request that
 * leaves the mount point never reaches the app at all — the proxy answers it
 * with a `no_service` 404 of its own. Together they are the difference
 * between a client that recognises a relocation and one that silently
 * fetches the destination card, which is the bug this exists to pin down.
 */
export function prefixMount(app: App, prefix = ""): typeof fetch {
  const mount = prefix.replace(/\/$/, "");
  const noService = () =>
    Response.json(
      { error: { code: "no_service", message: "no service at this path" } },
      { status: 404 },
    );

  return (async (input: unknown, init?: RequestInit) => {
    const first = typeof input === "string" ? input : (input as Request).url;
    let current = first;
    let redirected = false;
    const method = (init?.method ?? "GET").toUpperCase();

    // Five is what browsers allow; a relocation chain needs one.
    for (let hop = 0; hop <= 5; hop++) {
      const url = new URL(current);
      if (mount !== "" && !url.pathname.startsWith(`${mount}/`))
        return noService();
      const inner = `${url.pathname.slice(mount.length)}${url.search}`;
      const res = await app.request(inner, init);

      const location = res.headers.get("location");
      if (
        method !== "GET" ||
        location === null ||
        (res.status !== 301 && res.status !== 302)
      ) {
        Object.defineProperty(res, "redirected", { value: redirected });
        Object.defineProperty(res, "url", { value: current });
        return res;
      }
      current = new URL(`${mount}${location}`, current).toString();
      redirected = true;
    }
    throw new TypeError("too many redirects");
  }) as typeof fetch;
}
