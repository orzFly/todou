# Upstream's release binary rather than nixpkgs' deno, which nixos-26.05 holds
# at 2.8.x. Building a newer one from source needs a matching rusty_v8 archive
# and a cargo hash per bump, and costs a V8-sized build on every machine the
# binary cache has not seen it on.
#
# Bumping: change `version`, then fill in the four hashes from
# `nix store prefetch-file` on each URL below.
{ lib, stdenv, fetchurl, unzip, autoPatchelfHook }:

let
  version = "2.9.8";

  targets = {
    x86_64-linux = {
      triple = "x86_64-unknown-linux-gnu";
      hash = "sha256-6JCXW8JUmAe7zAtYT/r9pyzHyTNJ3ZnIBIPdeE9sRgk=";
    };
    aarch64-linux = {
      triple = "aarch64-unknown-linux-gnu";
      hash = "sha256-1JWWwguXiM+PXY3fZEED1L3lbtI5dT8L25K6k2HVGQU=";
    };
    x86_64-darwin = {
      triple = "x86_64-apple-darwin";
      hash = "sha256-Sy9e3SY5t0cPA0I4syHXAC2N+0cm2FWPUsF6+sNw6yw=";
    };
    aarch64-darwin = {
      triple = "aarch64-apple-darwin";
      hash = "sha256-nwv2YDk9our/BEzcdETLCMc/I1hJth0iTYJaGUznyY4=";
    };
  };

  target = targets.${stdenv.hostPlatform.system}
    or (throw "deno ${version}: no upstream binary for ${stdenv.hostPlatform.system}");
in
stdenv.mkDerivation {
  pname = "deno";
  inherit version;

  src = fetchurl {
    url = "https://github.com/denoland/deno/releases/download/v${version}/deno-${target.triple}.zip";
    inherit (target) hash;
  };

  sourceRoot = ".";
  nativeBuildInputs = [ unzip ] ++ lib.optionals stdenv.hostPlatform.isLinux [ autoPatchelfHook ];
  buildInputs = lib.optionals stdenv.hostPlatform.isLinux [ stdenv.cc.cc.lib ];

  dontConfigure = true;
  dontBuild = true;

  installPhase = ''
    runHook preInstall
    install -Dm755 deno "$out/bin/deno"
    runHook postInstall
  '';

  meta = {
    homepage = "https://deno.com";
    license = lib.licenses.mit;
    mainProgram = "deno";
    platforms = lib.attrNames targets;
    sourceProvenance = [ lib.sourceTypes.binaryNativeCode ];
  };
}
