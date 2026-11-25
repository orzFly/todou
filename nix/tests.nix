# Acceptance tests for both packages, mirrored into the root flake's `checks`.
# None of them needs network access, which the build sandbox does not have.
{ lib, runCommand, common, version }:

{
  cjs = { todou-cli-cjs }:
    let
      bundle = "${todou-cli-cjs}/lib/todou/todou.cjs";
    in
    {
      version-string = runCommand "todou-cli-cjs-test-version" { } ''
        export HOME="$PWD/home" && mkdir -p "$HOME"
        got=$(${common.nodejs}/bin/node ${bundle} --version)
        if [ "$got" != "${version}" ]; then
          echo "todou.cjs printed '$got', want '${version}'" >&2
          exit 1
        fi
        touch $out
      '';

      # The version test above invokes `node <file>`, which never consults the
      # shebang, so only this one notices dontPatchShebangs going missing.
      shebang-intact = runCommand "todou-cli-cjs-test-shebang" { } ''
        got=$(head -1 ${bundle})
        if [ "$got" != '#!/usr/bin/env node' ]; then
          echo "first line is '$got', want '#!/usr/bin/env node'" >&2
          exit 1
        fi
        touch $out
      '';

      # The embedded mermaid only works when four build steps line up, and
      # only running the bundle shows that they do (T-769).
      mermaid-smoke = runCommand "todou-cli-cjs-test-mermaid" { } ''
        export HOME="$PWD/home" && mkdir -p "$HOME"
        ${common.nodejs}/bin/node ${../scripts/mermaid-bundle-smoke.mjs} ${bundle}
        touch $out
      '';
    };

  cli = { todou-cli }:
    let
      todou = "${todou-cli}/bin/todou";
    in
    {
      version-string = runCommand "todou-cli-test-version" { } ''
        export HOME="$PWD/home" && mkdir -p "$HOME"
        got=$(${todou} --version)
        if [ "$got" != "${version}" ]; then
          echo "todou printed '$got', want '${version}'" >&2
          exit 1
        fi
        touch $out
      '';

      # HOME is a fresh directory rather than unset: with no HOME, homedir()
      # falls back to the real home from /etc/passwd and reads real config.
      # Only the `server:` line is asserted, because `config show` also prints a
      # git remote whose value differs between the sandbox and a checkout.
      passed-vars = runCommand "todou-cli-test-passed-vars" { } ''
        export HOME="$PWD/home" && mkdir -p "$HOME"
        export TODOU_SERVER=https://example.invalid
        ${todou} config show > shown.txt
        if ! grep -qE '^ *server: https://example\.invalid \(TODOU_SERVER\)$' shown.txt; then
          echo "config show did not report TODOU_SERVER as the source:" >&2
          cat shown.txt >&2
          exit 1
        fi
        touch $out
      '';

      # The executable carries mermaid as bytecode, through a loader of its
      # own; only running it shows that loader and the payload agree.
      mermaid-smoke = runCommand "todou-cli-test-mermaid" { } ''
        export HOME="$PWD/home" && mkdir -p "$HOME"
        ${common.nodejs}/bin/node ${../scripts/mermaid-bundle-smoke.mjs} ${todou}
        touch $out
      '';

      # The executable is txiki.js running the CLI's bytecode, and an
      # unpatched txiki creates ~/.tjs on every start (T-792).
      no-tjs-home = runCommand "todou-cli-test-no-tjs-home" { } ''
        export HOME="$PWD/home" && mkdir -p "$HOME"
        ${todou} --version > /dev/null
        ${todou} config show > /dev/null
        if [ -e "$HOME/.tjs" ]; then
          echo "todou created $HOME/.tjs" >&2
          exit 1
        fi
        touch $out
      '';
    };
}
