import type { QueryClient } from "@tanstack/react-query";
import { waitFor } from "@testing-library/react";
import type {
  Attachment,
  IssueListItem,
  MePrefs,
  ReferenceConfig,
  TimelineEvent,
} from "@todou/shared";
import { describe, expect, it } from "vitest";
import { attachmentsQuery } from "../src/api/attachments.ts";
import {
  commentRefQuery,
  issueRefQuery,
  type ResolvedCommentRef,
} from "../src/api/issue-refs.ts";
import { prefsQuery } from "../src/api/prefs.ts";
import { referenceConfigQuery } from "../src/api/references.ts";
import {
  AttachmentEventLink,
  AttachmentRichLink,
} from "../src/components/issue/attachment-list.tsx";
import { MarkdownView } from "../src/components/shared/markdown-view.tsx";
import {
  REF_CHIP_LABEL,
  REF_CHIP_STRUCTURE,
  RICH_CHIP_LABEL,
  RICH_CHIP_SKIN,
  RICH_CHIP_STRUCTURE,
  RICH_CHIP_TITLE_CAP,
} from "../src/components/shared/rich-chip.ts";
import { EventRow } from "../src/components/timeline/event-row.tsx";
import { renderWithProviders, testQueryClient } from "./render.tsx";

const author = {
  id: 1,
  login: "alice",
  display_name: "Alice",
  kind: "human" as const,
  avatar_url: null,
  owner: null,
};

const LONG =
  "A deliberately very long English issue title, far past any cap a body would put on it";

const refItem = (number: number, title: string): IssueListItem => ({
  id: number,
  number,
  title,
  status: {
    id: 1,
    name: "Todo",
    category: "open",
    color: "#6b7280",
    position: 0,
    is_default: true,
  },
  author,
  assignees: [],
  labels: [],
  created_at: "2026-08-12T00:00:00Z",
  updated_at: "2026-08-12T00:00:00Z",
  body_edited_at: null,
  open_questions: 0,
  spec_version: null,
  spec_review_status: null,
  spec_unresolved_comments: 0,
  deleted_at: null,
  deleted_by: null,
  unread: false,
  unread_comments: 0,
  muted: null,
  blocked_by: [],
  blocks: [],
  moves: [],
});

const config: ReferenceConfig = {
  format: { prefix: "T", history: [] },
  autolinks: [],
};

const PREFS: MePrefs = {
  show_weak_unread: true,
  ref_placement_list: "before",
  ref_placement_board: "own_line",
  ref_placement_detail: "before",
  ref_placement_reference: "before",
  boxed_ref_links: true,
  truncate_ref_title: true,
  show_repeated_ref_title: false,
};

function seeded(overrides: Partial<MePrefs> = {}): QueryClient {
  const client = testQueryClient();
  client.setQueryData(referenceConfigQuery("todou").queryKey, config);
  client.setQueryData(issueRefQuery("todou", 7).queryKey, refItem(7, LONG));
  client.setQueryData(prefsQuery.queryKey, { ...PREFS, ...overrides });
  return client;
}

const inBody = (prefs: Partial<MePrefs> = {}) =>
  renderWithProviders(
    <MarkdownView slug="todou">
      {"see [T-7](/projects/todou/issues/7)"}
    </MarkdownView>,
    seeded(prefs),
  );

const linkIn = (root: ParentNode) =>
  waitFor(() => {
    const el = root.querySelector("a[data-issue-link='7']");
    expect(el).not.toBeNull();
    return el as HTMLAnchorElement;
  });

const titleSpan = (link: Element) =>
  link.hasAttribute("data-comment-link")
    ? (link.querySelector("[data-comment-title]") ?? undefined)
    : [...link.children].find((child) => child.classList.contains("truncate"));

describe("reference title cap (T-371)", () => {
  it("caps the title span and still offers the whole title on hover", async () => {
    const link = await linkIn(inBody().container);
    const span = titleSpan(link);

    expect(span?.getAttribute("class")).toContain(RICH_CHIP_TITLE_CAP);
    expect(span?.textContent).toBe(LONG);
    expect(link.getAttribute("title")).toBe(`T-7 ${LONG} (Todo)`);
  });

  it("drops the cap when the reader turns it off, keeping the title attribute", async () => {
    const link = await linkIn(inBody({ truncate_ref_title: false }).container);
    const span = titleSpan(link);

    expect(span?.getAttribute("class")).not.toContain(RICH_CHIP_TITLE_CAP);
    // Still the chip's own title box, which the sheet holds to the line's
    // width: "off" means no cap of its own, not that a narrow viewport stops
    // cutting it.
    expect(span?.getAttribute("class")).toContain("ref-chip-title");
    expect(link.getAttribute("title")).toBe(`T-7 ${LONG} (Todo)`);
  });

  it("caps independently of the border", async () => {
    const link = await linkIn(inBody({ boxed_ref_links: false }).container);

    expect(titleSpan(link)?.getAttribute("class")).toContain(
      RICH_CHIP_TITLE_CAP,
    );
    for (const skin of RICH_CHIP_SKIN.split(" ")) {
      expect(link.className.split(" ")).not.toContain(skin);
    }
  });

  it.each([false, true])(
    "caps only the issue title in a comment chip when truncate=%s",
    async (truncate_ref_title) => {
      const client = seeded({ truncate_ref_title });
      client.getQueryCache().build<ResolvedCommentRef | null>(client, {
        ...commentRefQuery("todou", 7, 42),
        initialData: {
          type: "comment",
          id: 42,
          author,
          body: "hi",
          created_at: "2026-08-12T00:00:00Z",
          component: null,
          edited_at: null,
          resolved_at: null,
          hidden_at: null,
          agent_context: null,
          at: { slug: "todou", number: 7, commentId: 42 },
        } satisfies ResolvedCommentRef,
      });
      const view = renderWithProviders(
        <MarkdownView slug="todou">
          {"see [T-7#comment-42](/projects/todou/issues/7#comment-42)"}
        </MarkdownView>,
        client,
      );
      const link = await linkIn(view.container);
      expect(link.getAttribute("data-comment-link")).toBe("42");
      expect(titleSpan(link)?.textContent).toBe(LONG);
      expect(titleSpan(link)?.classList.contains(RICH_CHIP_TITLE_CAP)).toBe(
        truncate_ref_title,
      );
      const token = link.querySelector("[data-comment-ref]");
      const by = link.querySelector("[data-comment-author]");
      const parts = [...link.querySelectorAll("[data-ref-part]")];
      expect(parts.map((part) => part.textContent).join("")).toBe(
        "T-7#comment-42",
      );
      expect(token?.contains(titleSpan(link) ?? null)).toBe(true);
      expect(token?.contains(by)).toBe(false);
      expect(by?.textContent).toBe(" by Alice");
      for (const part of parts) {
        expect(part.closest("[data-comment-ref]")).toBe(token);
        expect(
          part.closest(
            "[data-comment-title], [data-comment-decoration], [data-comment-author]",
          ),
        ).toBeNull();
      }
      for (const fixed of [token, by]) {
        expect(fixed?.classList.contains("truncate")).toBe(false);
        expect(fixed?.classList.contains(RICH_CHIP_TITLE_CAP)).toBe(false);
      }
      expect(link.textContent).toBe(`T-7 ${LONG} · #comment-42 by Alice`);
      expect(link.getAttribute("title")).toBe(`T-7 ${LONG} (Todo)`);
    },
  );
});

