{
  description = "todou — a to-do list app";

  # No version of its own: `.nix/flake.lock` holds the single real pin and this
  # flake follows it, so the devshell and the package build share one nixpkgs.
  inputs = {
    dev.url = "path:./.nix";
    flake-parts.url = "github:hercules-ci/flake-parts";
    nixpkgs.follows = "dev/nixpkgs";
  };

  outputs = inputs@{ flake-parts, ... }:
    flake-parts.lib.mkFlake { inherit inputs; } {
      systems = [
        "x86_64-linux"
        "aarch64-linux"
        "x86_64-darwin"
        "aarch64-darwin"
      ];

      perSystem = { config, pkgs, ... }:
        let
          common = import ./.nix/common.nix { inherit pkgs; };

          # `git describe` needs tags, which a flake does not carry, so
          # package.json's version is the base. The result — 0.3.1-g76a0a88 —
          # is deliberately distinguishable from build-cli.sh's
          # v0.3.1-65-g76a0a88, so the string says which build produced it.
          version = "${(pkgs.lib.importJSON ./package.json).version}-g${
            inputs.self.shortRev or inputs.self.dirtyShortRev or "unknown"
          }";

          # projects/server and projects/web are left out: the CLI's only
          # non-relative imports are @todou/shared and its own runtime deps, and
          # pnpm accepts the lock file on a tree holding a subset of the
          # workspace. tsconfig.base.json stays because projects/cli extends it.
          #
          # Both this and `version` have to be computed here rather than in
          # nix/todou-cli-cjs.nix: nix resolves relative paths against the file
          # they appear in, so `./package.json` written under nix/ would point at
          # a nix/package.json that does not exist.
          src = pkgs.lib.fileset.toSource {
            root = ./.;
            fileset = pkgs.lib.fileset.unions [
              ./package.json
              ./pnpm-lock.yaml
              ./pnpm-workspace.yaml
              ./tsconfig.base.json
              ./projects/cli
              ./projects/shared
              ./scripts/bundle-cli.sh
            ];
          };
        in
        {
          packages.todou-cli-cjs = pkgs.callPackage ./nix/todou-cli-cjs.nix {
            inherit common version src;
          };

          packages.todou-cli = pkgs.callPackage ./nix/todou-cli.nix {
            inherit common version;
            todou-cli-cjs = config.packages.todou-cli-cjs;
          };

          packages.default = config.packages.todou-cli;

          checks = pkgs.lib.mapAttrs' (name: pkgs.lib.nameValuePair "cjs-${name}")
            config.packages.todou-cli-cjs.passthru.tests
          // pkgs.lib.mapAttrs' (name: pkgs.lib.nameValuePair "cli-${name}")
            config.packages.todou-cli.passthru.tests;
        };
    };
}
