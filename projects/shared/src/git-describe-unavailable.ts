// What `#git-describe` resolves to in the CLI's single-file build, whose
// runtime has no synchronous process API (T-792). Nothing reaches it there:
// a packaged build always carries BUILD_VERSION, which short-circuits the
// resolver before it asks git.
export const gitDescribe = (): string => {
  throw new Error("git describe is not available in this build");
};
