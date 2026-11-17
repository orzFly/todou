import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import type { Attachment } from "@todou/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { attachmentsQuery } from "../src/api/attachments.ts";
import { AnnotatedMarkdown } from "../src/components/spec/annotated-markdown.tsx";
import { resetCompareMode } from "../src/lib/compare-mode.ts";
import { changedLineRanges } from "../src/lib/spec-changes.ts";
import { renderWithProviders, testQueryClient } from "./render.tsx";

beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(800);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(600);
});

afterEach(() => {
  vi.restoreAllMocks();
  resetCompareMode();
});

const uploader = {
  id: 1,
  login: "user",
  display_name: "User",
  kind: "human" as const,
  avatar_url: null,
  owner: null,
};
const file = (id: number, filename: string): Attachment => ({
  id,
  filename,
  content_type: "image/png",
  size: 1024 * id,
  url: `/api/projects/p/attachments/${id}/download/${filename}`,
  uploader,
  created_at: "2026-01-01T00:00:00.000Z",
  aliases: [],
});
const FILES = [
  file(1, "login-v1.png"),
  file(2, "login-v2.png"),
  file(3, "menu-v1.png"),
  file(4, "menu-v2.png"),
];
const img = (a: Attachment) => `![${a.filename}](${a.url})`;

async function renderSwaps() {
  const before = `${img(FILES[0])}\n\nBetween.\n\n${img(FILES[2])}\n`;
  const after = `${img(FILES[1])}\n\nBetween.\n\n${img(FILES[3])}\n`;
  const client = testQueryClient();
  client.setQueryData(attachmentsQuery("p", 1).queryKey, FILES);
  const view = renderWithProviders(
    <AnnotatedMarkdown
      slug="p"
      issueNumber={1}
      body={after}
      baselineBody={before}
      annotations={[]}
      compareLabels={{ before: "v1", after: "v2" }}
      changedRanges={changedLineRanges(before, after)}
      onStage={() => {}}
      onEditDraft={() => {}}
      onRemoveDraft={() => {}}
      onResolve={() => {}}
    />,
    client,
  );
  const container = await waitFor(() => {
    const el = view.getByTestId("annotated-markdown");
    if (el.querySelectorAll(".media-compare").length < 2) {
      throw new Error("not rendered yet");
    }
    return el;
  });
  return [...container.querySelectorAll<HTMLElement>(".media-compare")];
}

function load(block: HTMLElement, side: string, width: number, height: number) {
  const image = block.querySelector<HTMLImageElement>(
    `[data-side="${side}"] img`,
  );
  if (image === null) throw new Error(`no ${side} image`);
  Object.defineProperty(image, "naturalWidth", { value: width });
  Object.defineProperty(image, "naturalHeight", { value: height });
  fireEvent.load(image);
}

const openButton = (block: HTMLElement) =>
  within(block).getByRole<HTMLButtonElement>("button", {
    name: "Open in the viewer",
  });

describe("opening a swapped image in the viewer", () => {
  it("waits for both sizes, and stays off when a side fails", async () => {
    const [block] = await renderSwaps();
    expect(openButton(block).disabled).toBe(true);
    load(block, "before", 720, 400);
    expect(openButton(block).disabled).toBe(true);
    load(block, "after", 720, 460);
    expect(openButton(block).disabled).toBe(false);
    const after = block.querySelector('[data-side="after"] img');
    if (after === null) throw new Error("no after image");
    fireEvent.error(after);
    expect(openButton(block).disabled).toBe(true);
  });

  it("pages through the page's comparisons in document order", async () => {
    const blocks = await renderSwaps();
    for (const block of blocks) {
      load(block, "before", 720, 400);
      load(block, "after", 720, 460);
    }
    fireEvent.click(openButton(blocks[1]));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("heading").textContent).toBe(
      "menu-v1.png → menu-v2.png",
    );
    expect(within(dialog).getByText("2 / 2")).toBeTruthy();
    expect(
      within(dialog).getByText("image/png · 3.0 KB → 4.0 KB"),
    ).toBeTruthy();
    fireEvent.click(
      within(dialog).getByRole("button", { name: "next comparison" }),
    );
    expect(within(dialog).getByRole("heading").textContent).toBe(
      "login-v1.png → login-v2.png",
    );
    expect(within(dialog).getByText("1 / 2")).toBeTruthy();
  });

  it("still opens the one image a click lands on", async () => {
    const [block] = await renderSwaps();
    load(block, "before", 720, 400);
    load(block, "after", 720, 460);
    const after = block.querySelector('[data-side="after"] img');
    if (after === null) throw new Error("no after image");
    fireEvent.click(after);
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("heading").textContent).toBe(
      "login-v2.png",
    );
    expect(
      within(dialog).queryByRole("group", { name: "Comparison" }),
    ).toBeNull();
    expect(within(dialog).getByTestId("image-canvas")).toBeTruthy();
  });
});
