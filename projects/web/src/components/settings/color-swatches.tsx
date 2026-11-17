import { CheckIcon } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PRESET_COLORS } from "@/lib/labels.ts";

/** Lenient hand-typed hex → canonical #rrggbb, or null when unparseable. */
export function normalizeHexColor(input: string): string | null {
  const raw = input.trim().replace(/^#/, "").toLowerCase();
  if (/^[0-9a-f]{6}$/.test(raw)) return `#${raw}`;
  if (/^[0-9a-f]{3}$/.test(raw)) {
    return `#${raw.replaceAll(/./g, (c) => c + c)}`;
  }
  return null;
}

/**
 * The presets plus a free hex. No `<form>` of its own: the label and status
 * editors hold it inside theirs, so Enter in the hex field is caught here
 * instead of submitting the editor.
 */
export function ColorSwatches({
  name,
  color,
  onPick,
}: {
  name: string;
  color: string;
  onPick: (color: string) => void;
}) {
  const [hex, setHex] = useState(color);
  const normalized = normalizeHexColor(hex);
  // A preset click moves the colour under the field; keep showing it.
  const [shown, setShown] = useState(color);
  if (shown !== color) {
    setShown(color);
    setHex(color);
  }

  return (
    <div>
      <div className="grid w-fit grid-cols-6 gap-2 sm:gap-1.5">
        {PRESET_COLORS.map((preset) => (
          <button
            key={preset}
            type="button"
            aria-label={`set ${name} color ${preset}`}
            aria-pressed={preset === color.toLowerCase()}
            className="flex size-9 cursor-pointer items-center justify-center rounded-full border transition-transform hover:scale-110 sm:size-6"
            style={{ backgroundColor: preset }}
            onClick={() => onPick(preset)}
          >
            {preset === color.toLowerCase() && (
              <CheckIcon className="size-3.5 text-white drop-shadow" />
            )}
          </button>
        ))}
      </div>
      <div className="mt-2 flex items-center gap-1.5">
        <input
          type="color"
          value={normalized ?? color}
          onChange={(e) => setHex(e.target.value)}
          aria-label={`custom color for ${name}`}
          className="size-7 shrink-0 cursor-pointer rounded border"
        />
        <Input
          value={hex}
          onChange={(e) => setHex(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== "Enter") return;
            e.preventDefault();
            if (normalized) onPick(normalized);
          }}
          placeholder="#8b5cf6"
          aria-label={`custom hex for ${name}`}
          // text-base below md: sub-16px inputs trigger iOS focus auto-zoom.
          className="h-7 w-24 font-mono text-base md:text-xs"
        />
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={!normalized}
          onClick={() => normalized && onPick(normalized)}
        >
          Set
        </Button>
      </div>
    </div>
  );
}
