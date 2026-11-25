# The supported install: the same single-file executable the releases ship
# (T-792), assembled from the txiki.js runtime for this host and the CLI's
# QuickJS bytecode. The bytecode comes from the tjs bundle that todou-cli-cjs
# builds alongside todou.cjs, so both packages carry one build of the code.
{ lib
, runCommand
, common
, version
, todou-cli-cjs
}:

let
  tests = import ./tests.nix { inherit lib runCommand common version; };

  self = runCommand "todou-cli-${version}"
    {
      passthru.tests = tests.cli { todou-cli = self; };

      meta = {
        description = "todou CLI, a single-file txiki.js executable";
        homepage = "https://github.com/orzFly/todou";
        license = lib.licenses.bsd3;
        mainProgram = "todou";
        platforms = common.txiki.host.meta.platforms;
      };
    }
    # TJS_HOME: `tjs run` is the tjs CLI, which creates its home on start,
    # and the build sandbox's HOME is not writable.
    ''
      export TJS_HOME="$TMPDIR/tjs-home"
      mkdir -p "$out/bin"
      ${common.txiki.host}/bin/tjs run \
        ${todou-cli-cjs.src}/projects/cli/tjs/compile.js \
        ${todou-cli-cjs}/lib/todou/todou.tjs.mjs \
        ${common.txiki.host}/bin/tjs "$out/bin/todou"
    '';
in
self
