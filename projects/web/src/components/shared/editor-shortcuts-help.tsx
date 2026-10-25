import { KeyboardIcon } from "lucide-react";

import { Button } from "@/components/ui/button.tsx";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover.tsx";
import { type ModKeyLabels, modKeyLabels } from "@/lib/platform.ts";

type Key = keyof ModKeyLabels | "V" | ".";

const SHORTCUTS: { keys: Key[]; text: string }[] = [
  { keys: ["mod", "V"], text: "Paste — formatting becomes Markdown" },
  { keys: ["mod", "shift", "V"], text: "Paste as plain text" },
  { keys: ["mod", "alt", "V"], text: "Paste as quote" },
  { keys: ["mod", "alt", "shift", "V"], text: "Paste plain text as quote" },
  { keys: ["mod", "."], text: "Paste options, right after pasting" },
  { keys: ["mod", "shift", "."], text: "Quote or unquote selected lines" },
];

/**
 * The editor's paste and quote keys, none of which leave a trace on screen
 * until they are used.
 */
export function EditorShortcutsHelp() {
  const labels = modKeyLabels();
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="Keyboard shortcuts"
          title="Keyboard shortcuts"
        >
          <KeyboardIcon className="size-3.5" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-2">
        <table className="text-xs">
          <tbody>
            {SHORTCUTS.map(({ keys, text }) => (
              <tr key={text}>
                <td className="py-1 pr-4 whitespace-nowrap">
                  <span className="inline-flex gap-1">
                    {keys.map((key) => (
                      <kbd
                        key={key}
                        className="rounded border bg-muted px-1.5 font-mono text-[0.7rem] text-muted-foreground"
                      >
                        {key === "V" || key === "." ? key : labels[key]}
                      </kbd>
                    ))}
                  </span>
                </td>
                <td className="py-1">{text}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </PopoverContent>
    </Popover>
  );
}
