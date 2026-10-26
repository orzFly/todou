import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { DocumentCard } from "../src/components/shared/document-card.tsx";
import { MarkdownView } from "../src/components/shared/markdown-view.tsx";
import {
  LARGE_DIFF_LINES,
  PatchView,
} from "../src/components/shared/patch-view.tsx";
import { renderWithProviders } from "./render.tsx";

type Item =
  | { id: string; type: "file"; file: { name: string; contents: string } }
  | {
      id: string;
      type: "diff";
      fileDiff: { name: string };
      collapsed?: boolean;
    };

// The real parser runs (it is plain string work); only the renderer is a
// stand-in that says what it was handed, header rows included.
vi.mock("@pierre/diffs/react", () => ({
  CodeView: ({
    items,
    className,
    renderCustomHeader,
  }: {
    className?: string;
    items: Item[];
    renderCustomHeader?: (item: Item) => ReactNode;
  }) => (
    <div data-testid="codeview" data-class={className ?? ""}>
      {items.map((item) => (
        <section key={item.id} data-item={item.id}>
          <header>{renderCustomHeader?.(item)}</header>
          {item.type === "diff" ? (
            <div
              data-diff={item.fileDiff.name}
              data-collapsed={item.collapsed ? "" : undefined}
            >
              {item.id}
            </div>
          ) : (
            <pre data-file={item.file.name}>{item.file.contents}</pre>
          )}
        </section>
      ))}
    </div>
  ),
  MultiFileDiff: () => null,
}));

const TWO_FILES = `diff --git a/src/a.ts b/src/a.ts
index 1111111..2222222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,3 +1,3 @@
 one
-two
+deux
 three
diff --git a/src/b.ts b/src/b.ts
new file mode 100644
index 0000000..3333333
--- /dev/null
+++ b/src/b.ts
@@ -0,0 +1,2 @@
+alpha
+beta
`;

const FORMAT_PATCH = `From 0000000000000000000000000000000000000000 Mon Sep 17 00:00:00 2001
From: alice <noreply@example.com>
Subject: [PATCH] fix: say deux

The body of the message.
---
 src/a.ts | 2 +-
 1 file changed, 1 insertion(+), 1 deletion(-)

${TWO_FILES.split("diff --git a/src/b.ts")[0]}--
2.47.0
`;

// The hunk header promises three lines of context and gets one.
const SHORT_HUNK = `--- a.txt
+++ b.txt
@@ -1,3 +1,3 @@
 one
-two
+deux
`;

const diffs = () =>
  [...document.querySelectorAll("[data-diff]")].map((el) =>
    el.getAttribute("data-diff"),
  );

/** The row a DocumentCard draws its filename in. */
const titleBar = (filename: string) => {
  const bar = screen.getByRole("button", { name: filename }).parentElement;
  if (bar === null) throw new Error("no title bar");
  return bar;
};

/** A new file with `lines` added lines. */
const newFile = (name: string, lines: number) => `diff --git a/${name} b/${name}
new file mode 100644
index 0000000..4444444
--- /dev/null
+++ b/${name}
@@ -0,0 +1,${lines} @@
${Array.from({ length: lines }, (_, i) => `+line ${i}`).join("\n")}
`;

const collapsedDiffs = () =>
  [...document.querySelectorAll("[data-diff][data-collapsed]")].map((el) =>
    el.getAttribute("data-diff"),
  );

