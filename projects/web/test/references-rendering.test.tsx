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
  MePrefs,
  Project,
  ReferenceConfig,
  ReferenceDirectory,
  RefPlacement,
  TimelineEvent,
} from "@todou/shared";
import type { ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { issueRefQuery } from "../src/api/issue-refs.ts";
import { prefsQuery } from "../src/api/prefs.ts";
import { projectsQuery } from "../src/api/queries.ts";
import {
  refConfigFor,
  referenceConfigQuery,
  referenceDirectoryQuery,
} from "../src/api/references.ts";
import { IssueLink } from "../src/components/shared/issue-link.tsx";
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
  deleted_at: null,
  deleted_by: null,
  unread: false,
  unread_comments: 0,
  moves: [],
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

/** mirror spells its issues "M-7"; todou has held "T" since the switch. */
const mirrorConfig: ReferenceConfig = {
  format: {
    prefix: "M",
    history: [{ prefix: "M", effective_from: SWITCH_AT }],
  },
  autolinks: [],
};

const project = (id: number, slug: string): Project => ({
  id,
  slug,
  name: slug,
  description: "",
  created_at: SWITCH_AT,
});

const directory = (
  over: Partial<ReferenceDirectory> = {},
): ReferenceDirectory => ({
  entries: [{ prefix: "M", slug: "mirror", from: SWITCH_AT, to: null }],
  contested: [],
  ...over,
});

/**
 * A viewer whose readable set is `readable`, with the cross-project
 * directory in place. `targets` seeds the batched issue lookups; anything
 * left unseeded falls through to the suite's offline 404.
 */
function crossClient(opts: {
  readable: string[];
  dir?: ReferenceDirectory;
  targets?: Array<[string, IssueListItem]>;
}): QueryClient {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  client.setQueryData(referenceConfigQuery("todou").queryKey, switchedConfig);
  client.setQueryData(referenceConfigQuery("mirror").queryKey, mirrorConfig);
  client.setQueryData(
    referenceDirectoryQuery.queryKey,
    opts.dir ?? directory(),
  );
  client.setQueryData(
    projectsQuery.queryKey,
    opts.readable.map((slug, i) => project(i + 1, slug)),
  );
  for (const [slug, item] of opts.targets ?? []) {
    client.setQueryData(issueRefQuery(slug, item.number).queryKey, item);
  }
  return client;
}

const crossView = (body: string, client: QueryClient) =>
  renderWithProviders(
    <MarkdownView slug="todou" refDate={AFTER}>
      {body}
    </MarkdownView>,
    client,
  );

describe("cross-project references", () => {
  it("renders a qualified ref in the target's own spelling", async () => {
    const client = crossClient({
      readable: ["todou", "mirror"],
      targets: [["mirror", refItem(7, "Mirror target")]],
    });
    const view = crossView("see mirror#7 please", client);
    const link = await waitFor(() => {
      const el = view.container.querySelector("a[data-issue-project='mirror']");
      expect(el).not.toBeNull();
      return el as HTMLAnchorElement;
    });
    expect(link.getAttribute("href")).toBe("/projects/mirror/issues/7");
    expect(link.textContent).toContain("Mirror target");
    // The self-contained form, spelled in the TARGET's format.
    expect(link.textContent).toContain("mirror/M-7");
  });

  it("resolves a bare foreign prefix through the directory", async () => {
    const client = crossClient({
      readable: ["todou", "mirror"],
      targets: [["mirror", refItem(7, "Bare target")]],
    });
    const view = crossView("fixes M-7", client);
    await waitFor(() => {
      expect(
        view.container.querySelector("a[data-issue-project='mirror']"),
      ).not.toBeNull();
    });
  });

  it("leaves a contested prefix as plain text", async () => {
    const client = crossClient({
      readable: ["todou", "mirror"],
      dir: directory({
        contested: [{ prefix: "M", from: SWITCH_AT, to: null }],
      }),
      targets: [["mirror", refItem(7, "Never shown")]],
    });
    const view = crossView("fixes M-7", client);
    await waitFor(() => {
      expect(view.container.textContent).toContain("fixes M-7");
    });
    expect(view.container.querySelector("a")).toBeNull();
  });

  it("keeps an unreadable project literal, down to the written spelling", async () => {
    const client = crossClient({ readable: ["todou"] });
    const view = crossView("see mirror/T-7 please", client);
    await waitFor(() => {
      expect(view.container.textContent).toContain("see mirror/T-7 please");
    });
    // No link, and the trailing T-7 never falls through to todou's own T-7.
    expect(view.container.querySelector("a")).toBeNull();
  });

  it("degrades to plain text when the target lookup fails", async () => {
    // mirror is nameable but its issues answer 404 — the offline default.
    const client = crossClient({ readable: ["todou", "mirror"] });
    const view = crossView("see mirror#7 please", client);
    await waitFor(() => {
      expect(view.container.textContent).toContain("mirror#7");
    });
    expect(view.container.querySelector("a")).toBeNull();
  });

  it("deep-links a comment anchor riding on a qualified ref", async () => {
    const client = crossClient({
      readable: ["todou", "mirror"],
      targets: [["mirror", refItem(7, "Anchored")]],
    });
    const view = crossView("see mirror#7#comment-42", client);
    const link = await waitFor(() => {
      const el = view.container.querySelector("a[data-comment-link='42']");
      expect(el).not.toBeNull();
      return el as HTMLAnchorElement;
    });
    expect(link.getAttribute("href")).toContain("comment-42");
  });

  it("names the source project on a cross_referenced event", async () => {
    const client = crossClient({
      readable: ["todou", "mirror"],
      targets: [["mirror", refItem(3, "Source card")]],
    });
    const view = renderWithProviders(
      <EventRow
        event={{
          type: "event",
          id: 9,
          event_type: "cross_referenced",
          actor: {
            id: 1,
            login: "user",
            display_name: "User",
            kind: "human",
            avatar_url: null,
            owner: null,
          },
          agent_context: null,
          payload: { by_project: "mirror", by_issue: 3 },
          created_at: AFTER,
        }}
        slug="todou"
      />,
      client,
    );
    await waitFor(() => {
      expect(view.container.textContent).toContain("referenced by");
      expect(view.container.textContent).toContain("mirror/M-3");
    });
    // Never spelled in this project's format, which would point elsewhere.
    expect(view.container.textContent).not.toContain("T-3");
  });
});

describe("IssueLink ref placement (T-153, T-157)", () => {
  const orderedClient = (reference: RefPlacement) => {
    const client = seededClient("todou", switchedConfig, [
      refItem(7, "Target issue"),
    ]);
    client.setQueryData(prefsQuery.queryKey, {
      show_weak_unread: true,
      // A link follows the reference surface alone.
      ref_placement_list: "after",
      ref_placement_board: "own_line",
      ref_placement_detail: "after",
      ref_placement_reference: reference,
    } satisfies MePrefs);
    return client;
  };

  const renderLink = async (reference: RefPlacement, commentId?: number) => {
    const view = renderWithProviders(
      <IssueLink slug="todou" number={7} commentId={commentId} />,
      orderedClient(reference),
    );
    return await waitFor(() => {
      const el = view.container.querySelector("a[data-issue-link='7']");
      expect(el?.textContent).toContain("Target issue");
      return el as HTMLAnchorElement;
    });
  };

  it("leads with the ref by default, spelling it exactly once", async () => {
    const link = await renderLink("before");
    expect(link.textContent).toBe("T-7 Target issue");
    expect(link.title).toBe("T-7 Target issue (In Progress)");
  });

  it("trails the ref when references are set to after", async () => {
    const link = await renderLink("after");
    expect(link.textContent).toBe("Target issue T-7");
    expect(link.title).toBe("Target issue T-7 (In Progress)");
  });

  it("keeps the comment note trailing in either order", async () => {
    expect((await renderLink("before", 42)).textContent).toBe(
      "T-7 Target issue · comment",
    );
    expect((await renderLink("after", 42)).textContent).toBe(
      "Target issue T-7 · comment",
    );
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
