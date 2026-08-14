import { QueryClient } from "@tanstack/react-query";
import { DEFAULT_REFERENCE_CONFIG } from "@todou/shared";
import { describe, expect, it, vi } from "vitest";
import { referenceConfigQuery } from "../src/api/references.ts";
// Never from ./setup.ts — importing that would install the guard, and these
// tests would pass whether or not vitest is configured to load it.
import { OFFLINE_HEADER } from "./offline-fetch.ts";

const stubbed = () =>
  new Response(JSON.stringify({ stubbed: true }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

describe("test-suite network guard", () => {
  it("answers an unstubbed request instead of opening a socket", async () => {
    // Relative, i.e. resolved against happy-dom's http://localhost:3000.
    const res = await fetch("/api/projects/p/references/config");
    expect(res.headers.get(OFFLINE_HEADER)).toBe("1");
    expect(res.status).toBe(404);
  });

  it("intercepts absolute URLs to any host, not just the document origin", async () => {
    const res = await fetch("http://todou.example/api/me");
    expect(res.headers.get(OFFLINE_HEADER)).toBe("1");
  });

  // Deliberately leaves the stub installed — the next case is what proves
  // setup.ts takes it back out again.
  it("lets a suite's own stub take over", async () => {
    vi.stubGlobal("fetch", (async () => stubbed()) as typeof fetch);
    const res = await fetch("/api/me");
    expect(res.headers.get(OFFLINE_HEADER)).toBeNull();
    expect(await res.json()).toEqual({ stubbed: true });
  });

  it("comes back for the next test when a stub is left behind", async () => {
    const res = await fetch("/api/me");
    expect(res.headers.get(OFFLINE_HEADER)).toBe("1");
  });

  // The suites that stub `fetch` unstub it again in afterEach. That restores
  // whatever was installed when they first stubbed — so the guard has to be
  // what they find, or the rest of the file goes back online.
  it("is what unstubAllGlobals restores, not happy-dom's real fetch", async () => {
    vi.stubGlobal("fetch", (async () => stubbed()) as typeof fetch);
    vi.unstubAllGlobals();
    const res = await fetch("/api/me");
    expect(res.headers.get(OFFLINE_HEADER)).toBe("1");
  });

  // Component tests render markdown views that pull the project's reference
  // config. They passed before this guard only because a stray 404 came back
  // from :3000; the guard has to reproduce that degradation exactly.
  it("degrades reference config to the built-in default", async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    await expect(client.fetchQuery(referenceConfigQuery("p"))).resolves.toEqual(
      DEFAULT_REFERENCE_CONFIG,
    );
  });
});
