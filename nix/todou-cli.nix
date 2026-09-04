# The supported install: deno interpreting the bundle, with the environment
# variables from nix/deno-env.nix cleared.
{ lib
, runCommand
, makeWrapper
, common
, version
, todou-cli-cjs
}:

let
  denoEnv = import ./deno-env.nix;
  tests = import ./tests.nix { inherit lib runCommand common version; };

  unsetFlags = lib.concatMapStringsSep " " (name: "--unset ${name}") denoEnv.unset;
  setFlags = lib.concatStringsSep " "
    (lib.mapAttrsToList (name: value: "--set ${name} ${lib.escapeShellArg value}")
      denoEnv.set);

  self = runCommand "todou-cli-${version}"
    {
      nativeBuildInputs = [ makeWrapper ];

      passthru.tests = tests.cli {
        inherit denoEnv todou-cli-cjs;
        todou-cli = self;
      };

      meta = {
        description = "todou CLI, run by deno";
        homepage = "https://github.com/orzFly/todou";
        license = lib.licenses.bsd3;
        mainProgram = "todou";
        platforms = lib.platforms.all;
      };
    }
    # --allow-all matches the permissions build-cli.sh gives `deno compile`: the
    # CLI reads and writes config files, spawns subprocesses and opens network
    # connections. The usage text hardcodes the program name rather than reading
    # argv[0], so the wrapper has no argv0 to fix up.
    ''
      makeWrapper ${common.deno}/bin/deno "$out/bin/todou" \
        --add-flags "run --allow-all ${todou-cli-cjs}/lib/todou/todou.cjs" \
        ${setFlags} \
        ${unsetFlags}
    '';
in
self
