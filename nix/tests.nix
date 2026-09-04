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
    };

  cli = { todou-cli, todou-cli-cjs, denoEnv }:
    let
      bundle = "${todou-cli-cjs}/lib/todou/todou.cjs";
      todou = "${todou-cli}/bin/todou";

      declaredNames = lib.concatStringsSep " "
        (denoEnv.unset ++ lib.attrNames denoEnv.set ++ denoEnv.pass);
      unsetNames = lib.concatStringsSep " " denoEnv.unset;
      passNames = lib.concatStringsSep " "
        (denoEnv.pass ++ denoEnv.passUndocumented);
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

      # DENO_COVERAGE_DIR and DENO_EMIT_CACHE_MODE are the two cleared variables
      # whose effect shows without network access: the first changes the exit
      # code, the second adds a line on stderr.
      #
      # The same variables are then applied to a bare `deno run` of the same
      # bundle, which has to fail. Without that half, a wrapper that unset
      # nothing would still pass the first half.
      blocked-vars = runCommand "todou-cli-test-blocked-vars" { } ''
        export DENO_COVERAGE_DIR=/proc/nonexistent/cov
        export DENO_EMIT_CACHE_MODE=nonsense

        export HOME="$PWD/wrapped" && mkdir -p "$HOME"
        set +e
        ${todou} --version > wrapped.out 2> wrapped.err
        rc=$?
        set -e
        if [ "$rc" -ne 0 ]; then
          echo "wrapper exited $rc; stderr:" >&2
          cat wrapped.err >&2
          exit 1
        fi
        got=$(cat wrapped.out)
        if [ "$got" != "${version}" ]; then
          echo "wrapper printed '$got', want '${version}'" >&2
          exit 1
        fi
        if [ -s wrapped.err ]; then
          echo "wrapper wrote to stderr:" >&2
          cat wrapped.err >&2
          exit 1
        fi

        export HOME="$PWD/bare" && mkdir -p "$HOME"
        set +e
        ${common.deno}/bin/deno run --allow-all ${bundle} --version \
          > bare.out 2> bare.err
        rc=$?
        set -e
        if [ "$rc" -eq 0 ]; then
          echo "bare deno run exited 0 under the same variables, so the" >&2
          echo "wrapper's --unset flags prove nothing" >&2
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

      # Guards the table in nix/deno-env.nix against the generated wrapper
      # drifting away from it, and pins the pass list: DENO_V8_FLAGS,
      # SSLKEYLOGFILE and DENO_USE_CGROUPS turning up in --unset fails here.
      wrapper-matches-table = runCommand "todou-cli-test-wrapper-matches-table" { } ''
        sed -nE 's/^[[:space:]]*unset[[:space:]]+([A-Za-z_][A-Za-z0-9_]*)[[:space:]]*$/\1/p' \
          ${todou} | sort -u > wrapper-unset.txt
        if [ ! -s wrapper-unset.txt ]; then
          echo "no 'unset NAME' lines found in the wrapper; the extraction" >&2
          echo "below would compare against an empty set:" >&2
          cat ${todou} >&2
          exit 1
        fi

        for name in ${unsetNames}; do
          if ! grep -qxF "$name" wrapper-unset.txt; then
            echo "$name is in deno-env.nix's unset list but the wrapper does not unset it" >&2
            exit 1
          fi
        done

        for name in ${passNames}; do
          if grep -qxF "$name" wrapper-unset.txt; then
            echo "$name is meant to pass through but the wrapper unsets it" >&2
            exit 1
          fi
        done

        touch $out
      '';

      # A hand-written table fails by deno adding a variable nobody classifies,
      # which would then reach the runtime unnoticed.
      env-table-covers-deno-help = runCommand "todou-cli-test-env-drift" { } ''
        export HOME="$PWD/home" && mkdir -p "$HOME"
        ${common.deno}/bin/deno help \
          | sed -n '/^Environment variables:/,$p' \
          | grep -oE '^  [A-Z][A-Z0-9_]+' \
          | tr -d ' ' | sort -u > documented.txt

        # Without these two assertions a `deno help` reformat would yield an
        # empty set and the comparison below would pass on nothing.
        count=$(wc -l < documented.txt)
        if [ "$count" -lt 25 ]; then
          echo "only $count names extracted from 'deno help'; the extraction broke" >&2
          exit 1
        fi
        if ! grep -qxF DENO_V8_FLAGS documented.txt; then
          echo "DENO_V8_FLAGS missing from the extracted names; the extraction broke" >&2
          exit 1
        fi

        printf '%s\n' ${declaredNames} | sort -u > declared.txt

        if ! diff -u declared.txt documented.txt > drift.txt; then
          echo "nix/deno-env.nix and 'deno help' disagree" >&2
          echo "(- only in deno-env.nix, + only in deno help):" >&2
          cat drift.txt >&2
          exit 1
        fi
        touch $out
      '';
    };
}