describe("PatchView (T-528)", () => {
  it("draws one diff per file, behind a height cap", async () => {
    renderWithProviders(<PatchView filename="x.patch" text={TWO_FILES} />);
    await waitFor(() => expect(diffs()).toEqual(["src/a.ts", "src/b.ts"]));
    // CodeView virtualizes against its own box; without the cap a 1 MB patch
    // laid out every line and froze the tab for 15 s.
    const cls = screen.getByTestId("codeview").getAttribute("data-class");
    expect(cls).toMatch(/\bmax-h-/);
    expect(cls).toMatch(/\boverflow-auto\b/);
  });

  it("lists the files with their counts and toggles to the raw text", async () => {
    renderWithProviders(<PatchView filename="x.patch" text={TWO_FILES} />);
    const summary = await screen.findByRole("button", { name: /2 files/ });
    expect(summary.textContent).toContain("+3");
    expect(summary.textContent).toContain("−1");
    fireEvent.click(summary);
    expect(await screen.findByRole("button", { name: /b\.ts/ })).toBeTruthy();

    const raw = screen.getByRole("button", { name: "raw" });
    fireEvent.click(raw);
    expect(raw.getAttribute("aria-pressed")).toBe("true");
    expect(diffs()).toEqual([]);
    expect(document.querySelector("[data-file]")?.textContent).toBe(TWO_FILES);
    fireEvent.click(raw);
    expect(diffs()).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("does not jump inside a clipped card", async () => {
    renderWithProviders(
      <PatchView filename="x.patch" text={TWO_FILES} clipped />,
    );
    fireEvent.click(await screen.findByRole("button", { name: /2 files/ }));
    await waitFor(() =>
      expect(document.querySelector('li[title="src/b.ts"]')).not.toBeNull(),
    );
    expect(screen.queryByRole("button", { name: /b\.ts/ })).toBeNull();
    expect(screen.getByTestId("codeview").getAttribute("data-class")).toMatch(
      /\boverflow-hidden\b/,
    );
  });

  it("refuses a hunk whose counts do not add up, and says so", async () => {
    renderWithProviders(
      <PatchView filename="x.patch" text={SHORT_HUNK} invalidNote />,
    );
    await screen.findByText("Not a valid patch — showing the text.");
    expect(diffs()).toEqual([]);
    expect(document.querySelector("[data-file]")?.textContent).toBe(SHORT_HUNK);
  });

  it("calls text with no file in it invalid too", async () => {
    renderWithProviders(
      <PatchView filename="x.patch" text={"just notes\n"} invalidNote />,
    );
    await screen.findByText("Not a valid patch — showing the text.");
  });
});

describe("the patch header (T-529)", () => {
  it("draws a commit as one row over its message, mail headers and stat left to raw", async () => {
    renderWithProviders(<PatchView filename="x.patch" text={FORMAT_PATCH} />);
    await waitFor(() => expect(diffs()).toEqual(["src/a.ts"]));
    const commit = document.querySelector('[data-item="commit-0"]');
    if (!(commit instanceof HTMLElement)) throw new Error("no commit item");
    const header = within(commit).getByRole("banner");
    expect(header.textContent).toContain("fix: say deux");
    expect(header.textContent).not.toContain("[PATCH]");
    expect(header.textContent).toContain("alice");
    expect(header.textContent).toContain("0000000");
    const message = commit.querySelector("[data-file]")?.textContent;
    expect(message).toBe("The body of the message.");
    // pierre reserves this height for the row without measuring it: a row of
    // any other height shifts every item under it.
    expect(header.firstElementChild?.getAttribute("style")).toMatch(
      /height: 36px/,
    );
  });

  it("names no commit for a bare diff command above a plain diff", async () => {
    renderWithProviders(
      <PatchView
        filename="x.diff"
        text={`diff -u a.txt b.txt\n${SHORT_HUNK.replace("-1,3 +1,3", "-1,2 +1,2")}`}
      />,
    );
    await waitFor(() => expect(diffs()).toEqual(["b.txt"]));
    expect(document.querySelector('[data-item^="commit-"]')).toBeNull();
  });

  it("puts a patch card's controls in its title bar, nothing above the diffs", async () => {
    renderWithProviders(
      <DocumentCard filename="x.patch" text={TWO_FILES} render="patch" />,
    );
    await waitFor(() => expect(diffs()).toEqual(["src/a.ts", "src/b.ts"]));
    const bar = titleBar("x.patch");
    expect(within(bar).getByRole("button", { name: "raw" })).toBeTruthy();
    expect(within(bar).getByRole("button", { name: /2 files/ })).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "raw" })).toHaveLength(1);
    // The first thing in the card's body is the diff view itself.
    const codeview = screen.getByTestId("codeview");
    expect(codeview.parentElement?.firstElementChild).toBe(codeview);
  });

  it("moves the controls into the dialog's title bar when expanded", async () => {
    renderWithProviders(
      <DocumentCard filename="x.patch" text={TWO_FILES} render="patch" />,
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "expand x.patch" }),
    );
    const dialog = await screen.findByRole("dialog");
    const title = within(dialog).getByRole("heading", { name: "x.patch" });
    await waitFor(() =>
      expect(
        within(title.parentElement as HTMLElement).getByRole("button", {
          name: "raw",
        }),
      ).toBeTruthy(),
    );
  });

  it("frames a fence inside a markdown card, leaving the card's title bar alone", async () => {
    renderWithProviders(
      <DocumentCard
        filename="notes.md"
        text={`Notes\n\n\`\`\`diff\n${TWO_FILES}\`\`\`\n`}
      />,
    );
    await waitFor(() => expect(diffs()).toEqual(["src/a.ts", "src/b.ts"]));
    expect(
      within(titleBar("notes.md")).queryByRole("button", { name: "raw" }),
    ).toBeNull();
    expect(screen.getByRole("button", { name: "raw" })).toBeTruthy();
  });
});

