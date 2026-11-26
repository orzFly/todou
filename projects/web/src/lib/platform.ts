import { isApplePlatform } from "@orz/ui/lib/platform";

export type ModKeyLabels = { mod: string; alt: string; shift: string };

export function modKeyLabels(): ModKeyLabels {
  return isApplePlatform()
    ? { mod: "⌘", alt: "⌥", shift: "⇧" }
    : { mod: "Ctrl", alt: "Alt", shift: "Shift" };
}
