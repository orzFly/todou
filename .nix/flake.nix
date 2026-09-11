{
  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-26.05";
    flake-utils.url = "github:numtide/flake-utils";
    devshell.url = "github:numtide/devshell";
    devshell.inputs.nixpkgs.follows = "nixpkgs";
    fix-hash = {
      # v0.4.0. Pinned by commit rather than tag; record the new tag next to the
      # commit here when bumping.
      url = "github:spotdemo4/nix-fix-hash/305bcbfb565d4aa016f7aef078a1222bdd6d919d";
      # `follows` costs a local build on first entry — the binary cache has no
      # result for this combination — and buys a lock file with one nixpkgs in
      # it, which is the whole reason the two flakes are split.
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs = inputs@{ self, ... }:
    inputs.flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = import inputs.nixpkgs {
          inherit system;
          overlays = [ inputs.devshell.overlays.default ];
        };
        common = import ./common.nix { inherit pkgs; };
      in
      {
        devShell = pkgs.devshell.mkShell {
          imports = [{
            name = "devshell";
            packages = [
              common.deno
              common.nodejs
              common.pnpm
              inputs.fix-hash.packages."${system}".default
              pkgs.nixpkgs-fmt
              pkgs.typescript-language-server
            ];
            commands = [
              {
                name = "todou";
                # `$PRJ_ROOT` is set on devshell entry and inherited from
                # there, so anything that did not come through the shell does
                # not have it — an agent's eval sandbox, a cron unit, any bare
                # subprocess. Under `set -u` that was a hard failure rather
                # than a degradation, which is what stopped todou running
                # inside omp's eval runtimes at all (T-314).
                #
                # The checkout is found from the working directory instead,
                # walking up for the marker that only its root carries. That
                # needs nothing on PATH, which is the point: the environments
                # this has to work in are missing more than one variable.
                command = ''
                  root="''${PRJ_ROOT:-}"
                  if [ -z "$root" ]; then
                    root=$PWD
                    while [ ! -e "$root/pnpm-workspace.yaml" ]; do
                      if [ "$root" = "/" ]; then
                        echo "todou: run this inside the checkout, or set PRJ_ROOT" >&2
                        exit 1
                      fi
                      root=$(dirname "$root")
                    done
                  fi
                  exec node "$root/projects/cli/src/index.ts" "$@"
                '';
              }
            ];
          }];
        };
      });
}
