import {
  QueryClient,
  QueryClientProvider,
  QueryObserver,
} from "@tanstack/react-query";
import { render, waitFor } from "@testing-library/react";
import type {
  IssueListItem,
  ReferenceDirectory,
  TimelineEvent,
} from "@todou/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  commentLocationQuery,
  commentRefQuery,
  invalidateIssueRefQueries,
  issueRefQuery,
  type LocatedComment,
} from "../src/api/issue-refs.ts";
import { projectsQuery } from "../src/api/queries.ts";
import {
  referenceConfigQuery,
  referenceDirectoryQuery,
} from "../src/api/references.ts";
import { MarkdownView } from "../src/components/shared/markdown-view.tsx";
import { EventRow } from "../src/components/timeline/event-row.tsx";
import { splitIssueRefs } from "../src/lib/issue-refs.ts";
import { refHref } from "../src/lib/remark-issue-refs.ts";
import { renderWithProviders } from "./render.tsx";

// Fences render through the lazily-imported pierre CodeView (T-31); pin it
// to a plain pre>code so the DOM is deterministic no matter when the lazy
// chunk would resolve.
vi.mock("@pierre/diffs/react", () => ({
  CodeView: ({ items }: { items: Array<{ file: { contents: string } }> }) => (
    <pre>
      <code>{items.map((item) => item.file.contents).join("\n")}</code>
    </pre>
  ),
  MultiFileDiff: () => null,
}));

