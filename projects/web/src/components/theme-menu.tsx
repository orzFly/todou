import { CheckIcon, MonitorIcon, MoonIcon, SunIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { setThemePref, THEMES, themeKind, useThemePref } from "@/lib/theme.ts";

function Swatch({ surface, accent }: { surface: string; accent: string }) {
  return (
    <span
      aria-hidden
      className="inline-flex size-4 shrink-0 overflow-hidden rounded-full border"
    >
      <span className="w-1/2" style={{ backgroundColor: surface }} />
      <span className="w-1/2" style={{ backgroundColor: accent }} />
    </span>
  );
}

/** Theme picker in the floating header (T-36): system + every named theme. */
export function ThemeMenu() {
  const pref = useThemePref();
  const TriggerIcon =
    pref === "system"
      ? MonitorIcon
      : themeKind(pref) === "dark"
        ? MoonIcon
        : SunIcon;

  const group = (kind: "light" | "dark") =>
    THEMES.filter((t) => t.kind === kind).map((t) => (
      <DropdownMenuItem key={t.value} onSelect={() => setThemePref(t.value)}>
        <Swatch surface={t.surface} accent={t.accent} />
        <span className="flex-1">{t.label}</span>
        {pref === t.value && <CheckIcon className="size-4" />}
      </DropdownMenuItem>
    ));

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" aria-label="Theme">
          <TriggerIcon className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="max-h-[min(70vh,32rem)] w-52 overflow-y-auto"
      >
        <DropdownMenuItem onSelect={() => setThemePref("system")}>
          <MonitorIcon className="size-4 text-muted-foreground" />
          <span className="flex-1">System</span>
          {pref === "system" && <CheckIcon className="size-4" />}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuLabel className="text-xs text-muted-foreground">
          Light
        </DropdownMenuLabel>
        {group("light")}
        <DropdownMenuSeparator />
        <DropdownMenuLabel className="text-xs text-muted-foreground">
          Dark
        </DropdownMenuLabel>
        {group("dark")}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
