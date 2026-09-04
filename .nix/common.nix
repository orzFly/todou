# The toolchain versions, imported by both flakes so that the devshell and the
# package build cannot end up on different ones.
#
# This lives under `.nix/` rather than `nix/` because a nested flake only sees
# its own directory: `.nix/flake.nix` cannot read `../nix/`.
{ pkgs }:
{
  deno = pkgs.deno;
  nodejs = pkgs.nodejs_24;

  # `pkgs.pnpm` is an alias. package.json's devEngines.packageManager asks for
  # ^11.20.0, so the day nixpkgs points that alias at pnpm 12 the build would
  # silently change package managers.
  pnpm = pkgs.pnpm_11;

  # Only the package build uses this; the devshell deliberately leaves esbuild
  # off PATH so that a hand-run scripts/bundle-cli.sh says `command not found`
  # instead of quietly bundling with a different version than `pnpm exec` picks.
  esbuild = pkgs.esbuild;
}
