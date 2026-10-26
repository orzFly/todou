import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { Attachment } from "@todou/shared";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AttachmentViewerDialog } from "../src/components/issue/attachment-viewer.tsx";
import { MARKDOWN_RENDER_MAX_CHARS } from "../src/lib/attachment-preview.ts";

/** Under the preview size, what still costs the tab its main thread (T-584). */

vi.mock("@pierre/diffs/react", () => ({
  CodeView: ({
    items,
    className,
  }: {
    items: Array<{ file: { contents: string } }>;
    className?: string;
  }) => (
    <pre data-testid="code" data-class={className ?? ""}>
      <code>{items.map((item) => item.file.contents).join("\n")}</code>
    </pre>
  ),
  WorkerPoolContextProvider: ({ children }: { children: ReactNode }) => (
    <div data-testid="worker-pool">{children}</div>
  ),
  useWorkerPool: () => undefined,
  MultiFileDiff: () => null,
}));

const file = (filename: string, type: string, size: number) =>
  ({
    id: 1,
    filename,
    content_type: type,
    size,
    url: `/api/projects/a/attachments/1/download/${filename}`,
    uploader: {
      id: 1,
      login: "user",
      display_name: "User",
      kind: "human" as const,
      avatar_url: null,
      owner: null,
    },
    created_at: "2026-01-01T00:00:00.000Z",
    aliases: [],
  }) satisfies Attachment;

function open(attachment: Attachment, text: string) {
  // Markdown also asks for what resolves its references; left pending, it
  // renders without them.
  vi.stubGlobal("fetch", (input: unknown) =>
    String(input).includes("/download/")
      ? Promise.resolve(new Response(text))
      : new Promise(() => {}),
  );
  render(
    <QueryClientProvider client={new QueryClient()}>
      <AttachmentViewerDialog
        state={{ items: [attachment], index: 0 }}
        onNavigate={() => {}}
        onClose={() => {}}
        slug="a"
        issueNumber={7}
      />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("a highlighted file in the viewer", () => {
  it("tokenizes in the worker pool, inside a capped box", async () => {
    open(file("app.json", "application/json", 20), '{"a": 1}\n');
    const code = await screen.findByTestId("code");
    expect(code.closest("[data-testid=worker-pool]")).not.toBeNull();
    expect(code.getAttribute("data-class")).toContain("max-h-");
  });
});

describe("a markdown attachment in the viewer", () => {
  const heading = "# Heading\n\nbody\n";

  it("renders when small, with its source a click away", async () => {
    open(file("notes.md", "text/markdown", 20), heading);
    expect(
      await screen.findByRole("heading", { name: "Heading" }),
    ).toBeTruthy();
    expect(screen.queryByText("Too large to render automatically.")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "source" }));
    expect((await screen.findByTestId("code")).textContent).toContain(
      "# Heading",
    );
  });

  it("opens as source past the render limit, and renders on request", async () => {
    const big = heading + "x".repeat(MARKDOWN_RENDER_MAX_CHARS);
    open(file("notes.md", "text/markdown", big.length), big);
    expect((await screen.findByTestId("code")).textContent).toContain(
      "# Heading",
    );
    expect(screen.getByText("Too large to render automatically.")).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Heading" })).toBeNull();
    const toggle = screen.getByRole("button", { name: "source" });
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(toggle);
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "Heading" })).toBeTruthy(),
    );
  });
});
