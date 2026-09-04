import type { QueryClient } from "@tanstack/react-query";
import { waitFor } from "@testing-library/react";
import type { Attachment } from "@todou/shared";
import { describe, expect, it, vi } from "vitest";
import { attachmentsQuery } from "../src/api/attachments.ts";
import { MarkdownView } from "../src/components/shared/markdown-view.tsx";
import { renderWithProviders, testQueryClient } from "./render.tsx";

vi.mock("@pierre/diffs/react", () => ({
  CodeView: ({ items }: { items: Array<{ file: { contents: string } }> }) => (
    <pre>
      <code>{items.map((item) => item.file.contents).join("\n")}</code>
    </pre>
  ),
  MultiFileDiff: () => null,
}));

/**
 * Attachment addresses in a body that outlived the address they name (T-242):
 * the card moved to another project, or the project was renamed. Both leave
 * a URL nobody rewrites, and before this card both degraded to a bare link.
 */

const uploader = {
  id: 1,
  login: "bot-one",
  display_name: "bot-one",
  kind: "machine" as const,
  avatar_url: null,
  owner: null,
};

const attachment = (
  id: number,
  filename: string,
  content_type: string,
  aliases: Attachment["aliases"] = [],
): Attachment => ({
  id,
  filename,
  content_type,
  size: 12,
  url: `/api/projects/b/attachments/${id}/download/${filename}`,
  uploader,
  created_at: "2026-09-01T00:00:00Z",
  aliases,
});

/** Everything on this card came from project `a`, where it had id 88. */
const MOVED = [
  attachment(3, "note.txt", "text/plain", [{ project: "a", id: 88 }]),
  attachment(4, "pic.png", "image/png", [{ project: "a", id: 88 }]),
  attachment(5, "doc.md", "text/markdown", [{ project: "a", id: 88 }]),
];

function seeded(items: Attachment[] = MOVED): QueryClient {
  const client = testQueryClient();
  client.setQueryData(attachmentsQuery("b", 7).queryKey, items);
  return client;
}

const body = (markdown: string, client?: QueryClient) =>
  renderWithProviders(
    <MarkdownView slug="b" issueNumber={7}>
      {markdown}
    </MarkdownView>,
    client,
  );

describe("an address left behind by a move", () => {
  it("renders a link to it as a rich attachment link", async () => {
    const view = body(
      "[the note](/api/projects/a/attachments/88/download/note.txt)",
      seeded([MOVED[0] as Attachment]),
    );
    const anchor = await waitFor(() => {
      const el = view.container.querySelector("a");
      expect(el).not.toBeNull();
      return el as HTMLAnchorElement;
    });
    expect(anchor.querySelector("svg")).not.toBeNull();
    // Resolved, so the anchor points at where the file is now rather than at
    // the address the body holds.
    expect(anchor.getAttribute("href")).toBe(
      "/api/projects/b/attachments/3/view/note.txt",
    );
  });

  it("renders an image reference as the click-to-zoom inline image", async () => {
    const view = body(
      "![](/api/projects/a/attachments/88/download/pic.png)",
      seeded([MOVED[1] as Attachment]),
    );
    const img = await waitFor(() => {
      const el = view.container.querySelector("img");
      expect(el?.className).toContain("cursor-zoom-in");
      return el as HTMLImageElement;
    });
    // The alias address would 301; the canonical one saves every reader a
    // round trip.
    expect(img.getAttribute("src")).toBe(
      "/api/projects/b/attachments/4/download/pic.png",
    );
  });

  it("renders a text reference as a document card, outside the <p>", async () => {
    const view = body(
      "![](/api/projects/a/attachments/88/download/doc.md)",
      seeded([MOVED[2] as Attachment]),
    );
    await waitFor(() => {
      expect(
        view.container.querySelector(".markdown-paragraph"),
      ).not.toBeNull();
    });
    // A document card is block content; HTML forbids it inside <p>, and a
    // browser that finds one there splits the paragraph around it.
    expect(view.container.querySelector("p")).toBeNull();
    expect(view.container.textContent).toContain("doc.md");
  });
});

