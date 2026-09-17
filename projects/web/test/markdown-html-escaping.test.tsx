import { QueryClientProvider } from "@tanstack/react-query";
import { render, waitFor } from "@testing-library/react";
import type { ComponentProps } from "react";
import Markdown from "react-markdown";
import { describe, expect, it, vi } from "vitest";
import { MarkdownView } from "../src/components/shared/markdown-view.tsx";
import {
  NO_DECORATIONS,
  rehypeDecorations,
} from "../src/lib/rehype-decorations.ts";
import { rehypeExpandDetails } from "../src/lib/rehype-details.ts";
import { rehypeFoldUnchanged } from "../src/lib/rehype-fold-unchanged.ts";
import { rehypeSourceLines } from "../src/lib/rehype-source-lines.ts";
import { renderWithProviders, testQueryClient } from "./render.tsx";

vi.mock("@pierre/diffs/react", () => ({
  CodeView: ({ items }: { items: Array<{ file: { contents: string } }> }) => (
    <pre>
      <code>{items.map((item) => item.file.contents).join("\n")}</code>
    </pre>
  ),
  MultiFileDiff: () => null,
}));

type RehypePlugins = ComponentProps<typeof Markdown>["rehypePlugins"];

/** Everything a surface configures, bar the body it is handed. */
type Surface = Omit<ComponentProps<typeof MarkdownView>, "children">;

/** What the spec review view stacks on top, with nothing marked to review. */
const SPEC_PLUGINS: RehypePlugins = [
  rehypeSourceLines,
  [rehypeDecorations, NO_DECORATIONS],
  [rehypeExpandDetails, { changedRanges: [], annotationRanges: [] }],
  [
    rehypeFoldUnchanged,
    {
      changedRanges: [],
      annotationRanges: [],
      expanded: new Set<string>(),
      keepHeading: true,
    },
  ],
];

const STAMPED: RehypePlugins = [rehypeSourceLines];

/**
 * Every prop combination the product mounts `MarkdownView` under. The
 * whitelist is one list and cannot be one of these surfaces' business, so a
 * difference between two rows here is a bug wherever it appears.
 */
const SURFACES: Array<[string, Surface]> = [
  ["issue body", { slug: "demo", issueNumber: 7, rehypePlugins: STAMPED }],
  ["comment", { slug: "demo", issueNumber: 7, rehypePlugins: STAMPED }],
  ["question card", { slug: "demo", issueNumber: 7 }],
  [
    "spec document",
    { slug: "demo", issueNumber: 7, rehypePlugins: SPEC_PLUGINS },
  ],
  ["document card", { slug: "demo", issueNumber: 7, embedded: true }],
  ["comment hover card", { slug: "demo" }],
];

type Row = {
  /** Row number of the injection list the spec is reviewed against. */
  n: string;
  source: string;
  /** Selectors that must find nothing: the payload did not execute. */
  absent: string[];
  /** Source text that must reach the page: the payload was not swallowed. */
  text: string;
  /** Selectors that must still find something. */
  present?: string[];
};

