import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../src/components/ui/dropdown-menu.tsx";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "../src/components/ui/popover.tsx";

async function openMenu() {
  render(
    <DropdownMenu>
      <DropdownMenuTrigger>Status</DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuItem>Backlog</DropdownMenuItem>
        <DropdownMenuItem>In Progress</DropdownMenuItem>
        <DropdownMenuItem>Shipped</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>,
  );
  const trigger = screen.getByRole("button", { name: "Status" });
  fireEvent.pointerDown(trigger, { button: 0, pointerType: "mouse" });
  await waitFor(() => expect(screen.getByRole("menu")).toBeTruthy());
  return trigger;
}

async function openPopover() {
  render(
    <Popover>
      <PopoverTrigger>Edit labels</PopoverTrigger>
      <PopoverContent>
        <button type="button">bug</button>
      </PopoverContent>
    </Popover>,
  );
  const trigger = screen.getByRole("button", { name: "Edit labels" });
  fireEvent.click(trigger);
  await waitFor(() => expect(screen.getByRole("dialog")).toBeTruthy());
  return trigger;
}

/** Record every focus() the restore makes, arguments included. */
function watchFocus(element: HTMLElement) {
  const calls: (FocusOptions | undefined)[] = [];
  const original = element.focus.bind(element);
  element.focus = (options?: FocusOptions) => {
    calls.push(options);
    original(options);
  };
  return calls;
}

describe.each([
  ["dropdown menu", openMenu],
  ["popover", openPopover],
])("%s focus restore", (_name, open) => {
  it("hands focus back to the trigger on close", async () => {
    const trigger = await open();

    fireEvent.keyDown(document, { key: "Escape" });

    // Compare the element itself: `document.activeElement?.something` passes
    // vacuously while focus is nowhere, which is the failure being guarded —
    // taking the restore over from Radix is what could drop it on the floor.
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it("restores without letting the browser scroll the trigger into view", async () => {
    const trigger = await open();
    const calls = watchFocus(trigger);

    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(document.activeElement).toBe(trigger));

    // happy-dom has no layout, so the scroll itself is unobservable here and
    // only the argument that suppresses it can be asserted. Radix's own
    // restore passes none, which is what sends the page travelling; the
    // viewport-level version of this lives in
    // scripts/overlay-viewport-smoke.mjs.
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((options) => options?.preventScroll === true)).toBe(
      true,
    );
  });
});
