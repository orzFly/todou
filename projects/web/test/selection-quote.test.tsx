import { POINTER_FINE } from "@orz/ui/hooks/use-media-query";
import { QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, waitFor } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { QUOTE_REHYPE_PLUGINS } from "../src/components/issue/entry-actions-menu.tsx";
import { MarkdownView } from "../src/components/shared/markdown-view.tsx";
import {
  QuoteReplyProvider,
  useQuoteSink,
  useQuoteTarget,
} from "../src/components/timeline/quote-reply.tsx";
import { SelectionQuote } from "../src/components/timeline/selection-quote.tsx";
import { testQueryClient } from "./render.tsx";

/** One timeline entry: a header outside the body, and the rendered body. */
function Entry({ id, body }: { id: string; body: string }) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const quoteRef = useQuoteTarget(body, bodyRef);
  return (
    <div data-testid={id}>
      <header>{id} wrote</header>
      <div ref={quoteRef}>
        <MarkdownView
          slug="p"
          issueNumber={1}
          rehypePlugins={QUOTE_REHYPE_PLUGINS}
        >
          {body}
        </MarkdownView>
      </div>
    </div>
  );
}

/** Stands in for the comment box. */
function Sink({ onQuote }: { onQuote: (markdown: string) => void }) {
  useQuoteSink(onQuote);
  return null;
}

function mount({ withBox = true } = {}) {
  const onQuote = vi.fn();
  const view = render(
    <QueryClientProvider client={testQueryClient()}>
      <QuoteReplyProvider>
        <Entry id="first" body={"Alpha *beta* gamma.\n\nDelta epsilon."} />
        <Entry id="second" body="Zeta eta." />
        {withBox && <Sink onQuote={onQuote} />}
        <SelectionQuote />
      </QuoteReplyProvider>
    </QueryClientProvider>,
  );
  return { view, onQuote };
}

async function rendered(view: ReturnType<typeof render>, id: string) {
  return waitFor(() => {
    const p = view.getByTestId(id).querySelector("p[data-loc]");
    if (!p) throw new Error("not rendered");
    return view.getByTestId(id);
  });
}

function select(start: Node, from: number, end: Node, to: number): void {
  const range = document.createRange();
  range.setStart(start, from);
  range.setEnd(end, to);
  const selection = window.getSelection();
  if (!selection) throw new Error("no selection support");
  selection.removeAllRanges();
  selection.addRange(range);
}

/** Let the rAF-batched read run, so "still absent" means something. */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
  });
}

function textOf(el: Element, selector: string): Node {
  const node = el.querySelector(selector)?.firstChild;
  if (!node) throw new Error(`no text under ${selector}`);
  return node;
}

afterEach(() => {
  window.getSelection()?.removeAllRanges();
  vi.unstubAllGlobals();
});

describe("floating Quote reply (T-723)", () => {
  it("quotes the selected block's markdown from inside one body", async () => {
    const { view, onQuote } = mount();
    const first = await rendered(view, "first");
    const alpha = textOf(first, "p[data-loc]");
    select(alpha, 0, alpha, 5);

    const button = await view.findByRole("button", { name: "Quote reply" });
    fireEvent.click(button);
    // The whole paragraph, emphasis intact: the same block granularity as
    // the `…` menu's Quote reply.
    expect(onQuote).toHaveBeenCalledWith("Alpha *beta* gamma.");
    await waitFor(() =>
      expect(view.queryByRole("button", { name: "Quote reply" })).toBeNull(),
    );
  });

  it("stays away when the selection runs into the next entry", async () => {
    const { view } = mount();
    const first = await rendered(view, "first");
    const second = await rendered(view, "second");
    select(textOf(first, "p[data-loc]"), 0, textOf(second, "p[data-loc]"), 4);
    await settle();
    expect(view.queryByRole("button", { name: "Quote reply" })).toBeNull();
  });

  it("stays away when the selection reaches the entry's own header", async () => {
    const { view } = mount();
    const first = await rendered(view, "first");
    select(textOf(first, "header"), 0, textOf(first, "p[data-loc]"), 4);
    await settle();
    expect(view.queryByRole("button", { name: "Quote reply" })).toBeNull();
  });

  it("offers nothing on a card with no comment box", async () => {
    const { view } = mount({ withBox: false });
    const first = await rendered(view, "first");
    const alpha = textOf(first, "p[data-loc]");
    select(alpha, 0, alpha, 5);
    await settle();
    expect(view.queryByRole("button", { name: "Quote reply" })).toBeNull();
  });

  it("survives its own press collapsing the selection", async () => {
    const { view, onQuote } = mount();
    const first = await rendered(view, "first");
    const delta = first.querySelectorAll("p[data-loc]")[1]?.firstChild;
    if (!delta) throw new Error("no second paragraph");
    select(delta, 0, delta, 5);
    const button = await view.findByRole("button", { name: "Quote reply" });

    fireEvent.pointerDown(button);
    window.getSelection()?.removeAllRanges();
    fireEvent.pointerUp(button);
    await settle();
    fireEvent.click(button);
    expect(onQuote).toHaveBeenCalledWith("Delta epsilon.");
  });

  it("goes once the selection does", async () => {
    const { view } = mount();
    const first = await rendered(view, "first");
    const alpha = textOf(first, "p[data-loc]");
    select(alpha, 0, alpha, 5);
    await view.findByRole("button", { name: "Quote reply" });
    window.getSelection()?.removeAllRanges();
    await waitFor(() =>
      expect(view.queryByRole("button", { name: "Quote reply" })).toBeNull(),
    );
  });

  it("pins a full-width bar to the viewport's foot for touch", async () => {
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: query !== POINTER_FINE,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }));
    const { view } = mount();
    const first = await rendered(view, "first");
    const alpha = textOf(first, "p[data-loc]");
    select(alpha, 0, alpha, 5);
    const button = await view.findByRole("button", { name: "Quote reply" });
    expect(button.parentElement?.className).toContain("fixed");
  });
});