const ROWS: Row[] = [
  {
    n: "1",
    source: "<script>alert(1)</script>\n",
    absent: ["script"],
    text: "<script>alert(1)</script>",
  },
  {
    n: "2",
    source: "<script\n>alert(1)</script\n>\n",
    absent: ["script"],
    text: "<script\n>alert(1)</script\n>",
  },
  {
    n: "3",
    source: "<img src=x onerror=alert(1)>\n",
    absent: ["img"],
    text: "<img src=x onerror=alert(1)>",
  },
  {
    n: "4",
    source: "<IMG SRC=x OnErRoR=alert(1)>\n",
    absent: ["img"],
    text: "<IMG SRC=x OnErRoR=alert(1)>",
  },
  {
    n: "5",
    source: "<img src=x on\nerror=alert(1)>\n",
    absent: ["img"],
    text: "<img src=x on\nerror=alert(1)>",
  },
  {
    n: "6",
    source: "[a](javascript:alert(1))\n",
    absent: ["a"],
    text: "[a](javascript:alert(1))",
  },
  {
    n: "7",
    source: "[a](JaVaScRiPt:alert(1))\n",
    absent: ["a"],
    text: "[a](JaVaScRiPt:alert(1))",
  },
  {
    n: "8",
    source: "[a](data:text/html,<script>alert(1)</script>)\n",
    absent: ["a", "script"],
    text: "[a](data:text/html,<script>alert(1)</script>)",
  },
  {
    n: "9",
    source: "<javascript:alert(1)>\n",
    absent: ["a"],
    text: "<javascript:alert(1)>",
  },
  {
    n: "10",
    source: "![x](javascript:alert(1))\n",
    absent: ["img"],
    text: "![x](javascript:alert(1))",
  },
  {
    n: "11",
    source: "[a](vbscript:msgbox(1))\n",
    absent: ["a"],
    text: "[a](vbscript:msgbox(1))",
  },
  {
    n: "11b",
    source: "[a][r]\n\n[r]: javascript:alert(1)\n",
    absent: ["a"],
    // The bad URL lives on the definition line, which markdown never renders.
    text: "[a][r]",
  },
  {
    n: "12",
    source: "<style>body{background:url(javascript:alert(1))}</style>\n",
    absent: ["style"],
    text: "<style>body{background:url(javascript:alert(1))}</style>",
  },
  {
    n: "13",
    source: '<p style="width:expression(alert(1))">x</p>\n',
    absent: ["p[style]"],
    text: '<p style="width:expression(alert(1))">x</p>',
  },
  {
    n: "14",
    source: '<iframe srcdoc="<script>alert(1)</script>"></iframe>\n',
    absent: ["iframe", "script", "[srcdoc]"],
    text: '<iframe srcdoc="<script>alert(1)</script>"></iframe>',
  },
  {
    n: "15",
    source: "<svg><script>alert(1)</script></svg>\n",
    absent: ["svg", "script"],
    text: "<svg><script>alert(1)</script></svg>",
  },
  {
    n: "16",
    source:
      "<svg><foreignObject><img src=x onerror=alert(1)></foreignObject></svg>\n",
    absent: ["svg", "foreignObject", "img"],
    text: "<svg><foreignObject><img src=x onerror=alert(1)></foreignObject></svg>",
  },
  {
    n: "17",
    source: "<math><mtext><script>alert(1)</script></mtext></math>\n",
    absent: ["math", "script"],
    text: "<math><mtext><script>alert(1)</script></mtext></math>",
  },
  {
    n: "18",
    source: "<details><summary><script>alert(1)</script></summary></details>\n",
    absent: ["script"],
    text: "<script>alert(1)</script>",
    present: ["details > summary"],
  },
  {
    n: "19",
    source: "<details><summary>a</summary><p>b</details>\n",
    absent: ["p"],
    text: "<p>b",
    present: ["details > summary"],
  },
  {
    n: "20",
    source: "&lt;script&gt;alert(1)&lt;/script&gt;\n",
    absent: ["script"],
    text: "<script>alert(1)</script>",
  },
  {
    n: "21",
    source: "&amp;lt;script&amp;gt;\n",
    absent: ["script"],
    text: "&lt;script&gt;",
  },
  {
    n: "22",
    source: "<!--<script>alert(1)</script>-->\n",
    absent: ["script"],
    text: "<!--<script>alert(1)</script>-->",
  },
  {
    n: "23",
    source: '<base href="https://evil.example/">\n\n[rel](/foo)\n',
    absent: ["base"],
    text: '<base href="https://evil.example/">',
    present: ['a[href="/foo"]'],
  },
  {
    n: "24",
    source: '<form action="https://evil.example"><button>go</button></form>\n',
    absent: ["form", "button"],
    text: '<form action="https://evil.example"><button>go</button></form>',
  },
  {
    n: "25",
    source: '<object data="javascript:alert(1)"></object>\n',
    absent: ["object"],
    text: '<object data="javascript:alert(1)"></object>',
  },
  {
    n: "26",
    source: '<a href="https://evil.example" target="_blank">x</a>\n',
    absent: ["a"],
    text: '<a href="https://evil.example" target="_blank">x</a>',
  },
  {
    n: "27",
    source: "<![CDATA[<script>alert(1)</script>]]>\n",
    absent: ["script"],
    text: "<![CDATA[<script>alert(1)</script>]]>",
  },
  {
    n: "28",
    source: "<?php echo 1; ?>\n",
    absent: [],
    text: "<?php echo 1; ?>",
  },
  {
    n: "29",
    source: "<!DOCTYPE html><script>alert(1)</script>\n",
    absent: ["script"],
    text: "<!DOCTYPE html><script>alert(1)</script>",
  },
  {
    n: "30",
    source: "<scr ipt>alert(1)</scr ipt>\n",
    absent: ["script"],
    text: "<scr ipt>alert(1)</scr ipt>",
  },
];

async function mount(source: string, props: Surface): Promise<HTMLElement> {
  const { container } = renderWithProviders(
    <MarkdownView {...props}>{source}</MarkdownView>,
  );
  await waitFor(() => {
    expect(container.querySelector(".markdown-body")).not.toBeNull();
  });
  return container;
}

describe.each(SURFACES)("raw HTML on the %s surface", (_name, props) => {
  it.each(ROWS.map((row): [string, Row] => [row.n, row]))(
    "neither executes nor swallows injection %s",
    async (_n, row) => {
      const container = await mount(row.source, props);
      for (const selector of row.absent) {
        expect(container.querySelector(selector)).toBeNull();
      }
      for (const selector of row.present ?? []) {
        expect(container.querySelector(selector)).not.toBeNull();
      }
      expect(container.textContent).toContain(row.text);
    },
  );
});

/**
 * What this pipeline can build out of the sources above when nothing leaks:
 * CommonMark and GFM output, the wrappers `MarkdownView` swaps in, and the two
 * tags this renderer now recognises. Anything else means a byte of the source
 * was read as markup.
 */
const BUILDABLE = new Set([
  "p",
  "div",
  "a",
  "img",
  "pre",
  "code",
  "details",
  "summary",
]);

it("builds no element the whitelist does not name", async () => {
  const seen = new Set<string>();
  for (const row of ROWS) {
    const container = await mount(row.source, {
      slug: "demo",
      issueNumber: 7,
      rehypePlugins: SPEC_PLUGINS,
    });
    for (const el of container.querySelectorAll(".markdown-body *")) {
      seen.add(el.tagName.toLowerCase());
    }
  }
  expect([...seen].filter((tag) => !BUILDABLE.has(tag))).toEqual([]);
  // The check is worth nothing if the sources build nothing to begin with.
  expect(seen.has("details")).toBe(true);
  expect(seen.has("summary")).toBe(true);
});

/**
 * The one third-party contract this renderer's escaping rests on. react-markdown
 * replaces every `raw` node with a text node holding its source; were that to
 * change in an upgrade, raw HTML would start reaching the DOM and every guard
 * above would go on passing, because they are all mounted behind our plugins.
 */
it("still gets raw HTML as text from react-markdown alone", () => {
  const { container } = render(
    <QueryClientProvider client={testQueryClient()}>
      <Markdown>{"<iframe src=x></iframe>\n"}</Markdown>
    </QueryClientProvider>,
  );
  expect(container.querySelector("iframe")).toBeNull();
  expect(container.textContent).toContain("<iframe src=x></iframe>");
});
