# The esbuild bundle on its own, for callers who bring their own node-compatible
# runtime. nix/todou-cli.nix wraps this same file with deno.
{ lib
, stdenvNoCC
, runCommand
, fetchPnpmDeps
, pnpmConfigHook
, common
, version
, src
}:

stdenvNoCC.mkDerivation (finalAttrs: {
  pname = "todou-cli-cjs";
  inherit version src;

  # pnpmConfigHook reads pnpmInstallFlags as an array.
  __structuredAttrs = true;

  # Together these are what build-cli.sh runs as
  # `pnpm install --prod --frozen-lockfile --filter '@todou/cli...'`. They are
  # declared here and inherited into the fetcher below so that the fetch and the
  # offline install cannot be handed different arguments.
  pnpmWorkspaces = [ "@todou/cli..." ];
  pnpmInstallFlags = [ "--prod" ];

  pnpmDeps = fetchPnpmDeps {
    pname = "todou-cli-cjs";
    inherit (finalAttrs) src pnpmWorkspaces pnpmInstallFlags;
    pnpm = common.pnpm;
    # Highest version currently supported; 1 and 2 are slated for removal in
    # 26.11.
    fetcherVersion = 4;
    hash = "sha256-mQEXyGotP5/S2fRjdU3DCRdpVXMjSvZ+ITxRfqmbha8=";
  };

  # nixpkgs' esbuild is 0.27.2 against the lock file's 0.28.2. The two bundles
  # differ by 52 bytes — 0.28 wraps its own __commonJS helper in a try/catch —
  # and both run under node and deno. Taking the lock file's copy instead would
  # grow the pnpm fixed-output derivation from 29 MB to 1.6 GB, because
  # fetchPnpmDeps installs with --force and would pull esbuild's and biome's
  # binaries for every platform. Release artifacts are unaffected: build-cli.sh
  # still bundles with the lock file's esbuild.
  nativeBuildInputs = [ common.pnpm pnpmConfigHook common.esbuild ];

  # Invoked through bash rather than its shebang: the build sandbox has /bin/sh
  # but no /usr/bin/env.
  buildPhase = ''
    runHook preBuild
    bash scripts/bundle-cli.sh . "${version}" todou.cjs
    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall
    install -Dm755 todou.cjs "$out/lib/todou/todou.cjs"
    runHook postInstall
  '';

  # patchShebangsAuto walks every executable file under $out, not just bin/, and
  # rewrites `#!/usr/bin/env node` into a store path as soon as node is
  # reachable from buildInputs. That would pull nixpkgs' node into the closure
  # of the package whose entire point is that the caller supplies the runtime.
  dontPatchShebangs = true;

  passthru.tests =
    (import ./tests.nix { inherit lib runCommand common version; }).cjs
      { todou-cli-cjs = finalAttrs.finalPackage; };

  meta = {
    description =
      "todou CLI as a single CommonJS bundle at $out/lib/todou/todou.cjs; "
      + "the caller supplies a node-compatible runtime, and this path's "
      + "behaviour is not something the project promises";
    homepage = "https://github.com/orzFly/todou";
    license = lib.licenses.bsd3;
    platforms = lib.platforms.all;
  };
})
