/**
 * The offline `fetch` the suite runs on, kept apart from the setup file that
 * installs it: importing this module must not install anything, or a test
 * asserting the guard is active would satisfy itself by importing it.
 */

/**
 * Marks a response as synthesized here. Tests assert on it to tell "the guard
 * answered" apart from "something was listening" — a real server on the
 * document origin returns a bare 404 too.
 */
export const OFFLINE_HEADER = "x-todou-test-offline";

/**
 * happy-dom resolves the app's relative `/api/...` URLs against its default
 * document origin, `http://localhost:3000`, so every request a test does not
 * stub opens a real socket to whatever happens to be listening on that port.
 * Two things follow, and the second one is why this exists:
 *
 * 1. Results become a function of the developer's machine — an unrelated dev
 *    server on :3000 gets to decide what the app under test receives.
 * 2. A request still in flight when vitest tears the window down is rejected
 *    with `AbortError` by `DetachedWindowAPI.abort`. By then the component
 *    that issued it is unmounted and nothing is left to catch the rejection,
 *    so vitest counts it as a run error and exits 1 with every test green
 *    (T-126).
 *
 * So the suite is offline by default: answer the 404 envelope the app already
 * degrades on (missing endpoint → built-in defaults) without touching the
 * network. This only decides what an *unstubbed* request does — tests that
 * care about a response still stub `fetch` themselves.
 */
export const offlineFetch: typeof fetch = async (input) => {
  const url =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : input.url;
  return new Response(
    JSON.stringify({
      error: { code: "not_found", message: `no fetch stub for ${url}` },
    }),
    {
      status: 404,
      headers: { "content-type": "application/json", [OFFLINE_HEADER]: "1" },
    },
  );
};
