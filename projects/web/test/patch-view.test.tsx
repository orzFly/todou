import { fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MarkdownView } from "../src/components/shared/markdown-view.tsx";
import { PatchView } from "../src/components/shared/patch-view.tsx";
import { renderWithProviders } from "./render.tsx";

// The real parser runs (it is plain string work); only the renderer is a
// stand-in that says what it was handed.
vi.mock("@pierre/diffs/react", () => ({
  CodeView: ({
    items,
    className,
  }: {
    className?: string;
    items: Array<
      | { id: string; type: "file"; file: { name: string; contents: string } }
      | { id: string; type: "diff"; fileDiff: { name: string } }
    >;
  }) => (
    <div data-testid="codeview" data-class={className ?? ""}>
      {items.map((item) =>
        item.type === "diff" ? (
          <div key={item.id} data-diff={item.fileDiff.name}>
            {item.id}
          </div>
        ) : (
          <pre key={item.id} data-file={item.file.name}>
            {item.file.contents}
          </pre>
        ),
      )}
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

  it("keeps the commit preamble, named by its subject", async () => {
    renderWithProviders(<PatchView filename="x.patch" text={FORMAT_PATCH} />);
    await waitFor(() => expect(diffs()).toEqual(["src/a.ts"]));
    const preamble = document.querySelector("[data-file]");
    expect(preamble?.getAttribute("data-file")).toBe("[PATCH] fix: say deux");
    expect(preamble?.textContent).toContain("The body of the message.");
  });

  it("lists the files with their counts and toggles to the raw text", async () => {
    renderWithProviders(<PatchView filename="x.patch" text={TWO_FILES} />);
    const summary = await screen.findByRole("button", { name: /2 files/ });
    expect(summary.textContent).toContain("+3");
    expect(summary.textContent).toContain("−1");
    fireEvent.click(summary);
    expect(screen.getByRole("button", { name: /src\/b\.ts/ })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Raw" }));
    expect(diffs()).toEqual([]);
    expect(document.querySelector("[data-file]")?.textContent).toBe(TWO_FILES);
    fireEvent.click(screen.getByRole("button", { name: "Diff" }));
    expect(diffs()).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("does not jump inside a clipped card", async () => {
    renderWithProviders(
      <PatchView filename="x.patch" text={TWO_FILES} clipped />,
    );
    fireEvent.click(await screen.findByRole("button", { name: /2 files/ }));
    expect(screen.queryByRole("button", { name: /src\/b\.ts/ })).toBeNull();
    expect(screen.getByText("src/b.ts")).toBeTruthy();
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
