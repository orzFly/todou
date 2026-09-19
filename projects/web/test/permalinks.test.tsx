import { waitFor } from "@testing-library/react";
import {
  type IssueListItem,
  MePrefs,
  type TimelineComment,
  type TimelineEvent,
} from "@todou/shared";
import { describe, expect, it } from "vitest";
import {
  commentRefQuery,
  issueRefQuery,
  type ResolvedCommentRef,
} from "../src/api/issue-refs.ts";
import { prefsQuery } from "../src/api/prefs.ts";
import { IssueLink } from "../src/components/shared/issue-link.tsx";
import { MarkdownView } from "../src/components/shared/markdown-view.tsx";
import { CommentItem } from "../src/components/timeline/comment-item.tsx";
import { EventRow } from "../src/components/timeline/event-row.tsx";
import {
  parseIssuePermalink,
  parseTimelineAnchor,
} from "../src/lib/timeline-anchors.ts";
import { renderWithProviders, testQueryClient } from "./render.tsx";

const author = {
  id: 1,
  login: "alice",
  display_name: "Alice",
  kind: "human" as const,
  avatar_url: null,
  owner: null,
};

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

const commentOf = (id: number): TimelineComment => ({
  type: "comment",
  id,
  author,
  body: "hi",
  created_at: "2026-08-12T00:00:00Z",
  component: null,
  edited_at: null,
  resolved_at: null,
  hidden_at: null,
  agent_context: null,
});

describe("timeline anchor parsing", () => {
  it("parses comment and event anchors, with or without #", () => {
    expect(parseTimelineAnchor("#comment-12")).toEqual({
      kind: "comment",
      id: 12,
    });
    expect(parseTimelineAnchor("event-7")).toEqual({ kind: "event", id: 7 });
    expect(parseTimelineAnchor("#issue-5")).toBeNull();
    expect(parseTimelineAnchor("")).toBeNull();
  });

  it("recognises same-origin issue permalinks", () => {
    const origin = "https://todou.example";
    expect(
      parseIssuePermalink(`${origin}/projects/todou/issues/38`, origin),
    ).toEqual({ slug: "todou", number: 38 });
    expect(
      parseIssuePermalink(
        `${origin}/projects/todou/issues/38#comment-136`,
        origin,
      ),
    ).toEqual({ slug: "todou", number: 38, commentId: 136 });
    // Foreign origin, non-issue paths, event anchors: no rich rendering.
    expect(
      parseIssuePermalink("https://other.example/projects/t/issues/1", origin),
    ).toBeNull();
    expect(parseIssuePermalink(`${origin}/projects/todou`, origin)).toBeNull();
    expect(
      parseIssuePermalink(`${origin}/projects/todou/issues/38#event-9`, origin),
    ).toBeNull();
    expect(parseIssuePermalink("/projects/todou/issues/38", origin)).toBeNull();
  });
});

describe("comment permalinks in the timeline", () => {
  it("gives comments an anchor id, an id permalink and a timestamp permalink", async () => {
    const view = renderWithProviders(
      <CommentItem slug="p" issueNumber={7} comment={commentOf(5)} />,
    );
    // Both halves of the header meta carry the same href now (T-435), so the
    // timestamp is found by being the `<time>` and not by being the first
    // anchor that points at the comment.
    const links = await waitFor(() => {
      const found = view.container.querySelectorAll<HTMLAnchorElement>(
        "a[href='/projects/p/issues/7#comment-5']",
      );
      expect(found).toHaveLength(2);
      return [...found];
    });
    const stamp = links.find((link) => link.querySelector("time"));
    expect(stamp?.textContent).toContain("2026");
    expect(stamp?.querySelector("time")?.getAttribute("datetime")).toBe(
      "2026-08-12T00:00:00Z",
    );
    const id = links.find((link) => !link.querySelector("time"));
    expect(id?.textContent).toBe("#comment-5");
    expect(view.container.querySelector("#comment-5")).not.toBeNull();
  });

  it("gives event rows an anchor id and a timestamp permalink", async () => {
    const event: TimelineEvent = {
      type: "event",
      id: 9,
      event_type: "closed",
      actor: author,
      payload: { to: { name: "Done" } },
      created_at: "2026-08-12T00:00:00Z",
      agent_context: null,
    };
    const view = renderWithProviders(
      <EventRow event={event} slug="p" issueNumber={7} />,
    );
    await waitFor(() => {
      expect(
        view.container.querySelector("a[href='/projects/p/issues/7#event-9']"),
      ).not.toBeNull();
    });
    expect(view.container.querySelector("#event-9")).not.toBeNull();
  });

  it("deep-links referenced events to the referencing comment", async () => {
    const client = testQueryClient();
    client.setQueryData(
      issueRefQuery("p", 3).queryKey,
      refItem(3, "Source issue"),
    );
    client.setQueryData<ResolvedCommentRef | null>(
      commentRefQuery("p", 3, 42).queryKey,
      () => ({
        ...commentOf(42),
        at: { slug: "p", number: 3, commentId: 42 },
      }),
    );
    const event: TimelineEvent = {
      type: "event",
      id: 11,
      event_type: "referenced",
      actor: author,
      payload: { by_issue: 3, by_comment: 42 },
      created_at: "2026-08-12T00:00:00Z",
      agent_context: null,
    };
    const view = renderWithProviders(
      <EventRow event={event} slug="p" issueNumber={7} />,
      client,
    );
    const link = await waitFor(() => {
      const el = view.container.querySelector("a[data-issue-link='3']");
      expect(el).not.toBeNull();
      return el as HTMLAnchorElement;
    });
    expect(link.getAttribute("href")).toBe("/projects/p/issues/3#comment-42");
    expect(
      [...link.querySelectorAll("[data-ref-part]")]
        .map((part) => part.textContent)
        .join(""),
    ).toBe("#3#comment-42");
    expect(link.querySelector("[data-comment-author]")?.textContent).toBe(
      " by Alice",
    );
  });
});

