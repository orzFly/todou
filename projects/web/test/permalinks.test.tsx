import { waitFor } from "@testing-library/react";
import type {
  IssueListItem,
  TimelineComment,
  TimelineEvent,
} from "@todou/shared";
import { describe, expect, it } from "vitest";
import { commentRefQuery, issueRefQuery } from "../src/api/issue-refs.ts";
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
  it("gives comments an anchor id and a timestamp permalink", async () => {
    const view = renderWithProviders(
      <CommentItem slug="p" issueNumber={7} comment={commentOf(5)} />,
    );
    const stamp = await waitFor(() => {
      const el = view.container.querySelector(
        "a[href='/projects/p/issues/7#comment-5']",
      );
      expect(el).not.toBeNull();
      return el as HTMLAnchorElement;
    });
    expect(stamp.textContent).toContain("2026");
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
    client.setQueryData(commentRefQuery("p", 3, 42).queryKey, commentOf(42));
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
    expect(link.textContent).toContain("comment by Alice");
  });
});

describe("rich comment permalinks in markdown", () => {
  it("upgrades a bare same-origin comment URL to a rich link", async () => {
    const client = testQueryClient();
    client.setQueryData(
      issueRefQuery("todou", 38).queryKey,
      refItem(38, "Permalink target"),
    );
    client.setQueryData(
      commentRefQuery("todou", 38, 136).queryKey,
      commentOf(136),
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
    expect(link.textContent).toContain("comment by Alice");
  });

  it("decorates a custom-text link to a card as well", async () => {
    // Author-chosen text used to survive here, GitHub-style. Since T-266 the
    // stored form of every reference is a custom-text link — `[#38](…)` —
    // so the two shapes are indistinguishable in the document, and honouring
    // the text would leave every migrated reference undecorated.
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
      const el = view.container.querySelector("a[data-issue-link='38']");
      expect(el).not.toBeNull();
      return el as HTMLAnchorElement;
    });
    expect(link.textContent).toContain("Permalink target");
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
      <IssueLink slug="todou" number={5} />,
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
