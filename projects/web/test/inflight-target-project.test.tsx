import {
  onlineManager,
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
  useParams,
} from "@tanstack/react-router";
import {
  act,
  fireEvent,
  type RenderResult,
  render,
  renderHook,
  waitFor,
} from "@testing-library/react";
import type {
  AccessDenial,
  Agent,
  IssueListPage,
  Me,
  Member,
  Project,
  ReferenceConfig,
  Status,
} from "@todou/shared";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useBoardMove } from "../src/api/board.ts";
import {
  useDeleteIssueMutation,
  useIssueLabelsMutation,
  useIssueStatusMutation,
  useMoveIssueMutation,
  useRestoreIssueMutation,
} from "../src/api/issues.ts";
import {
  accessDenialsQuery,
  agentsQuery,
  labelsQuery,
  membersQuery,
  meQuery,
  projectQuery,
  statusesQuery,
} from "../src/api/queries.ts";
import { referenceConfigQuery } from "../src/api/references.ts";
import { ReviewSubmitDialog } from "../src/components/spec/review-submit.tsx";
import type { SpecReviewDraft } from "../src/lib/spec-drafts.ts";
import {
  AccessDenialsSection,
  LabelsSection,
  MembersSection,
  ProjectSection,
  ReferencesSection,
  SlugSection,
  StatusesSection,
} from "../src/pages/project-settings.tsx";
import { cmSetValue } from "./cm.ts";
import { renderWithProviders } from "./render.tsx";

/**
 * The project-side twin of `inflight-target.test.tsx`: that file records
 * writes aimed at a *card* the page then left; this one records writes aimed
 * at a *project* the page then left. Every case walks the same skeleton:
 * go offline, `mutate()`, (for form-payload rows) edit the form again,
 * navigate the route to another slug, come back online, and check that the
 * request lands on the project the write was made on, carrying the payload
 * as it was at the moment of the click.
 */

const me: Me = {
  id: 100,
  login: "alice",
  display_name: "alice",
  kind: "human",
  avatar_url: null,
  owner: null,
  email: null,
  is_instance_admin: false,
  created_at: "2026-01-01T00:00:00Z",
};

const bob = {
  id: 101,
  login: "bob",
  display_name: "bob",
  kind: "human" as const,
  avatar_url: null,
  owner: null,
};

const project = (slug: string, name: string): Project => ({
  id: slug === "p" ? 1 : 2,
  slug,
  name,
  description: `Project ${name}.`,
  created_at: "2026-08-01T00:00:00.000Z",
});

const referenceConfig = (slug: string): ReferenceConfig => ({
  format: { prefix: null, history: [] },
  autolinks: [
    { id: 5, prefix: "JIRA-", url_template: `https://${slug}.example/<num>` },
  ],
});

const statuses: Status[] = [
  {
    id: 1,
    name: "open",
    category: "open",
    color: "#6b7280",
    position: 1,
    is_default: true,
  },
  {
    id: 2,
    name: "done",
    category: "closed",
    color: "#6b7280",
    position: 2,
    is_default: false,
  },
];

const members: Member[] = [
  { user: me, role: "admin", created_at: "2026-01-01T00:00:00.000Z" },
  { user: bob, role: "admin", created_at: "2026-01-02T00:00:00.000Z" },
];

const denial: AccessDenial = {
  user: { ...bob, kind: "machine", owner: { id: 9, login: "alice" } },
  denied_by: me,
  created_at: "2026-09-07T10:00:00.000Z",
};

type Call = { url: string; method?: string; body?: string };

/**
 * Records every request and answers 2xx without doing anything. A PATCH to
 * a project answers with the renamed project — the rename redirect reads
 * `updated.slug` off it.
 */
function stubFetch(): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method;
    const call = {
      url,
      method,
      body: init?.body === undefined ? undefined : String(init.body),
    };
    calls.push(call);
    if (method === "PATCH" && call.body) {
      const slug = url.match(/\/api\/projects\/([^/]+)$/)?.[1];
      return new Response(JSON.stringify(project(slug ?? "p", "Pea")), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify({}), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch);
  return calls;
}