describe("rich comment permalinks in markdown", () => {
  it("upgrades a bare same-origin comment URL to a rich link", async () => {
    const client = testQueryClient();
    client.setQueryData(
      issueRefQuery("todou", 38).queryKey,
      refItem(38, "Permalink target"),
    );
    client.setQueryData<ResolvedCommentRef | null>(
      commentRefQuery("todou", 38, 136).queryKey,
      () => ({
        ...commentOf(136),
        at: { slug: "todou", number: 38, commentId: 136 },
      }),
    );
    const url = `${window.location.origin}/projects/todou/issues/38#comment-136`;
    const view = renderWithProviders(
      <MarkdownView slug="todou">{`see ${url} here`}</MarkdownView>,
      client,
    );
    const link = await waitFor(() => {
      const el = view.container.querySelector("a[data-comment-link='136']");
      expect(el).not.toBeNull();
      return el as HTMLAnchorElement;
    });
    expect(link.getAttribute("href")).toBe(
      "/projects/todou/issues/38#comment-136",
    );
    expect(link.textContent).toContain("Permalink target");
    expect(
      [...link.querySelectorAll("[data-ref-part]")]
        .map((part) => part.textContent)
        .join(""),
    ).toBe("#38#comment-136");
    expect(link.querySelector("[data-comment-author]")?.textContent).toBe(
      " by Alice",
    );
  });

  it.each(["before", "after"] as const)(
    "keeps a current-page permalink short with %s placement",
    async (placement) => {
      const client = testQueryClient();
      client.setQueryData(
        prefsQuery.queryKey,
        MePrefs.parse({
          ref_placement_reference: placement,
          show_repeated_ref_title: true,
        }),
      );
      client.setQueryData(
        issueRefQuery("todou", 38).queryKey,
        refItem(38, "Current parent title"),
      );
      client.setQueryData<ResolvedCommentRef | null>(
        commentRefQuery("todou", 38, 136).queryKey,
        () => ({
          ...commentOf(136),
          at: { slug: "todou", number: 38, commentId: 136 },
        }),
      );
      const url = `${window.location.origin}/projects/todou/issues/38#comment-136`;
      const view = renderWithProviders(
        <MarkdownView slug="todou" issueNumber={38}>
          {`see ${url} here`}
        </MarkdownView>,
        client,
      );
      const link = await waitFor(() => {
        const anchor = view.container.querySelector<HTMLAnchorElement>(
          "a[data-comment-link='136']",
        );
        expect(anchor).not.toBeNull();
        return anchor as HTMLAnchorElement;
      });
      const tokens = link.querySelectorAll("[data-comment-ref]");
      expect(tokens).toHaveLength(1);
      expect(
        [...link.querySelectorAll("[data-ref-part]")]
          .map((part) => part.textContent)
          .join(""),
      ).toBe("#comment-136");
      expect(link.textContent).toBe("#comment-136 by Alice");
      expect(link.querySelector("[data-comment-author]")?.textContent).toBe(
        " by Alice",
      );
      expect(tokens[0]?.querySelector("[data-comment-author]")).toBeNull();
      expect(
        link.querySelector("[data-comment-title], [data-comment-decoration]"),
      ).toBeNull();
      expect(link.textContent).not.toContain("#38");
      expect(link.textContent).not.toContain("Current parent title");
      expect(link.getAttribute("data-issue-link")).toBe("38");
      expect(link.getAttribute("href")).toBe(
        "/projects/todou/issues/38#comment-136",
      );
    },
  );

  it("keeps custom text ordinary until a comment confirms the parent", async () => {
    const client = testQueryClient();
    client.setQueryData(
      issueRefQuery("todou", 38).queryKey,
      refItem(38, "Permalink target"),
    );
    const url = `${window.location.origin}/projects/todou/issues/38#comment-136`;
    const view = renderWithProviders(
      <MarkdownView slug="todou">{`[read this](${url})`}</MarkdownView>,
      client,
    );
    const link = await waitFor(() => {
      const el = view.container.querySelector("a");
      expect(el).not.toBeNull();
      return el as HTMLAnchorElement;
    });
    expect(link.getAttribute("href")).toBe(url);
    expect(link.textContent).toBe("read this");
    expect(link.getAttribute("data-issue-link")).toBeNull();
  });

  it("leaves a link to somewhere else untouched", async () => {
    const view = renderWithProviders(
      <MarkdownView slug="todou">
        {"[read this](https://example.com/projects/todou/issues/38)"}
      </MarkdownView>,
    );
    const link = await waitFor(() => {
      const el = view.container.querySelector("a");
      expect(el).not.toBeNull();
      return el as HTMLAnchorElement;
    });
    expect(link.textContent).toBe("read this");
    expect(link.getAttribute("data-issue-link")).toBeNull();
  });

  it("still renders plain #N refs via IssueLink with no comment suffix", async () => {
    const client = testQueryClient();
    client.setQueryData(
      issueRefQuery("todou", 5).queryKey,
      refItem(5, "Plain ref"),
    );
    const view = renderWithProviders(
      <IssueLink slug="todou" number={5} pageSlug="todou" />,
      client,
    );
    const link = await waitFor(() => {
      const el = view.container.querySelector("a[data-issue-link='5']");
      expect(el).not.toBeNull();
      return el as HTMLAnchorElement;
    });
    expect(link.textContent).toContain("#5");
    expect(link.textContent).not.toContain("comment");
  });
});
