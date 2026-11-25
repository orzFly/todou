// What `#git-describe` resolves to in the CLI's single-file build (T-792),
// which has no git checkout of its own to describe. Nothing reaches it there:
// a packaged build always carries BUILD_VERSION, which short-circuits the
// resolver before it asks git.
export const gitDescribe = (): Promise<string> =>
  Promise.reject(new Error("git describe is not available in this build"));
