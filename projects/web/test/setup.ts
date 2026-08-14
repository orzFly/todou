import { beforeEach } from "vitest";
import { offlineFetch } from "./offline-fetch.ts";

globalThis.fetch = offlineFetch;

// Reinstalled per test so a stub left behind by one case cannot silently
// serve the next. Setup-file hooks are registered before the test file's
// own, so a suite that stubs `fetch` in its `beforeEach` still wins.
beforeEach(() => {
  globalThis.fetch = offlineFetch;
});