describe("```diff fences (T-528)", () => {
  it("draws a fence holding a patch as its diff", async () => {
    renderWithProviders(
      <MarkdownView>{`\`\`\`diff\n${TWO_FILES}\`\`\`\n`}</MarkdownView>,
    );
    await waitFor(() => expect(diffs()).toEqual(["src/a.ts", "src/b.ts"]));
  });

  it("leaves a bare +/- snippet as code, without a complaint", async () => {
    renderWithProviders(
      <MarkdownView>{"```patch\n-old\n+new\n```\n"}</MarkdownView>,
    );
    await waitFor(() =>
      expect(document.querySelector("[data-file]")?.textContent).toBe(
        "-old\n+new",
      ),
    );
    expect(diffs()).toEqual([]);
    expect(screen.queryByText(/Not a valid patch/)).toBeNull();
  });
});

describe("PatchView large files (T-582)", () => {
  it("holds back a file past the line limit until asked", async () => {
    renderWithProviders(
      <PatchView
        filename="x.patch"
        text={`${TWO_FILES}${newFile("state.json", LARGE_DIFF_LINES + 1)}`}
      />,
    );
    await waitFor(() =>
      expect(diffs()).toEqual(["src/a.ts", "src/b.ts", "state.json"]),
    );
    expect(collapsedDiffs()).toEqual(["state.json"]);
    fireEvent.click(screen.getByRole("button", { name: "Load diff" }));
    expect(collapsedDiffs()).toEqual([]);
    expect(screen.queryByRole("button", { name: "Load diff" })).toBeNull();
  });

  it("draws a file at the limit in full", async () => {
    renderWithProviders(
      <PatchView
        filename="x.patch"
        text={`${TWO_FILES}${newFile("state.json", LARGE_DIFF_LINES)}`}
      />,
    );
    await waitFor(() =>
      expect(diffs()).toEqual(["src/a.ts", "src/b.ts", "state.json"]),
    );
    expect(collapsedDiffs()).toEqual([]);
  });

  it("never holds back the only file", async () => {
    renderWithProviders(
      <PatchView
        filename="x.patch"
        text={newFile("state.json", LARGE_DIFF_LINES + 1)}
      />,
    );
    await waitFor(() => expect(diffs()).toEqual(["state.json"]));
    expect(collapsedDiffs()).toEqual([]);
  });
});