/** Mutations retry by default; a paused write must not be sent twice. */
function queryClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
}

/**
 * The seed both projects' pages read: nothing suspends after the swap, so
 * the navigation is a pure re-render — the exact conditions under which a
 * route-param change leaves the component mounted.
 */
function seed(client: QueryClient) {
  client.setQueryData(projectQuery("q").queryKey, project("q", "Quince"));
  client.setQueryData(meQuery.queryKey, me);
  client.setQueryData(agentsQuery.queryKey, [] as Agent[]);
  client.setQueryData(membersQuery("p").queryKey, members);
  client.setQueryData(membersQuery("q").queryKey, members);
  client.setQueryData(accessDenialsQuery("p").queryKey, [
    denial,
  ] as AccessDenial[]);
  client.setQueryData(accessDenialsQuery("q").queryKey, [] as AccessDenial[]);
  client.setQueryData(statusesQuery("p").queryKey, statuses);
  client.setQueryData(statusesQuery("q").queryKey, statuses);
  client.setQueryData(labelsQuery("p").queryKey, [
    {
      id: 3,
      name: "bug",
      color: "#ef4444",
    },
  ]);
  client.setQueryData(labelsQuery("q").queryKey, []);
  client.setQueryData(referenceConfigQuery("p").queryKey, referenceConfig("p"));
  client.setQueryData(referenceConfigQuery("q").queryKey, referenceConfig("q"));
}