const refItem = (number: number, title: string): IssueListItem => ({
  id: number,
  number,
  title,
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

function seededClient(slug: string, items: IssueListItem[]): QueryClient {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  for (const item of items) {
    client.setQueryData(issueRefQuery(slug, item.number).queryKey, item);
  }
  return client;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("splitIssueRefs", () => {
  it("splits text around #N tokens", () => {
    expect(splitIssueRefs("see #12 and #3.")).toEqual([
      { type: "text", value: "see " },
      { type: "ref", number: 12, text: "#12" },
      { type: "text", value: " and " },
      { type: "ref", number: 3, text: "#3" },
      { type: "text", value: "." },
    ]);
  });
  it("mirrors the server rule: no refs inside words", () => {
    expect(splitIssueRefs("channel#4chat")).toEqual([
      { type: "text", value: "channel#4chat" },
    ]);
  });
  it("matches at the start of text", () => {
    expect(splitIssueRefs("#7 first")).toEqual([
      { type: "ref", number: 7, text: "#7" },
      { type: "text", value: " first" },
    ]);
  });
});

describe("cross-project segments and their hrefs", () => {
  const config = {
    internalPrefix: null,
    cross: {
      slugs: ["mirror"],
      directory: {
        entries: [
          {
            prefix: "M",
            slug: "mirror",
            from: "2026-01-01T00:00:00Z",
            to: null,
          },
        ],
        contested: [],
      },
      at: "2026-06-01T00:00:00Z",
    },
  };

  it("carries the target project and any comment anchor", () => {
    expect(splitIssueRefs("mirror/M-7#comment-42 and M-8", config)).toEqual([
      {
        type: "xref",
        slug: "mirror",
        number: 7,
        commentId: 42,
        text: "mirror/M-7#comment-42",
      },
      { type: "text", value: " and " },
      { type: "xref", slug: "mirror", number: 8, text: "M-8" },
    ]);
    expect(splitIssueRefs("see #comment-9", config)).toEqual([
      { type: "text", value: "see " },
      { type: "comment", commentId: 9, text: "#comment-9" },
    ]);
  });

  it("encodes each segment as a href MarkdownLink can read back", () => {
    const hrefs = splitIssueRefs(
      "#3 #4#comment-5 mirror#7 mirror#8#comment-9 #comment-1",
      config,
    )
      .filter((segment) => segment.type !== "text")
      .map(refHref);
    expect(hrefs).toEqual([
      "#issue-3",
      "#issue-4/comment-5",
      "#xref-mirror/7",
      "#xref-mirror/8/comment-9",
      "#xref-comment-1",
    ]);
  });
});

describe("MarkdownView issue refs", () => {
  it("links #N in prose but not in code blocks or inline code", async () => {
    // A preview, because that is where a token is read at all since T-266:
    // stored text carries the link the submission resolved, and the code
    // exemption is what decides whether a token becomes one.
    const client = seededClient("todou", [refItem(5, "Ref target")]);
    const body = "Fixes #5 via `#6` and:\n\n```\nignore #7\n```\n";
    const view = renderWithProviders(
      <MarkdownView slug="todou" preview>
        {body}
      </MarkdownView>,
      client,
    );

    const link = await waitFor(() => {
      const el = view.container.querySelector("a[data-issue-link='5']");
      expect(el).not.toBeNull();
      return el as HTMLAnchorElement;
    });
    expect(link.getAttribute("href")).toBe("/projects/todou/issues/5");
    expect(link.textContent).toContain("Ref target");
    expect(link.textContent).toContain("#5");

    // The exemptions: #6 and #7 stay literal text inside code elements.
    expect(view.container.querySelectorAll("a")).toHaveLength(1);
    const codes = [...view.container.querySelectorAll("code")];
    expect(codes.some((c) => c.textContent?.includes("#6"))).toBe(true);
    expect(codes.some((c) => c.textContent?.includes("#7"))).toBe(true);
  });

  it("renders no links without a slug", () => {
    const client = new QueryClient();
    const view = render(
      <QueryClientProvider client={client}>
        <MarkdownView>{"see #5"}</MarkdownView>
      </QueryClientProvider>,
    );
    expect(view.container.querySelector("a")).toBeNull();
  });
});

describe("EventRow issue refs", () => {
  const event: TimelineEvent = {
    type: "event",
    id: 1,
    event_type: "referenced",
    actor: {
      id: 1,
      login: "user",
      display_name: "User",
      kind: "human",
      avatar_url: null,
      owner: null,
    },
    agent_context: null,
    payload: { by_issue: 3 },
    created_at: "2026-08-12T00:00:00Z",
  };

  it("links #N in the action text when a slug is given", async () => {
    const client = seededClient("todou", [refItem(3, "Source issue")]);
    const view = renderWithProviders(
      <EventRow event={event} slug="todou" />,
      client,
    );

    const link = await waitFor(() => {
      const el = view.container.querySelector("a[data-issue-link='3']");
      expect(el).not.toBeNull();
      return el as HTMLAnchorElement;
    });
    expect(link.getAttribute("href")).toBe("/projects/todou/issues/3");
    expect(link.textContent).toContain("Source issue");
  });

  it("stays plain text without a slug", async () => {
    const client = new QueryClient();
    const view = renderWithProviders(<EventRow event={event} />, client);
    await waitFor(() =>
      expect(view.container.textContent).toContain("referenced by #3"),
    );
    // The row's complete anchor list, which is what this case has always
    // asked: with no slug the timestamp renders as a <span> rather than a
    // <Link>, so the actor's chip (T-391) is the only anchor the row has.
    // Narrowing this to `a[data-issue-link]` would still pass today and
    // would stop biting the moment a reference reached the row by some
    // other rendering path.
    expect(
      [...view.container.querySelectorAll("a")].map((a) =>
        a.getAttribute("href"),
      ),
    ).toEqual(["/users/user"]);
  });
  it("keeps a known comment address ordinary when its comment is missing", async () => {
    const client = seededClient("todou", [refItem(3, "Source issue")]);
    client.setQueryData(commentRefQuery("todou", 3, 42).queryKey, null);
    const view = renderWithProviders(
      <EventRow
        event={{ ...event, payload: { by_issue: 3, by_comment: 42 } }}
        slug="todou"
      />,
      client,
    );
    const link = await waitFor(() => {
      const el = view.container.querySelector(
        "a[href='/projects/todou/issues/3#comment-42']",
      );
      expect(el).not.toBeNull();
      return el as HTMLAnchorElement;
    });
    expect(link.textContent).toContain("#3#comment-42");
    expect(link.getAttribute("data-issue-link")).toBeNull();
    expect(link.getAttribute("title")).toBeNull();
    expect(link.querySelector("svg")).toBeNull();
    expect(link.textContent).not.toContain("Source issue");
  });
});

describe("issue ref batching", () => {
  it("coalesces refs requested in the same tick into one request", async () => {
    const urls: string[] = [];
    vi.stubGlobal("fetch", (async (input: unknown) => {
      urls.push(String(input));
      if (String(input).includes("/issues/999")) {
        return new Response(JSON.stringify({ error: { code: "not_found" } }), {
          status: 404,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(
        JSON.stringify({
          items: [refItem(5, "Five"), refItem(9, "Nine")],
          next_cursor: null,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch);

    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const [five, nine, missing] = await Promise.all([
      client.fetchQuery(issueRefQuery("todou", 5)),
      client.fetchQuery(issueRefQuery("todou", 9)),
      client.fetchQuery(issueRefQuery("todou", 999)),
    ]);

    // One list request for all three, then a probe for the miss alone: a
    // number the list does not return may be a card that moved away, and
    // only the issue route can tell that apart from a number nobody used.
    expect(urls).toHaveLength(2);
    expect(urls[0]).toContain("numbers=5%2C9%2C999");
    expect(urls[1]).toContain("/issues/999");
    expect(five?.title).toBe("Five");
    expect(nine?.title).toBe("Nine");
    expect(missing).toBeNull();
  });
});
describe("reference invalidation", () => {
  it("stales matching refs and locations immediately, cancels old generations, and refreshes active refs", async () => {
    const client = seededClient("todou", [refItem(3, "Old")]);
    const issueKey = issueRefQuery("todou", 3).queryKey;
    const locationKey = commentLocationQuery("todou", 42).queryKey;
    client.setQueryData(locationKey, null);
    client.setQueryData(
      issueRefQuery("other", 3).queryKey,
      refItem(3, "Other"),
    );
    let releaseOld: ((value: IssueListItem) => void) | undefined;
    let calls = 0;
    const observer = new QueryObserver(client, {
      ...issueRefQuery("todou", 3),
      queryFn: ({ signal }) => {
        signal.addEventListener("abort", () => {});
        calls += 1;
        if (calls > 1) return Promise.resolve(refItem(3, "New"));
        return new Promise<IssueListItem>((resolve) => {
          releaseOld = resolve;
        });
      },
    });
    const stop = observer.subscribe(() => {});
    const oldRequest = client.refetchQueries({
      queryKey: issueKey,
      type: "active",
    });
    await waitFor(() => expect(releaseOld).toBeDefined());

    const refresh = invalidateIssueRefQueries(client, {
      slug: "todou",
      issueNumber: 3,
    });
    expect(client.getQueryState(issueKey)?.isInvalidated).toBe(true);
    expect(client.getQueryState(locationKey)?.isInvalidated).toBe(true);
    expect(
      client.getQueryState(issueRefQuery("other", 3).queryKey)?.isInvalidated,
    ).toBe(false);
    await refresh;
    releaseOld?.(refItem(3, "Old response"));
    await oldRequest;
    expect(client.getQueryData<IssueListItem>(issueKey)?.title).toBe("New");
    expect(calls).toBe(2);
    stop();
  });
  it("revalidates a prewarmed 59-second-old active ref at age 60 seconds", async () => {
    vi.useFakeTimers();
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    let stop: (() => void) | undefined;
    try {
      vi.setSystemTime(new Date("2026-09-18T12:00:00Z"));
      const key = issueRefQuery("todou", 3).queryKey;
      client.setQueryData(key, refItem(3, "Prewarmed"), {
        updatedAt: Date.now() - 59_000,
      });
      let resolveProbe: ((value: IssueListItem) => void) | undefined;
      const refreshed = vi.fn(
        () =>
          new Promise<IssueListItem>((resolve) => {
            resolveProbe = resolve;
          }),
      );
      const observer = new QueryObserver(client, {
        ...issueRefQuery("todou", 3),
        queryFn: refreshed,
      });
      stop = observer.subscribe(() => {});
      expect(refreshed).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(999);
      expect(refreshed).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(refreshed).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(25);
      expect(refreshed).toHaveBeenCalledTimes(1);
      resolveProbe?.(refItem(3, "Revalidated"));
      await vi.advanceTimersByTimeAsync(0);
      expect(client.getQueryData<IssueListItem>(key)?.title).toBe(
        "Revalidated",
      );
    } finally {
      stop?.();
      client.clear();
      vi.useRealTimers();
    }
  });
  it("reuses a located comment without resetting its freshness or refetching it", async () => {
    const client = seededClient("todou", [refItem(3, "Parent")]);
    client.setQueryData(referenceConfigQuery("todou").queryKey, {
      format: { prefix: null, history: [] },
      autolinks: [],
    });
    client.setQueryData<ReferenceDirectory>(
      referenceDirectoryQuery.queryKey,
      () => ({
        entries: [],
        contested: [],
      }),
    );
    client.setQueryData(projectsQuery.queryKey, [
      {
        id: 1,
        slug: "todou",
        name: "todou",
        description: "",
        created_at: "2026-08-12T00:00:00Z",
      },
    ]);
    const updatedAt = Date.now() - 20_000;
    const locationKey = commentLocationQuery("todou", 42).queryKey;
    client.setQueryData<LocatedComment | null>(
      locationKey,
      () => ({
        issue_number: 3,
        issue_ref: "#3",
        comment: {
          type: "comment",
          id: 42,
          author: refItem(3, "").author,
          body: "body",
          created_at: "2026-08-12T00:00:00Z",
          edited_at: null,
          resolved_at: null,
          hidden_at: null,
          component: null,
          agent_context: null,
        },
      }),
      { updatedAt },
    );
    const urls: string[] = [];
    vi.stubGlobal("fetch", (async (input: unknown) => {
      urls.push(String(input));
      return new Response(JSON.stringify({ error: { code: "not_found" } }), {
        status: 404,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch);
    const view = renderWithProviders(
      <MarkdownView slug="todou" preview>
        {"#comment-42"}
      </MarkdownView>,
      client,
    );
    const rich = await waitFor(() => {
      const link = view.container.querySelector("a[data-comment-link='42']");
      expect(link).not.toBeNull();
      return link as HTMLAnchorElement;
    });
    expect(rich.getAttribute("href")).toBe(
      "/projects/todou/issues/3#comment-42",
    );
    expect(rich.getAttribute("data-issue-link")).toBe("3");
    expect(rich.textContent).toContain("Parent");
    const token = rich.querySelector("[data-comment-ref]");
    const author = rich.querySelector("[data-comment-author]");
    expect(token?.textContent).toBe("#3#comment-42");
    expect(author?.textContent).toBe(" · by User");
    expect(token?.contains(author)).toBe(false);
    const commentKey = commentRefQuery("todou", 3, 42).queryKey;
    expect(client.getQueryState(locationKey)?.dataUpdatedAt).toBe(updatedAt);
    expect(client.getQueryState(commentKey)?.dataUpdatedAt).toBe(updatedAt);
    expect(client.getQueryData(commentKey)).toMatchObject({
      id: 42,
      at: { slug: "todou", number: 3, commentId: 42 },
    });
    expect(urls.filter((url) => url.includes("/comments/42"))).toHaveLength(0);
  });
});
