/**
 * Where CodeMirror's `Mod` means ⌘. `navigator.platform` is deprecated but
 * still the only answer Safari and Firefox give; Chromium's userAgentData
 * comes first where it exists.
 */
export function isApplePlatform(): boolean {
  if (typeof navigator === "undefined") return false;
  const data = (navigator as { userAgentData?: { platform?: string } })
    .userAgentData;
  // userAgentData says "macOS", navigator.platform "MacIntel".
  return /mac|iphone|ipad/i.test(data?.platform ?? navigator.platform ?? "");
}

export type ModKeyLabels = { mod: string; alt: string; shift: string };

export function modKeyLabels(): ModKeyLabels {
  return isApplePlatform()
    ? { mod: "⌘", alt: "⌥", shift: "⇧" }
    : { mod: "Ctrl", alt: "Alt", shift: "Shift" };
}