afterEach(() => {
  onlineManager.setOnline(true);
  // The dialog target case rewrites the module-level props in place; a
  // reset keeps the next case from inheriting the swap.
  reviewProps.slug = "p";
  reviewProps.issueNumber = 23;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const writeCalls = (calls: Call[]) =>
  calls.filter((c) => c.method !== undefined && c.method !== "GET");

type SectionView = ReturnType<typeof render>;

type SectionComponent = (props: { slug: string }) => React.ReactElement | null;

/**
 * Holds the slug the section is mounted with, so the swap below is a
 * re-render rather than a remount. `rerender` cannot do it any more: the
 * shim router bakes its element in when the router is built (T-391), so
 * re-rendering the tree would replace the router the chips' links need.
 */
function SlugHarness({
  section: Section,
  setter,
}: {
  section: SectionComponent;
  setter: { current: (slug: string) => void };
}) {
  const [slug, setSlug] = useState("p");
  setter.current = setSlug;
  return <Section slug={slug} />;
}

type ProjectCase = {
  name: string;
  section: SectionComponent;
  trigger: (view: SectionView) => void | Promise<void>;
  editWhilePaused: boolean;
  edit?: (view: SectionView) => void;
  expect: (call: Call) => void;
};

/**
 * The 15 `project-settings.tsx` sites, one row each. `editWhilePaused`
 * marks the six rows whose payload comes from form state: without the
 * paused-edit step those rows cannot fail on an unfixed tree, because the
 * form's `useState` does not follow the navigation.
 */
const cases: ProjectCase[] = [
  {
    name: "SlugSection rename",
    section: SlugSection,
    trigger: (view: RenderResult) => {
      const input = view.container.querySelector(
        "input[aria-label='project slug']",
      ) as HTMLInputElement;
      fireEvent.change(input, { target: { value: "zeta" } });
      fireEvent.click(
        view.container.querySelector(
          "button[type=submit]",
        ) as HTMLButtonElement,
      );
    },
    editWhilePaused: true,
    edit: (view: ReturnType<typeof render>) => {
      const input = view.container.querySelector(
        "input[aria-label='project slug']",
      ) as HTMLInputElement;
      fireEvent.change(input, { target: { value: "edited" } });
    },
    expect: (call: Call) => {
      expect(call.url).toContain("/api/projects/p");
      expect(JSON.parse(call.body ?? "{}")).toEqual({ slug: "zeta" });
    },
  },
  {
    name: "ProjectSection save",
    section: ProjectSection,
    trigger: (view) => {
      fireEvent.change(view.getByLabelText("Name"), {
        target: { value: "Renamed on P" },
      });
      fireEvent.click(view.getByRole("button", { name: "Save" }));
    },
    editWhilePaused: true,
    edit: (view) => {
      fireEvent.change(view.getByLabelText("Name"), {
        target: { value: "Edited While Paused" },
      });
    },
    expect: (call) => {
      expect(call.url).toContain("/api/projects/p");
      expect(JSON.parse(call.body ?? "{}")).toEqual({ name: "Renamed on P" });
    },
  },
  {
    name: "ReferencesSection setFormat",
    section: ReferencesSection,
    trigger: (view) => {
      const input = view.container.querySelector(
        "input[aria-label='reference format prefix']",
      ) as HTMLInputElement;
      fireEvent.change(input, { target: { value: "t" } });
      fireEvent.click(view.getByRole("button", { name: "Save" }));
    },
    editWhilePaused: true,
    edit: (view) => {
      const input = view.container.querySelector(
        "input[aria-label='reference format prefix']",
      ) as HTMLInputElement;
      fireEvent.change(input, { target: { value: "edited" } });
    },
    expect: (call) => {
      expect(call.url).toContain("/api/projects/p/references/format");
      expect(JSON.parse(call.body ?? "{}")).toEqual({ prefix: "T" });
    },
  },
  {
    name: "ReferencesSection addAutolink",
    section: ReferencesSection,
    trigger: (view) => {
      const prefixInput = view.container.querySelector(
        "input[aria-label='autolink prefix']",
      ) as HTMLInputElement;
      fireEvent.change(prefixInput, { target: { value: "GH" } });
      fireEvent.change(
        view.container.querySelector(
          "input[aria-label='autolink url template']",
        ) as HTMLInputElement,
        { target: { value: "https://github.com/x/y/<num>" } },
      );
      fireEvent.click(view.getByRole("button", { name: "Add" }));
    },
    editWhilePaused: true,
    edit: (view) => {
      // The prefix input feeds the request body directly, same as the name
      // input in ProjectSection: re-edit it while the write is parked, so a
      // tree that computes the payload on resume sends this instead.
      fireEvent.change(
        view.container.querySelector(
          "input[aria-label='autolink prefix']",
        ) as HTMLInputElement,
        { target: { value: "EDITED" } },
      );
    },
    expect: (call) => {
      expect(call.url).toContain("/api/projects/p/references/autolinks");
      expect(JSON.parse(call.body ?? "{}")).toEqual({
        prefix: "GH",
        url_template: "https://github.com/x/y/<num>",
      });
    },
  },
  {
    name: "ReferencesSection removeAutolink",
    section: ReferencesSection,
    trigger: (view) => {
      fireEvent.click(
        view.container.querySelector(
          "button[aria-label='delete autolink JIRA-']",
        ) as HTMLButtonElement,
      );
    },
    editWhilePaused: false,
    expect: (call) => {
      expect(call.method).toBe("DELETE");
      expect(call.url).toContain("/api/projects/p/references/autolinks/5");
    },
  },
  {
    name: "MembersSection setRole",
    section: MembersSection,
    trigger: async (view) => {
      const roles = view.container.querySelectorAll("button[role=combobox]");
      fireEvent.click(roles[1] as HTMLButtonElement);
      const options = await waitFor(() => {
        const list = document.querySelectorAll("[role=option]");
        expect(list.length).toBeGreaterThan(0);
        return list;
      });
      fireEvent.click(options[options.length - 1] as Element);
    },
    editWhilePaused: false,
    expect: (call) => {
      expect(call.method).toBe("PUT");
      expect(call.url).toContain("/api/projects/p/members/");
    },
  },
  {
    name: "MembersSection remove",
    section: MembersSection,
    trigger: (view) => {
      fireEvent.click(
        view.container.querySelector(
          "button[aria-label='remove bob']",
        ) as HTMLButtonElement,
      );
    },
    editWhilePaused: false,
    expect: (call) => {
      expect(call.method).toBe("DELETE");
      expect(call.url).toContain("/api/projects/p/members/101");
    },
  },
  {
    name: "AccessDenialsSection allow",
    section: AccessDenialsSection,
    trigger: (view) => {
      fireEvent.click(
        view.container.querySelector(
          "button[aria-label='allow bob to ask again']",
        ) as HTMLButtonElement,
      );
    },
    editWhilePaused: false,
    expect: (call) => {
      expect(call.method).toBe("DELETE");
      expect(call.url).toContain("/api/projects/p/access-denials/101");
    },
  },
  {
    name: "StatusesSection create",
    section: StatusesSection,
    trigger: (view) => {
      fireEvent.change(view.getByPlaceholderText("New status name"), {
        target: { value: "in review" },
      });
      fireEvent.click(view.getByRole("button", { name: "Add" }));
    },
    editWhilePaused: true,
    edit: (view) => {
      fireEvent.change(view.getByPlaceholderText("New status name"), {
        target: { value: "Edited While Paused" },
      });
    },
    expect: (call) => {
      expect(call.url).toContain("/api/projects/p/statuses");
      expect(JSON.parse(call.body ?? "{}")).toEqual({
        name: "in review",
        category: "open",
        color: "#6b7280",
      });
    },
  },
  {
    name: "StatusesSection patch",
    section: StatusesSection,
    trigger: (view) => {
      fireEvent.click(
        view.container.querySelector(
          "button[aria-label='make done the default status']",
        ) as HTMLButtonElement,
      );
    },
    editWhilePaused: false,
    expect: (call) => {
      expect(call.method).toBe("PATCH");
      expect(call.url).toContain("/api/projects/p/statuses/2");
      expect(JSON.parse(call.body ?? "{}")).toEqual({ is_default: true });
    },
  },
  {
    name: "StatusesSection remove",
    section: StatusesSection,
    trigger: (view) => {
      fireEvent.click(
        view.container.querySelector(
          "button[aria-label='delete done']",
        ) as HTMLButtonElement,
      );
    },
    editWhilePaused: false,
    expect: (call) => {
      expect(call.method).toBe("DELETE");
      expect(call.url).toContain("/api/projects/p/statuses/2");
    },
  },
  {
    name: "LabelsSection create",
    section: LabelsSection,
    trigger: (view) => {
      fireEvent.change(view.getByPlaceholderText("New label name"), {
        target: { value: "ux" },
      });
      fireEvent.click(view.getByRole("button", { name: "Add" }));
    },
    editWhilePaused: true,
    edit: (view) => {
      fireEvent.change(view.getByPlaceholderText("New label name"), {
        target: { value: "Edited While Paused" },
      });
    },
    expect: (call) => {
      expect(call.url).toContain("/api/projects/p/labels");
      expect(JSON.parse(call.body ?? "{}")).toEqual({
        name: "ux",
        color: "#3b82f6",
      });
    },
  },
  {
    name: "LabelsSection remove",
    section: LabelsSection,
    trigger: (view) => {
      fireEvent.click(
        view.container.querySelector(
          "button[aria-label='delete label bug']",
        ) as HTMLButtonElement,
      );
    },
    editWhilePaused: false,
    expect: (call) => {
      expect(call.method).toBe("DELETE");
      expect(call.url).toContain("/api/projects/p/labels/3");
    },
  },
  {
    name: "LabelsSection recolor",
    section: LabelsSection,
    trigger: (view) => {
      fireEvent.click(
        view.container.querySelector(
          "button[aria-label='change bug color']",
        ) as HTMLButtonElement,
      );
      const swatch = document.querySelector(
        "button[aria-label='set bug color #22c55e']",
      );
      expect(swatch).not.toBeNull();
      fireEvent.click(swatch as Element);
    },
    editWhilePaused: false,
    expect: (call) => {
      expect(call.method).toBe("PATCH");
      expect(call.url).toContain("/api/projects/p/labels/3");
      expect(JSON.parse(call.body ?? "{}")).toEqual({ color: "#22c55e" });
    },
  },
  {
    name: "LabelsSection rename",
    section: LabelsSection,
    trigger: (view) => {
      fireEvent.click(
        view.container.querySelector(
          "button[aria-label='rename label bug']",
        ) as HTMLButtonElement,
      );
      const input = view.container.querySelector(
        "input[aria-label='new name for bug']",
      ) as HTMLInputElement;
      fireEvent.change(input, { target: { value: "regression" } });
      fireEvent.click(
        view.container.querySelector(
          "button[aria-label='save name for bug']",
        ) as HTMLButtonElement,
      );
    },
    editWhilePaused: false,
    expect: (call) => {
      expect(call.method).toBe("PATCH");
      expect(call.url).toContain("/api/projects/p/labels/3");
      expect(JSON.parse(call.body ?? "{}")).toEqual({ name: "regression" });
    },
  },
];

describe("a project write the settings page then left", () => {
  it.each(cases)("$name keeps the paused write on p", async (c) => {
    const calls = stubFetch();
    const client = queryClient();
    seed(client);
    // Through the router shim: the user chips these sections render are links
    // now (T-391), and a link needs router context to resolve its href.
    const setSlug = { current: (_: string) => {} };
    const view = renderWithProviders(
      <SlugHarness section={c.section} setter={setSlug} />,
      client,
    );
    // The section suspends until its queries resolve; wait for the form.
    await waitFor(() =>
      expect(view.container.querySelector("input, button")).not.toBeNull(),
    );

    // Go offline first, then click: the retryer parks the write before the
    // request function ever runs.
    onlineManager.setOnline(false);
    await c.trigger(view);
    await letTheLoopRun();
    expect(writeCalls(calls).length).toBe(0);

    // The page leaves for project q: the route slug (and so the prop this
    // section would receive on the real page) changes while the component
    // stays mounted — a re-render, not a remount.
    act(() => setSlug.current("q"));
    if (c.editWhilePaused) c.edit?.(view);
    await act(async () => {
      onlineManager.setOnline(true);
      await Promise.resolve();
      await Promise.resolve();
    });

    await waitFor(() => expect(writeCalls(calls).length).toBeGreaterThan(0));
    c.expect(writeCalls(calls)[0] as Call);
  });
});

async function letTheLoopRun() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

/**
 * The six mutation hooks whose target used to be a hook parameter. The
 * props swap is a `rerender` — the same re-render a route-param change
 * produces on the real page.
 */
describe("a project write the hook then left", () => {
  it("useIssueStatusMutation resumes onto p", async () => {
    const calls = stubFetch();
    const client = queryClient();
    const statuses: Status[] = [
      {
        id: 1,
        name: "open",
        category: "open",
        color: "#6b7280",
        position: 1,
        is_default: true,
      },
    ];
    client.setQueryData(["issues", "p"], {
      items: [
        {
          id: 7,
          number: 7,
          title: "Card 7",
          status: statuses[0],
          labels: [],
        },
      ],
      next_cursor: null,
    } as unknown as IssueListPage);
    const hook = renderHook(() => useIssueStatusMutation(), {
      wrapper: wrapperFor(client),
    });

    onlineManager.setOnline(false);
    act(() =>
      hook.result.current.mutate({
        slug: "p",
        issueNumber: 7,
        status: statuses[0],
      }),
    );
    await letTheLoopRun();
    expect(writeCalls(calls).length).toBe(0);

    hook.rerender({ slug: "q" });
    await act(async () => {
      onlineManager.setOnline(true);
      await Promise.resolve();
      await Promise.resolve();
    });
    await waitFor(() => expect(writeCalls(calls).length).toBeGreaterThan(0));
    expect(writeCalls(calls)[0]?.url).toContain("/api/projects/p/issues/7");
  });

  it("useDeleteIssueMutation resumes onto p", async () => {
    const calls = stubFetch();
    const hook = renderHook(() => useDeleteIssueMutation(), {
      wrapper: wrapperFor(queryClient()),
    });

    onlineManager.setOnline(false);
    act(() => hook.result.current.mutate({ slug: "p", issueNumber: 7 }));
    await letTheLoopRun();
    expect(writeCalls(calls).length).toBe(0);

    await act(async () => {
      onlineManager.setOnline(true);
      await Promise.resolve();
      await Promise.resolve();
    });
    await waitFor(() => expect(writeCalls(calls).length).toBeGreaterThan(0));
    expect(writeCalls(calls)[0]?.method).toBe("DELETE");
    expect(writeCalls(calls)[0]?.url).toContain("/api/projects/p/issues/7");
  });

  it("useRestoreIssueMutation resumes onto p", async () => {
    const calls = stubFetch();
    const hook = renderHook(() => useRestoreIssueMutation(), {
      wrapper: wrapperFor(queryClient()),
    });

    onlineManager.setOnline(false);
    act(() => hook.result.current.mutate({ slug: "p", issueNumber: 7 }));
    await letTheLoopRun();
    expect(writeCalls(calls).length).toBe(0);

    await act(async () => {
      onlineManager.setOnline(true);
      await Promise.resolve();
      await Promise.resolve();
    });
    await waitFor(() => expect(writeCalls(calls).length).toBeGreaterThan(0));
    expect(writeCalls(calls)[0]?.method).toBe("POST");
    expect(writeCalls(calls)[0]?.url).toContain(
      "/api/projects/p/issues/7/restore",
    );
  });

  it("useMoveIssueMutation resumes onto p", async () => {
    const calls = stubFetch();
    const hook = renderHook(() => useMoveIssueMutation(), {
      wrapper: wrapperFor(queryClient()),
    });

    onlineManager.setOnline(false);
    act(() =>
      hook.result.current.mutate({
        slug: "p",
        issueNumber: 7,
        toProject: "q",
      }),
    );
    await letTheLoopRun();
    expect(writeCalls(calls).length).toBe(0);

    await act(async () => {
      onlineManager.setOnline(true);
      await Promise.resolve();
      await Promise.resolve();
    });
    await waitFor(() => expect(writeCalls(calls).length).toBeGreaterThan(0));
    expect(writeCalls(calls)[0]?.url).toContain(
      "/api/projects/p/issues/7/move",
    );
  });

  it("useIssueLabelsMutation resumes onto p", async () => {
    const calls = stubFetch();
    const hook = renderHook(() => useIssueLabelsMutation(), {
      wrapper: wrapperFor(queryClient()),
    });

    onlineManager.setOnline(false);
    act(() =>
      hook.result.current.mutate({ slug: "p", issueNumber: 7, labelIds: [3] }),
    );
    await letTheLoopRun();
    expect(writeCalls(calls).length).toBe(0);

    await act(async () => {
      onlineManager.setOnline(true);
      await Promise.resolve();
      await Promise.resolve();
    });
    await waitFor(() => expect(writeCalls(calls).length).toBeGreaterThan(0));
    expect(writeCalls(calls)[0]?.url).toContain("/api/projects/p/issues/7");
  });

  it("useBoardMove resumes onto p", async () => {
    const calls = stubFetch();
    const statuses: Status[] = [
      {
        id: 1,
        name: "open",
        category: "open",
        color: "#6b7280",
        position: 1,
        is_default: true,
      },
      {
        id: 2,
        name: "done",
        category: "closed",
        color: "#6b7280",
        position: 2,
        is_default: false,
      },
    ];
    const hook = renderHook(() => useBoardMove(), {
      wrapper: wrapperFor(queryClient()),
    });

    onlineManager.setOnline(false);
    act(() =>
      hook.result.current.mutate({
        slug: "p",
        issueNumber: 7,
        fromStatusId: 1,
        toStatus: statuses[1],
      }),
    );
    await letTheLoopRun();
    expect(writeCalls(calls).length).toBe(0);

    await act(async () => {
      onlineManager.setOnline(true);
      await Promise.resolve();
      await Promise.resolve();
    });
    await waitFor(() => expect(writeCalls(calls).length).toBeGreaterThan(0));
    expect(writeCalls(calls)[0]?.url).toContain("/api/projects/p/issues/7");
  });
});

const reviewDraft: SpecReviewDraft = {
  id: "d1",
  anchor: {
    path: "design.md",
    version: 3,
    line_start: 3,
    line_end: 4,
    col_start: null,
    col_end: null,
  },
  quote: "…",
  body: "Which diff library?",
};

const specInfo = {
  current_version: 3,
  current_version_cursor: "cv3",
  review_status: "unreviewed",
  unresolved_comments: 0,
  unresolved_carried_comments: 0,
  files: [{ path: "design.md", size: 10 }],
  versions: [
    {
      number: 3,
      // A different account pushed the version: the dialog disables both
      // verdicts for the pusher, and a disabled click would be a no-op.
      author: { ...bob, kind: "machine" as const, owner: null },
      message: null,
      created_at: "2026-09-07T00:00:00.000Z",
    },
  ],
};

/**
 * Props the page hands the dialog. `ReviewDialog` plus a rerender drive the
 * same re-render a route-param change produces: the component stays
 * mounted, only the props move — that is the moving part a closure-reading
 * target would follow.
 */
const reviewProps = { slug: "p", issueNumber: 23 };

function ReviewDialog() {
  return (
    <ReviewSubmitDialog
      slug={reviewProps.slug}
      issueNumber={reviewProps.issueNumber}
      currentVersion={3}
      drafts={[reviewDraft]}
      open
      onClose={() => {}}
      onSubmitted={() => {}}
    />
  );
}

let currentReviewClient: QueryClient;

function reviewView(): RenderResult {
  const client = queryClient();
  currentReviewClient = client;
  client.setQueryData(meQuery.queryKey, me);
  return render(
    <QueryClientProvider client={client}>
      <ReviewDialog />
    </QueryClientProvider>,
  );
}

describe("a review submit the dialog then left", () => {
  /** Answers /me and /spec; records everything else as a write. */
  function stubReviewFetch(): Call[] {
    const calls: Call[] = [];
    vi.stubGlobal("fetch", (async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      const call: Call = {
        url,
        method: init?.method,
        body: init?.body === undefined ? undefined : String(init.body),
      };
      calls.push(call);
      if (url.endsWith("/api/me")) return Response.json(me);
      if (url.endsWith("/spec")) {
        return Response.json(specInfo);
      }
      return Response.json({});
    }) as typeof fetch);
    return calls;
  }

  it("posts the verdict onto the issue the dialog opened on", async () => {
    const calls = stubReviewFetch();
    const view = reviewView();
    const requestChanges = await view.findByRole("button", {
      name: "Request changes",
    });
    await waitFor(() =>
      expect((requestChanges as HTMLButtonElement).disabled).toBe(false),
    );

    onlineManager.setOnline(false);
    fireEvent.click(requestChanges);
    await letTheLoopRun();
    expect(writeCalls(calls).length).toBe(0);

    // Park the write, then leave for another issue the way the page does:
    // same component, next props.
    reviewProps.slug = "q";
    reviewProps.issueNumber = 77;
    view.rerender(
      <QueryClientProvider client={currentReviewClient}>
        <ReviewDialog />
      </QueryClientProvider>,
    );

    await act(async () => {
      onlineManager.setOnline(true);
      await Promise.resolve();
      await Promise.resolve();
    });
    await waitFor(() => expect(writeCalls(calls).length).toBeGreaterThan(0));
    expect(writeCalls(calls)[0]?.url).toContain(
      "/api/projects/p/issues/23/spec/reviews",
    );
  });

  it("carries the summary the reviewer submitted, not a later one", async () => {
    const calls = stubReviewFetch();
    const view = reviewView();
    const requestChanges = await view.findByRole("button", {
      name: "Request changes",
    });
    await waitFor(() =>
      expect((requestChanges as HTMLButtonElement).disabled).toBe(false),
    );
    cmSetValue(view.baseElement, "overall fine");

    onlineManager.setOnline(false);
    fireEvent.click(requestChanges);
    await letTheLoopRun();
    expect(writeCalls(calls).length).toBe(0);
    cmSetValue(view.baseElement, "Edited While Paused");
    // Flush the document change into React state before the write resumes:
    // a same-tick release would read the pre-edit state.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      onlineManager.setOnline(true);
      await Promise.resolve();
      await Promise.resolve();
    });
    await waitFor(() => expect(writeCalls(calls).length).toBeGreaterThan(0));
    const submitted = JSON.parse(writeCalls(calls)[0]?.body ?? "{}");
    expect(submitted.body).toBe("overall fine");
  });
});

