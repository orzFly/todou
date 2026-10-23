# The toolchain versions, imported by both flakes so that the devshell and the
# package build cannot end up on different ones.
#
# This lives under `.nix/` rather than `nix/` because a nested flake only sees
# its own directory: `.nix/flake.nix` cannot read `../nix/`.
{ pkgs }:
{
  deno = pkgs.callPackage ./deno.nix { };
  nodejs = pkgs.nodejs_26;

  # `pkgs.pnpm` is an alias. package.json's devEngines.packageManager asks for
  # ^11.20.0, so the day nixpkgs points that alias at pnpm 12 the build would
  # silently change package managers.
  #
  # pnpm_11 otherwise runs on nixpkgs' default node line rather than `nodejs`
  # above, which leaves a second, older node in the devshell and the package
  # build that a node bump does not move.
  pnpm = pkgs.pnpm_11.override { nodejs-slim = pkgs.nodejs-slim_26; };

  # Only the package build uses this; the devshell deliberately leaves esbuild
  # off PATH so that a hand-run scripts/bundle-cli.sh says `command not found`
  # instead of quietly bundling with a different version than `pnpm exec` picks.
  esbuild = pkgs.esbuild;
}
