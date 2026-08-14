// Build-time injection point: artifact builds (scripts/build-cli.sh, the
// Docker image) overwrite this file with a concrete string in their staged
// copy of the tree, so shipped binaries never shell out to git. It must stay
// tracked — the CLI build stages via `git ls-files`, which skips untracked
// files. null means "not a packaged build": resolve the version at runtime.
export const BUILD_VERSION: string | null = null;
