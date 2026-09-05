import { QueryClient } from "@tanstack/react-query";
import { waitFor } from "@testing-library/react";
import type { ReferenceConfig } from "@todou/shared";
import { describe, expect, it } from "vitest";
import { referenceConfigQuery } from "../src/api/references.ts";
import { MarkdownView } from "../src/components/shared/markdown-view.tsx";
import { renderWithProviders, testQueryClient } from "./render.tsx";

/** A project spelling its refs `F-1`, so a value holding one is a live token. */
const refConfig: ReferenceConfig = {
  format: { prefix: "F", history: [] },
  autolinks: [],
};

function seededClient(slug: string): QueryClient {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  client.setQueryData(referenceConfigQuery(slug).queryKey, refConfig);
  return client;
}

/** Mount one markdown body and wait for the router to hand it over. */
async function mount(
  source: string,
  {
    slug,
    client,
    preview = false,
  }: { slug?: string; client?: QueryClient; preview?: boolean } = {},
): Promise<HTMLElement> {
  const { container } = renderWithProviders(
    <MarkdownView slug={slug} preview={preview}>
      {source}
    </MarkdownView>,
    client ?? testQueryClient(),
  );
  await waitFor(() => {
    expect(container.querySelector(".markdown-body")).not.toBeNull();
  });
  return container;
}

/** The frontmatter grid, or null when nothing recognised one. */
function gridOf(container: HTMLElement): HTMLTableElement | null {
  return container.querySelector("table.markdown-frontmatter");
}

/** Each field row as `[key, value]`, read off the rendered DOM. */
function fieldsOf(container: HTMLElement): Array<[string, string]> {
  const grid = gridOf(container);
  if (grid === null) return [];
  return [...grid.querySelectorAll("tbody > tr")].map((row) => [
    row.querySelector("th")?.textContent ?? "",
    row.querySelector("td")?.textContent ?? "",
  ]);
}

describe("frontmatter rendering", () => {
  it("renders a metadata grid, one row per field", async () => {
    const container = await mount(
      "---\ntitle: Frontmatter\nstatus: approved\n---\n\nBody here.\n",
    );
    const grid = gridOf(container);
    expect(grid).not.toBeNull();
    expect(grid?.querySelector("tbody")).not.toBeNull();
    // No <thead>: frontmatter has no header row, and the first field must not
    // be drawn as one.
    expect(grid?.querySelector("thead")).toBeNull();
    expect(fieldsOf(container)).toEqual([
      ["title", "Frontmatter"],
      ["status", "approved"],
    ]);
    expect(container.textContent).toContain("Body here.");
  });

  it("reads a TOML block the same way", async () => {
    const container = await mount(
      '+++\ntitle = "A"\nowner = "bot-one"\n+++\n\nBody.\n',
    );
    expect(fieldsOf(container)).toEqual([
      ["title", '"A"'],
      ["owner", '"bot-one"'],
    ]);
  });

  it("no longer renders the block as an <hr> and an <h2>", async () => {
    const container = await mount("---\ntitle: A\n---\n\nBody.\n");
    expect(container.querySelector("hr")).toBeNull();
    expect(container.querySelector("h2")).toBeNull();
  });

  // The three shapes measured as broken on this card: a frontmatter value was
  // parsed as prose, so the metadata itself was rewritten — a ref replaced by
  // another card's title, a url turned into a link, `*em*` into emphasis.
  it("leaves a value's markdown unparsed", async () => {
    const source = [
      "---",
      "related: F-1",
      "homepage: https://example.com/docs",
      "note: *em* and `code`",
      "---",
      "",
      "Body.",
      "",
    ].join("\n");
    const container = await mount(source, {
      slug: "todou",
      client: seededClient("todou"),
    });
    expect(fieldsOf(container)).toEqual([
      ["related", "F-1"],
      ["homepage", "https://example.com/docs"],
      ["note", "*em* and `code`"],
    ]);
    const grid = gridOf(container);
    for (const tag of ["a", "em", "code", "strong"]) {
      expect(grid?.querySelector(tag)).toBeNull();
    }
  });

  it("still turns the body's own ref into a link", async () => {
    // The exemption is the frontmatter's, not the document's: the very token
    // left alone above is still resolved one line below it. Asked of a
    // preview, because that is where tokens are read at all since T-266 —
    // stored text carries links, and the exemption is about what a token
    // does on its way into storage.
    const container = await mount("---\nrelated: F-1\n---\n\nSee F-1 too.\n", {
      slug: "todou",
      client: seededClient("todou"),
      preview: true,
    });
    expect(gridOf(container)?.querySelector("a")).toBeNull();
    await waitFor(() => {
      expect(container.querySelector("p a")).not.toBeNull();
    });
  });

  it("still parses the body's own emphasis", async () => {
    const container = await mount("---\nnote: *em*\n---\n\nBody with *em*.\n");
    expect(container.querySelector(".markdown-frontmatter em")).toBeNull();
    expect(container.querySelector("p em")?.textContent).toBe("em");
  });

  it("shows an indented continuation in its field's value cell", async () => {
    const container = await mount("---\nmeta:\n  nested: 1\ntitle: A\n---\n");
    expect(fieldsOf(container)).toEqual([
      ["meta", "\n  nested: 1"],
      ["title", "A"],
    ]);
  });

  it("renders nothing at all for an empty block", async () => {
    const container = await mount("---\n---\n\nBody.\n");
    expect(gridOf(container)).toBeNull();
    expect(container.querySelector("hr")).toBeNull();
    expect(container.textContent?.trim()).toBe("Body.");
  });

  // The other half of the fallback guard: what `remark-frontmatter` does not
  // recognise has to render exactly as it did before this card.
  const unrecognised: Array<[string, string]> = [
    ["a leading blank line", "\n---\ntitle: A\n---\n\nBody.\n"],
    ["no closing fence", "---\ntitle: A\n\nBody.\n"],
    ["`...` as the closing fence", "---\ntitle: A\n...\n\nBody.\n"],
    ["a block mid-document", "Intro.\n\n---\ntitle: A\n---\n\nBody.\n"],
  ];

  for (const [name, source] of unrecognised) {
    it(`renders ${name} as it always did`, async () => {
      const container = await mount(source);
      expect(gridOf(container)).toBeNull();
      // The <hr> and the setext <h2> the source really does mean.
      expect(container.querySelector("hr")).not.toBeNull();
      expect(container.textContent).toContain("title: A");
    });
  }
});
