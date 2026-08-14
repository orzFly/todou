// Module indirection over the compile-time globals so components stay
// mockable (vi.mock) and never depend on how `define` behaves under vitest.
export const WEB_VERSION = __TODOU_VERSION__;
export const REPO_URL = __TODOU_REPO_URL__;