describe("an address left behind by a rename", () => {
  it("resolves a retired slug of this very project", async () => {
    const renamed = attachment(3, "note.txt", "text/plain", [
      { project: "b-old", id: 3 },
    ]);
    const view = body(
      "[the note](/api/projects/b-old/attachments/3/download/note.txt)",
      seeded([renamed]),
    );
    const anchor = await waitFor(() => {
      const el = view.container.querySelector("a");
      expect(el).not.toBeNull();
      return el as HTMLAnchorElement;
    });
    expect(anchor.querySelector("svg")).not.toBeNull();
    expect(anchor.getAttribute("href")).toBe(
      "/api/projects/b/attachments/3/view/note.txt",
    );
  });
});

describe("an address that answers to nothing here", () => {
  it("stays the plain link the body wrote", async () => {
    const href = "/api/projects/c/attachments/99/download/other.txt";
    const view = body(`[elsewhere](${href})`, seeded());
    const anchor = await waitFor(() => {
      const el = view.container.querySelector("a");
      expect(el).not.toBeNull();
      return el as HTMLAnchorElement;
    });
    // No icon, and the address is untouched: nothing was claimed about it.
    expect(anchor.querySelector("svg")).toBeNull();
    expect(anchor.getAttribute("href")).toBe(href);
  });
});

describe("references to this project's own attachments", () => {
  it("is rich before the attachment list has arrived", async () => {
    // The commonest path, and the one with the most to lose: nothing is
    // seeded, so this is the whole render an offline reader gets.
    const view = body(
      "[the note](/api/projects/b/attachments/3/download/note.txt)",
    );
    const anchor = await waitFor(() => {
      const el = view.container.querySelector("a");
      expect(el).not.toBeNull();
      return el as HTMLAnchorElement;
    });
    expect(anchor.querySelector("svg")).not.toBeNull();
    expect(anchor.getAttribute("href")).toBe(
      "/api/projects/b/attachments/3/download/note.txt",
    );
  });

  it("still degrades a local id nothing answers to", async () => {
    const view = body(
      "![](/api/projects/b/attachments/404/download/ghost.md)",
      seeded(),
    );
    // The id is this project's, so it keeps today's degraded card rather
    // than falling back to a bare <img>.
    await waitFor(() => {
      expect(view.container.textContent).toContain("ghost.md");
    });
    expect(view.container.querySelector("img")).toBeNull();
  });

  it("keeps a canonical reference's own address, /view twin included", async () => {
    const view = body(
      "![](/api/projects/b/attachments/4/view/pic.png)",
      seeded(),
    );
    const img = await waitFor(() => {
      const el = view.container.querySelector("img");
      expect(el?.className).toContain("cursor-zoom-in");
      return el as HTMLImageElement;
    });
    expect(img.getAttribute("src")).toBe(
      "/api/projects/b/attachments/4/view/pic.png",
    );
  });
});

describe("spec-diff decorations", () => {
  /** Stands in for rehype-decorations: marks every <img> the way it does. */
  type HastLike = {
    type?: string;
    tagName?: string;
    properties?: Record<string, unknown>;
    children?: HastLike[];
  };
  const markImages = () => (tree: HastLike) => {
    const walk = (node: HastLike) => {
      if (node.type === "element" && node.tagName === "img") {
        node.properties = { ...node.properties, className: ["spec-ins"] };
      }
      for (const child of node.children ?? []) walk(child);
    };
    walk(tree);
  };

  it("survive the swap to the inline image component (T-223)", async () => {
    const view = renderWithProviders(
      <MarkdownView slug="b" issueNumber={7} rehypePlugins={[markImages]}>
        {"![](/api/projects/a/attachments/88/download/pic.png)"}
      </MarkdownView>,
      seeded([MOVED[1] as Attachment]),
    );
    const img = await waitFor(() => {
      const el = view.container.querySelector("img");
      expect(el?.className).toContain("cursor-zoom-in");
      return el as HTMLImageElement;
    });
    // The mark is painted on the <img> itself rather than on a wrapper, so
    // replacing the element has to carry it across.
    expect(img.className).toContain("spec-ins");
  });
});
