{
  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-26.05";
    flake-utils.url = "github:numtide/flake-utils";
    devshell.url = "github:numtide/devshell";
    devshell.inputs.nixpkgs.follows = "nixpkgs";
  };

  outputs = inputs@{ self, ... }:
    inputs.flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = import inputs.nixpkgs {
          inherit system;
          overlays = [ inputs.devshell.overlays.default ];
        };
      in
      {
        devShell = pkgs.devshell.mkShell {
          imports = [{
            name = "devshell";
            packages = [
              pkgs.nixpkgs-fmt
              pkgs.nodejs_24
              pkgs.pnpm
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