describe("the chip stops at the body (T-371)", () => {
  const event: TimelineEvent = {
    type: "event",
    id: 1,
    event_type: "referenced",
    actor: author,
    agent_context: null,
    payload: { by_issue: 7 },
    created_at: "2026-08-12T00:00:00Z",
  };

  // Every class either chip is built from, whichever preference put it there
  // — the reference chip's own inline set as well as the attachment chip's
  // flex one, so replacing the structure cannot quietly reopen this row.
  const CHIP_CLASSES = [
    REF_CHIP_STRUCTURE,
    ...REF_CHIP_LABEL.split(" "),
    // Only the chip-specific part: an event row's own glyph shares `inline`
    // and `size-3.5` with it.
    "ref-chip-icon",
    ...RICH_CHIP_STRUCTURE.split(" "),
    ...RICH_CHIP_SKIN.split(" "),
    ...RICH_CHIP_LABEL.split(" "),
    RICH_CHIP_TITLE_CAP,
  ];

  for (const prefs of [
    {},
    { boxed_ref_links: false },
    { truncate_ref_title: false },
    { boxed_ref_links: false, truncate_ref_title: false },
    { show_repeated_ref_title: true },
  ]) {
    it(`leaves an event row's reference plain under ${JSON.stringify(prefs)}`, async () => {
      const view = renderWithProviders(
        <EventRow event={event} slug="todou" />,
        seeded(prefs),
      );
      const link = await linkIn(view.container);

      expect(link.className).toBe("font-medium hover:underline");
      for (const el of [link, ...link.querySelectorAll("*")]) {
        const classes = (el.getAttribute("class") ?? "").split(" ");
        for (const chip of CHIP_CLASSES) {
          expect(classes).not.toContain(chip);
        }
      }
      // The title rides as a bare text node, exactly as before T-371.
      expect(titleSpan(link)).toBeUndefined();
      expect(link.textContent).toContain(LONG);
    });
  }
});

describe("attachment links keep the whole filename reachable (T-371)", () => {
  const LONG_FILE = "a-rather-long-attachment-filename-that-gets-cut.txt";
  const url = `/api/projects/todou/attachments/9/download/${LONG_FILE}`;

  const withAttachment = () => {
    const client = seeded();
    client.setQueryData(attachmentsQuery("todou", 7).queryKey, [
      {
        id: 9,
        filename: LONG_FILE,
        content_type: "text/plain",
        size: 12,
        url,
        uploader: author,
        created_at: "2026-08-12T00:00:00Z",
        aliases: [],
      } satisfies Attachment,
    ]);
    return client;
  };

  it("carries the filename in title, next to a label that may be cut", async () => {
    const view = renderWithProviders(
      <AttachmentRichLink
        slug="todou"
        issueNumber={7}
        attachmentId={9}
        href={url}
        fallbackName={LONG_FILE}
      />,
      withAttachment(),
    );
    const link = await waitFor(() => {
      const el = view.container.querySelector("a");
      expect(el).not.toBeNull();
      return el as HTMLAnchorElement;
    });

    expect(link.getAttribute("title")).toBe(LONG_FILE);
    expect(titleSpan(link)?.getAttribute("class")).toContain("truncate");
  });

  it("leaves the event row's filename link without one", async () => {
    const view = renderWithProviders(
      <AttachmentEventLink
        slug="todou"
        issueNumber={7}
        attachmentId={9}
        filename={LONG_FILE}
      />,
      withAttachment(),
    );
    const link = await waitFor(() => {
      const el = view.container.querySelector("a");
      expect(el).not.toBeNull();
      return el as HTMLAnchorElement;
    });

    // Nothing truncates it there, so there is nothing to recover.
    expect(link.getAttribute("title")).toBeNull();
    expect(titleSpan(link)).toBeUndefined();
  });
});
