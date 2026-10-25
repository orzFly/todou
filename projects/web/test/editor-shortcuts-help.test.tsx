import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { EditorShortcutsHelp } from "../src/components/shared/editor-shortcuts-help.tsx";

afterEach(() => {
  vi.unstubAllGlobals();
});

function open(platform: string, uaDataPlatform?: string): HTMLElement {
  vi.stubGlobal("navigator", {
    ...navigator,
    platform,
    userAgent: "",
    ...(uaDataPlatform === undefined
      ? {}
      : { userAgentData: { platform: uaDataPlatform } }),
  });
  render(<EditorShortcutsHelp />);
  act(() => {
    screen.getByRole("button", { name: "Keyboard shortcuts" }).click();
  });
  const table = document.querySelector<HTMLElement>(
    '[data-slot="popover-content"] table',
  );
  if (table === null) throw new Error("shortcuts did not open");
  return table;
}

describe("EditorShortcutsHelp", () => {
  it("lists the six paste and quote keys", () => {
    const table = open("Linux x86_64");
    const rows = [...table.querySelectorAll("tr")].map((row) =>
      [...row.querySelectorAll("td")].map((cell) =>
        [...cell.querySelectorAll("kbd")].length > 0
          ? [...cell.querySelectorAll("kbd")]
              .map((k) => k.textContent)
              .join(" ")
          : cell.textContent,
      ),
    );
    expect(rows).toEqual([
      ["Ctrl V", "Paste — formatting becomes Markdown"],
      ["Ctrl Shift V", "Paste as plain text"],
      ["Ctrl Alt V", "Paste as quote"],
      ["Ctrl Alt Shift V", "Paste plain text as quote"],
      ["Ctrl .", "Paste options, right after pasting"],
      ["Ctrl Shift .", "Quote or unquote selected lines"],
    ]);
  });

  it("shows Apple's symbols on a Mac", () => {
    const table = open("MacIntel");
    expect(table.querySelector("tr")?.textContent).toContain("⌘");
    expect(table.textContent).not.toContain("Ctrl");
    expect(table.textContent).toContain("⌥");
    expect(table.textContent).toContain("⇧");
  });

  it("believes Chromium's userAgentData over navigator.platform", () => {
    const table = open("Linux x86_64", "macOS");
    expect(table.querySelector("tr")?.textContent).toContain("⌘");
  });
});
