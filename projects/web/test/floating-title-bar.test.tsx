import type { QueryClient } from "@tanstack/react-query";
import { act, fireEvent, waitFor, within } from "@testing-library/react";
import type {
  Issue,
  MePrefs,
  ReferenceConfig,
  RefPlacement,
} from "@todou/shared";
import { useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prefsQuery } from "../src/api/prefs.ts";
import { referenceConfigQuery } from "../src/api/references.ts";
import { FloatingTitleBar } from "../src/components/issue/floating-title-bar.tsx";
import { renderWithProviders, testQueryClient } from "./render.tsx";

const SLUG = "p";
const LONG_TITLE =
  "a title long enough that the bar has to truncate it somewhere";

const prefixedConfig: ReferenceConfig = {
  format: { prefix: "T", history: [] },
  autolinks: [],
};

const issue = {
  id: 16,
  number: 16,
  title: LONG_TITLE,
  body: "",
  status: {
    id: 1,
    name: "In Progress",
    category: "open",
    color: "#bf8700",
    position: 2,
    is_default: false,
  },
  author: {
    id: 1,
    login: "user",
    display_name: "User",
    kind: "human",
    avatar_url: null,
    owner: null,
  },
  assignees: [],
  labels: [],
  created_at: "2026-08-28T00:00:00Z",
  updated_at: "2026-08-28T00:00:00Z",
  body_edited_at: null,
  open_questions: 0,
  spec_version: null,
  spec_review_status: null,
  spec_unresolved_comments: 0,
  deleted_at: null,
  deleted_by: null,
  unread: false,
  unread_comments: 0,
} satisfies Issue;

/** The last observer's callback, so a test can drive the threshold. */
let notify: ((entries: Array<{ isIntersecting: boolean }>) => void) | undefined;
let observerOptions: IntersectionObserverInit | undefined;

class FakeIntersectionObserver {
  constructor(
    callback: (entries: Array<{ isIntersecting: boolean }>) => void,
    options?: IntersectionObserverInit,
  ) {
    notify = callback;
    observerOptions = options;
  }
  observe() {}
  disconnect() {}
  unobserve() {}
}

function seededClient(
  config: ReferenceConfig = prefixedConfig,
  detail: RefPlacement = "before",
): QueryClient {
  const client = testQueryClient();
  client.setQueryData(referenceConfigQuery(SLUG).queryKey, config);
  client.setQueryData(prefsQuery.queryKey, {
    show_weak_unread: true,
    // The bar follows the detail page, and nothing else (T-157).
    ref_placement_list: "after",
    ref_placement_board: "own_line",
    ref_placement_detail: detail,
    ref_placement_reference: "after",
  } satisfies MePrefs);
  return client;
}

function Harness() {
  const ref = useRef<HTMLDivElement>(null);
  return (
    <>
      <div ref={ref}>the real title block</div>
      <FloatingTitleBar slug={SLUG} issue={issue} watchTarget={ref} />
    </>
  );
}

async function renderBar(config?: ReferenceConfig, detail?: RefPlacement) {
  const { container } = renderWithProviders(
    <Harness />,
    seededClient(config, detail),
  );
  const view = within(container);
  const bar = await view.findByTestId("floating-title-bar");
  return { view, bar };
}

/** Cross the threshold: `true` = the real title is back in view. */
const setIntersecting = (isIntersecting: boolean) =>
  act(() => notify?.([{ isIntersecting }]));

beforeEach(() => {
  notify = undefined;
  observerOptions = undefined;
  vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
  vi.stubGlobal("scrollTo", vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("FloatingTitleBar (T-154)", () => {
  it("appears once the real title scrolls past the shell header", async () => {
    const { bar } = await renderBar();
    expect(bar.dataset.state).toBe("hidden");

    setIntersecting(false);
    expect(bar.dataset.state).toBe("shown");

    setIntersecting(true);
    expect(bar.dataset.state).toBe("hidden");
  });

  it("offsets the threshold by the measured header height", async () => {
    await renderBar();
    expect(observerOptions?.rootMargin).toBe("-56px 0px 0px 0px");
  });

  it("stays hidden from assistive tech in both states", async () => {
    const { bar } = await renderBar();
    expect(bar.getAttribute("aria-hidden")).toBe("true");

    setIntersecting(false);
    expect(bar.getAttribute("aria-hidden")).toBe("true");
  });

  it.each(["before", "after"] as const)(
    "keeps the ref out of the truncating span with ref_placement_detail=%s",
    async (detail) => {
      const { view, bar } = await renderBar(undefined, detail);
      const ref = await view.findByText("T-16");
      const title = await view.findByText(LONG_TITLE);

      expect(ref.parentElement).toBe(bar);
      expect(title.parentElement).toBe(bar);
      expect(title.contains(ref)).toBe(false);
      expect(title.className).toContain("truncate");
      expect(ref.className).toContain("shrink-0");
    },
  );

  it("puts the ref ahead of the title by default (T-153)", async () => {
    const { view } = await renderBar();
    const ref = await view.findByText("T-16");
    const title = await view.findByText(LONG_TITLE);
    expect(
      ref.compareDocumentPosition(title) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("puts the ref after the title when the detail page does", async () => {
    const { view } = await renderBar(undefined, "after");
    const ref = await view.findByText("T-16");
    const title = await view.findByText(LONG_TITLE);
    expect(
      title.compareDocumentPosition(ref) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("spells the ref in the project's format", async () => {
    const { view } = await renderBar({
      format: { prefix: null, history: [] },
      autolinks: [],
    });
    expect(await view.findByText("#16")).toBeTruthy();
  });

  it("scrolls back to the top when clicked", async () => {
    const { bar } = await renderBar();
    setIntersecting(false);

    fireEvent.click(bar);
    expect(window.scrollTo).toHaveBeenCalledWith({
      top: 0,
      behavior: "smooth",
    });
  });

  it("renders inert where IntersectionObserver is missing", async () => {
    vi.stubGlobal("IntersectionObserver", undefined);
    const { bar } = await renderBar();
    await waitFor(() => expect(bar.dataset.state).toBe("hidden"));
  });
});
