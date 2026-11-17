import { waitFor } from "@testing-library/react";
import type { Attachment } from "@todou/shared";
import { describe, expect, it } from "vitest";
import { attachmentsQuery } from "../src/api/attachments.ts";
import { MarkdownView } from "../src/components/shared/markdown-view.tsx";
import { CompareLabelsContext } from "../src/components/shared/media-compare.tsx";
import { renderWithProviders, testQueryClient } from "./render.tsx";

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
  size: 1024,
  url: `/api/projects/p/attachments/${id}/download/${filename}`,
  uploader,
  created_at: "2026-01-01T00:00:00.000Z",
  aliases: [],
});
const FILES = [
  file(1, "before.png"),
  file(2, "after.png"),
  file(3, "old.png"),
  file(4, "new.png"),
];

function renderMarkdown(body: string, issueNumber?: number) {
  const client = testQueryClient();
  client.setQueryData(attachmentsQuery("p", 1).queryKey, FILES);
  return renderWithProviders(
    <MarkdownView slug="p" issueNumber={issueNumber}>
      {body}
    </MarkdownView>,
    client,
  );
}

const labels = (root: ParentNode) =>
  [...root.querySelectorAll(".media-compare-label-name")].map(
    (el) => el.textContent,
  );

const PAIR = `![master](${FILES[0].url}) → ![T-767](${FILES[1].url})\n`;

describe("an author's image pair (T-767)", () => {
  it("renders as one comparison in a paragraph that is a div, labelled by its alts", async () => {
    const view = renderMarkdown(PAIR, 1);
    const block = await waitFor(() => {
      const el = view.container.querySelector(".media-compare");
      if (el === null) throw new Error("not rendered yet");
      return el;
    });
    expect(block.parentElement?.closest(".markdown-paragraph")).not.toBeNull();
    expect(view.container.querySelector("p")).toBeNull();
    expect(labels(view.container)).toEqual(["master", "T-767"]);
    expect(view.container.textContent).not.toContain("→");
  });

  it("falls back to Before / After when the alts are file names", async () => {
    const body = `![before.png](${FILES[0].url}) -> ![after.png](${FILES[1].url})\n`;
    const view = renderMarkdown(body, 1);
    await waitFor(() => {
      expect(labels(view.container)).toEqual(["Before", "After"]);
    });
  });

  it("stays two images and an arrow without an issue", async () => {
    const view = renderMarkdown(PAIR);
    await waitFor(() => {
      expect(view.container.querySelectorAll("img")).toHaveLength(2);
    });
    expect(view.container.querySelector(".media-compare")).toBeNull();
    expect(view.container.textContent).toContain("→");
  });

  it("keeps its alts on a page whose comparisons are versions", async () => {
    const swap = `![old](${FILES[3].url})`;
    const client = testQueryClient();
    client.setQueryData(attachmentsQuery("p", 1).queryKey, FILES);
    // The swap as rehype-decorations leaves it: the new image carrying the old one's address.
    const view = renderWithProviders(
      <CompareLabelsContext.Provider value={{ before: "v2", after: "v5" }}>
        <MarkdownView
          slug="p"
          issueNumber={1}
          rehypePlugins={[markSwap(FILES[2].url)]}
        >
          {`${PAIR}\n${swap}\n`}
        </MarkdownView>
      </CompareLabelsContext.Provider>,
      client,
    );
    await waitFor(() => {
      expect(view.container.querySelectorAll(".media-compare")).toHaveLength(2);
    });
    expect(labels(view.container)).toEqual(["master", "T-767", "v2", "v5"]);
  });
});

/** A stand-in for the spec diff: every lone image becomes a swap of `old`. */
function markSwap(old: string) {
  return () =>
    (tree: import("hast").Root): void => {
      const visit = (node: import("hast").Root | import("hast").Element) => {
        for (const child of node.children) {
          if (child.type !== "element") continue;
          if (
            child.tagName === "img" &&
            child.properties.dataComparePair === undefined
          ) {
            child.properties.dataSwapSrc = old;
            child.properties.dataSwapAlt = "old";
          }
          visit(child);
        }
      };
      visit(tree);
    };
}