/**
 * The rename's success redirect follows the write: it may only fire while
 * the page still shows the project that was renamed. The write is parked
 * offline across the navigation, and the conditional inside `onSuccess`
 * decides.
 */
describe("the rename redirect", () => {
  it("does not yank the reader back to the renamed project", async () => {
    const calls = stubFetch();
    const client = queryClient();
    seed(client);
    // The section reads the route's own slug, exactly as the page does.
    function SettingsAt() {
      const { slug } = useParams({ from: "/authed/projects/$slug" });
      return <SlugSection slug={slug} />;
    }

    const rootRoute = createRootRoute();
    const authedRoute = createRoute({
      getParentRoute: () => rootRoute,
      id: "authed",
    });
    const projectRoute = createRoute({
      getParentRoute: () => authedRoute,
      path: "/projects/$slug",
    });
    const settingsRoute = createRoute({
      getParentRoute: () => projectRoute,
      path: "settings",
      component: SettingsAt,
    });
    const router = createRouter({
      routeTree: rootRoute.addChildren([
        authedRoute.addChildren([projectRoute.addChildren([settingsRoute])]),
      ]),
      history: createMemoryHistory({
        initialEntries: ["/projects/p/settings"],
      }),
    });
    render(
      <QueryClientProvider client={client}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(document.querySelector("input")).not.toBeNull());

    // Park the rename offline, then leave p while the write is in flight.
    const input = document.querySelector(
      "input[aria-label='project slug']",
    ) as HTMLInputElement;
    onlineManager.setOnline(false);
    fireEvent.change(input, { target: { value: "zeta" } });
    fireEvent.click(
      document.querySelector("button[type=submit]") as HTMLButtonElement,
    );
    await letTheLoopRun();
    expect(writeCalls(calls).length).toBe(0);

    act(() => {
      router.navigate({
        to: "/projects/$slug/settings",
        params: { slug: "q" },
      });
    });
    expect(router.state.location.href).toBe("/projects/q/settings");
    // Let the re-render with slug="q" commit before the write resumes: the
    // guard reads the latest closure, and a same-tick resume would race it.
    await act(async () => {
      await Promise.resolve();
    });

    // The write resumes while the page is on q: the section's slug prop is
    // now q, the write named p, and the guard must keep the reader on q.
    await act(async () => {
      onlineManager.setOnline(true);
      await Promise.resolve();
      await Promise.resolve();
      await new Promise((r) => setTimeout(r, 50));
    });
    expect(writeCalls(calls).length).toBeGreaterThan(0);
    expect(router.state.location.href).toBe("/projects/q/settings");
  });
});

function wrapperFor(client: QueryClient) {
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
}
