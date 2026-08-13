import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { render, waitFor } from "@testing-library/react";
import type {
  IssueListItem,
  ReferenceConfig,
  TimelineEvent,
} from "@todou/shared";
import type { ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { issueRefQuery } from "../src/api/issue-refs.ts";
import { refConfigFor, referenceConfigQuery } from "../src/api/references.ts";
import { MarkdownView } from "../src/components/shared/markdown-view.tsx";
import { EventRow } from "../src/components/timeline/event-row.tsx";
import { splitIssueRefs } from "../src/lib/issue-refs.ts";

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
  unread: false,
  unread_comments: 0,
});

/** todou switched from "#" to "T-" at noon; "#" now points at GitHub. */
const SWITCH_AT = "2026-08-01T12:00:00.000Z";
const BEFORE = "2026-07-01T00:00:00.000Z";
const AFTER = "2026-08-02T00:00:00.000Z";
const switchedConfig: ReferenceConfig = {
  format: {
    prefix: "T",
    history: [{ prefix: "T", effective_from: SWITCH_AT }],
  },
  autolinks: [
    { id: 1, prefix: "#", url_template: "https://github.com/o/r/issues/<num>" },
    { id: 2, prefix: "JIRA-", url_template: "https://jira.example/<num>" },
  ],
};

function renderWithProviders(ui: ReactElement, client: QueryClient) {
  const rootRoute = createRootRoute();
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => ui,
  });
  const projectRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/projects/$slug",
  });
  const issueRoute = createRoute({
    getParentRoute: () => projectRoute,
    path: "issues/$number",
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      indexRoute,
      projectRoute.addChildren([issueRoute]),
    ]),
  });
  return render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

function seededClient(
  slug: string,
  config: ReferenceConfig,
  items: IssueListItem[] = [],
): QueryClient {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  client.setQueryData(referenceConfigQuery(slug).queryKey, config);
  for (const item of items) {
    client.setQueryData(issueRefQuery(slug, item.number).queryKey, item);
  }
  return client;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("splitIssueRefs with a prefixed format", () => {
  const config = refConfigFor(switchedConfig, AFTER);

  it("tokenizes T-N and leaves hyphenated words alone", () => {
    expect(splitIssueRefs("fixes T-76, see T-9", config)).toEqual([
      { type: "text", value: "fixes " },
      { type: "ref", number: 76, text: "T-76" },
      { type: "text", value: ", see " },
      { type: "ref", number: 9, text: "T-9" },
    ]);
    expect(splitIssueRefs("SOME-T-76 xT-76 t-76", config)).toEqual([
      { type: "text", value: "SOME-T-76 xT-76 t-76" },
    ]);
  });

  it("routes handed-over # tokens to the autolink", () => {
    expect(splitIssueRefs("close #12", config)).toEqual([
      { type: "text", value: "close " },
      {
        type: "ext",
        href: "https://github.com/o/r/issues/12",
        text: "#12",
      },
    ]);
  });

  it("supports several rules side by side", () => {
    expect(splitIssueRefs("T-1 #2 JIRA-3", config)).toEqual([
      { type: "ref", number: 1, text: "T-1" },
      { type: "text", value: " " },
      { type: "ext", href: "https://github.com/o/r/issues/2", text: "#2" },
      { type: "text", value: " " },
      { type: "ext", href: "https://jira.example/3", text: "JIRA-3" },
    ]);
  });

  it("keeps pre-switch content on the old format", () => {
    const old = refConfigFor(switchedConfig, BEFORE);
    // "#12" was internal back then — never the autolink's.
    expect(splitIssueRefs("see #12 and T-34", old)).toEqual([
      { type: "text", value: "see " },
      { type: "ref", number: 12, text: "#12" },
      { type: "text", value: " and T-34" },
    ]);
  });
});

describe("MarkdownView time cutoff", () => {
  it("renders pre-switch #N as an internal link", async () => {
    const client = seededClient("todou", switchedConfig, [
      refItem(12, "Old target"),
    ]);
    const view = renderWithProviders(
      <MarkdownView slug="todou" refDate={BEFORE}>
        {"see #12 and T-34"}
      </MarkdownView>,
      client,
    );
    const link = await waitFor(() => {
      const el = view.container.querySelector("a[data-issue-link='12']");
      expect(el).not.toBeNull();
      return el as HTMLAnchorElement;
    });
    expect(link.getAttribute("href")).toBe("/projects/todou/issues/12");
    // The coincidental T-34 in old text must stay plain.
    expect(view.container.querySelectorAll("a")).toHaveLength(1);
    expect(view.container.textContent).toContain("T-34");
  });

  it("renders post-switch #N as the external autolink and T-N internally", async () => {
    const client = seededClient("todou", switchedConfig, [
      refItem(7, "New target"),
    ]);
    const view = renderWithProviders(
      <MarkdownView slug="todou" refDate={AFTER}>
        {"T-7 closes #12"}
      </MarkdownView>,
      client,
    );
    await waitFor(() => {
      expect(
        view.container.querySelector("a[data-issue-link='7']"),
      ).not.toBeNull();
    });
    const external = view.container.querySelector(
      "a[href='https://github.com/o/r/issues/12']",
    );
    expect(external).not.toBeNull();
    expect(external?.getAttribute("target")).toBe("_blank");
    expect(external?.textContent).toBe("#12");
    // Internal spelling follows the CURRENT format.
    const internal = view.container.querySelector("a[data-issue-link='7']");
    expect(internal?.textContent).toContain("T-7");
  });
});

describe("UI spelling follows the current format", () => {
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
    created_at: BEFORE,
  };

  it("respells old referenced events with the new prefix", async () => {
    const client = seededClient("todou", switchedConfig, [
      refItem(3, "Source issue"),
    ]);
    const view = renderWithProviders(
      <EventRow event={event} slug="todou" />,
      client,
    );
    await waitFor(() => {
      expect(view.container.textContent).toContain("referenced by");
      expect(view.container.textContent).toContain("T-3");
    });
    expect(view.container.textContent).not.toContain("#3");
  });
});

describe("referenceConfigQuery degradation", () => {
  it("falls back to the default config on 404 (old servers)", async () => {
    vi.stubGlobal(
      "fetch",
      (async () =>
        new Response(
          JSON.stringify({ error: { code: "not_found", message: "nope" } }),
          { status: 404, headers: { "content-type": "application/json" } },
        )) as typeof fetch,
    );
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const config = await client.fetchQuery(referenceConfigQuery("todou"));
    expect(config).toEqual({
      format: { prefix: null, history: [] },
      autolinks: [],
    });
  });
});
