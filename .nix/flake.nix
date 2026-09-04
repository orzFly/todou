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
                command = ''
                  exec node "$PRJ_ROOT/projects/cli/src/index.ts" "$@"
                '';
              }
            ];
          }];
        };
      });
}
