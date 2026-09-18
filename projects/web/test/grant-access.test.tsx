import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import type {
  Agent,
  Me,
  Member,
  Project,
  ReferenceDirectory,
} from "@todou/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  agentsQuery,
  api,
  meQuery,
  projectsQuery,
} from "../src/api/queries.ts";
import { referenceDirectoryQuery } from "../src/api/references.ts";
import { resolveGrantTarget } from "../src/lib/grant-target.ts";
import {
  GrantAccessCard,
  GrantAccessPage,
  type GrantSearch,
  grantFailure,
  parseGrantSearch,
  readReason,
} from "../src/pages/grant-access.tsx";
import { renderWithProviders, testQueryClient } from "./render.tsx";

const SINCE = "2026-01-01T00:00:00.000Z";
const NOW = "2026-06-01T00:00:00.000Z";

const me: Me = {
  id: 1,
  login: "alice",
  display_name: "Alice",
  kind: "human",
  avatar_url: null,
  owner: null,
  email: null,
  is_instance_admin: false,
  created_at: SINCE,
};

function agent(id: number, login: string): Agent {
  return {
    id,
    login,
    display_name: `Agent ${id}`,
    kind: "machine",
    avatar_url: null,
    owner: { id: 1, login: "alice" },
    email: null,
    is_instance_admin: false,
    created_at: SINCE,
    disabled_at: null,
  };
}

/** `mine` is alice's to administer; `theirs` is only readable. */
const PROJECTS = [
  { id: 7, slug: "mine", name: "Mine" },
  { id: 8, slug: "theirs", name: "Theirs" },
];

const DIRECTORY: ReferenceDirectory = {
  entries: [
    { prefix: "MI", slug: "mine", from: SINCE, to: null },
    { prefix: "TH", slug: "theirs", from: SINCE, to: null },
  ],
  contested: [],
  slug_entries: [
    { slug: "mine", canonical: "mine", from: SINCE, to: null },
    { slug: "theirs", canonical: "theirs", from: SINCE, to: null },
    // `mine` used to be called `old-mine`, so that spelling still points here.
    { slug: "old-mine", canonical: "mine", from: SINCE, to: null },
  ],
};

const memberRow = (
  user: { id: number; login: string },
  role: "admin" | "writer" | "reader",
): Member => ({
  user: {
    id: user.id,
    login: user.login,
    display_name: user.login,
    kind: user.id === 1 ? "human" : "machine",
    avatar_url: null,
    owner: user.id === 1 ? null : { id: 1, login: "alice" },
  },
  role,
  created_at: SINCE,
});

type Call = { url: string; method: string; body?: string };

/**
 * Member lists per project, everything else a 404. Unmatched writes are
 * captured rather than answered generously: a test that asserts on a request
 * must fail when the request never happens.
 */
function stubFetch(): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    calls.push({
      url,
      method: init?.method ?? "GET",
      body: init?.body === undefined ? undefined : String(init.body),
    });
    const members: Record<string, unknown[]> = {
      mine: [
        memberRow(me, "admin"),
        memberRow({ id: 5, login: "bot" }, "reader"),
      ],
      theirs: [
        memberRow(me, "reader"),
        memberRow({ id: 2, login: "keeper" }, "admin"),
      ],
    };
    const list = /\/api\/projects\/([^/]+)\/members$/.exec(url)?.[1];
    if (list !== undefined && members[list] !== undefined) {
      return new Response(JSON.stringify(members[list]), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(null, { status: 204 });
  }) as typeof fetch);
  return calls;
}

function renderCard(
  search: GrantSearch,
  opts: { agents?: Agent[]; reason?: string | null } = {},
) {
  return renderWithProviders(
    <GrantAccessCard
      search={search}
      reason={opts.reason ?? null}
      me={me}
      agents={opts.agents ?? [agent(5, "bot")]}
      projects={PROJECTS}
      directory={DIRECTORY}
    />,
  );
}

function withResolvers<T>() {
  const promiseConstructor = Promise as unknown as {
    withResolvers<U>(): {
      promise: Promise<U>;
      resolve: (value: U | PromiseLike<U>) => void;
      reject: (reason?: unknown) => void;
    };
  };
  return promiseConstructor.withResolvers<T>();
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("resolveGrantTarget", () => {
  const ctx = { projects: PROJECTS, directory: DIRECTORY, at: NOW };

  it("takes every spelling of a readable project to its slug", () => {
    for (const [target, slug] of [
      ["mine", "mine"],
      // A retired slug still points at whoever holds it now.
      ["old-mine", "mine"],
      ["7", "mine"],
      ["MI-158", "mine"],
      ["mine/158", "mine"],
      ["theirs", "theirs"],
    ] as const) {
      expect([target, resolveGrantTarget(target, ctx)]).toEqual([
        target,
        { kind: "one", slug },
      ]);
    }
  });

  it("offers both when two readable projects hold one prefix", () => {
    const both: ReferenceDirectory = {
      ...DIRECTORY,
      entries: [
        { prefix: "M", slug: "mine", from: SINCE, to: null },
        { prefix: "M", slug: "theirs", from: SINCE, to: null },
      ],
    };
    expect(resolveGrantTarget("M-1", { ...ctx, directory: both })).toEqual({
      kind: "several",
      slugs: ["mine", "theirs"],
    });
  });

  it("says nothing about a project outside the viewer's reach", () => {
    // The same answer as a name nobody holds — which is the whole point.
    for (const target of ["hidden", "HID-1", "hidden/1", "99", ""]) {
      expect([target, resolveGrantTarget(target, ctx)]).toEqual([
        target,
        { kind: "none" },
      ]);
    }
  });

  it("resolves nothing at all without a directory", () => {
    // A live slug still answers: it comes from the project list, not the
    // cross-project grammar, which stays shut exactly as it does elsewhere.
    const shut = { ...ctx, directory: null };
    expect(resolveGrantTarget("mine", shut)).toEqual({
      kind: "one",
      slug: "mine",
    });
    expect(resolveGrantTarget("MI-1", shut)).toEqual({ kind: "none" });
    expect(resolveGrantTarget("old-mine", shut)).toEqual({ kind: "none" });
  });
});

describe("parseGrantSearch", () => {
  it("puts the router's coerced values back to strings", () => {
    // `?target=41` arrives as a number and `?target=true` as a boolean.
    expect(parseGrantSearch({ target: 41 }).targets).toEqual(["41"]);
    expect(parseGrantSearch({ target: true }).targets).toEqual(["true"]);
  });

  it("takes several targets, deduped, and ignores a broken uid", () => {
    expect(
      parseGrantSearch({ target: ["a", "b", "a"], login: "bot", uid: "x" }),
    ).toEqual({ targets: ["a", "b"], login: "bot" });
    expect(parseGrantSearch({ target: "a", uid: 41 }).uid).toBe(41);
  });
});

describe("readReason", () => {
  it("reads the fragment, and nothing when there is none", () => {
    expect(readReason("#reason=needs%20the%20board")).toBe("needs the board");
    expect(readReason("")).toBeNull();
    expect(readReason("#reason=%20%20")).toBeNull();
  });
});

describe("the access page as an admin of the target", () => {
  it("names the project and offers a role, a grant and a decline", async () => {
    stubFetch();
    renderCard({ targets: ["mine"], login: "bot", uid: 5 });
    expect(await screen.findByText("Mine")).toBeTruthy();
    expect(await screen.findByLabelText("role in mine")).not.toBeNull();
    expect(screen.getByRole("button", { name: "Decline" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Add to project" })).toBeTruthy();
  });

  it("grants to the account picked here, never to the uid in the URL", async () => {
    const calls = stubFetch();
    // Two agents, so nothing is preselected and the choice has to be made.
    renderCard(
      { targets: ["mine"], login: "nobody-here", uid: 999 },
      { agents: [agent(5, "bot"), agent(6, "other")] },
    );
    const add = await screen.findByRole("button", { name: "Add to project" });
    expect(add.hasAttribute("disabled")).toBe(true);

    fireEvent.click(await screen.findByLabelText("Agent 6 @other"));
    // Agent 6 is no member of `mine`, so the row falls back to the default.
    const role = await screen.findByLabelText("role in mine");
    expect(role).not.toBeNull();
    await waitFor(() => expect(role.textContent).toContain("writer"));
    fireEvent.click(screen.getByRole("button", { name: "Add to project" }));
    await waitFor(() =>
      expect(calls.some((c) => c.method === "PUT")).toBe(true),
    );
    const put = calls.find((c) => c.method === "PUT");
    expect(put?.url).toContain("/api/projects/mine/members/6");
    expect(put?.url).not.toContain("999");
  });

  it("declines against the uid in the URL, which the opener may not own", async () => {
    const calls = stubFetch();
    renderCard({ targets: ["mine"], login: "bot", uid: 41 });
    fireEvent.click(await screen.findByRole("button", { name: "Decline" }));
    await waitFor(() =>
      expect(calls.some((c) => c.method === "PUT")).toBe(true),
    );
    expect(calls.find((c) => c.method === "PUT")?.url).toContain(
      "/api/projects/mine/access-denials/41",
    );
  });

  it("starts the role at what that account already holds", async () => {
    stubFetch();
    // `bot` is a reader of `mine`; this is the 403 path, where the point is
    // to raise a role rather than to add a member.
    renderCard({ targets: ["mine"], login: "bot", uid: 5 });
    const role = await screen.findByLabelText("role in mine");
    expect(role).not.toBeNull();
    await waitFor(() => expect(role.textContent).toContain("reader"));
  });
});

describe("who the access page may grant to", () => {
  it("never offers the opener themselves, not even when the link names them", async () => {
    stubFetch();
    // `alice` is the opener's own login, so this is the link that used to
    // preselect the yourself row.
    renderCard({ targets: ["mine"], login: "alice", uid: 1 });
    expect(await screen.findByLabelText("Agent 5 @bot")).not.toBeNull();
    expect(screen.queryByRole("radio", { name: /yourself/ })).toBeNull();
    expect(screen.getAllByRole("radio")).toHaveLength(1);
  });

  it("writes to the agent, and to no account of the opener's own", async () => {
    const calls = stubFetch();
    renderCard({ targets: ["mine"], login: "alice", uid: 1 });
    // The sole agent is preselected, so the grant is one click away.
    const add = await screen.findByRole("button", { name: "Add to project" });
    await waitFor(() => expect(add.hasAttribute("disabled")).toBe(false));
    fireEvent.click(add);
    await waitFor(() =>
      expect(calls.some((c) => c.method === "PUT")).toBe(true),
    );
    expect(calls.find((c) => c.method === "PUT")?.url).toContain(
      "/api/projects/mine/members/5",
    );
    // `me.id` is 1, and no request anywhere in the run is addressed to it.
    expect(calls.some((c) => c.url.includes("/members/1"))).toBe(false);
  });

  it("says how to get an agent instead of showing an empty box", async () => {
    stubFetch();
    renderCard({ targets: ["mine"], login: "alice", uid: 1 }, { agents: [] });
    const link = await screen.findByRole("link", { name: "create an agent" });
    expect(link.getAttribute("href")).toContain("/settings/agents");
    expect(screen.queryAllByRole("radio")).toHaveLength(0);
    expect(
      screen
        .getByRole("button", { name: "Add to project" })
        .hasAttribute("disabled"),
    ).toBe(true);
  });

  it("points at reactivation when every agent the opener owns is off", async () => {
    stubFetch();
    renderCard(
      { targets: ["mine"], login: "alice", uid: 1 },
      { agents: [{ ...agent(5, "bot"), disabled_at: SINCE }] },
    );
    const link = await screen.findByRole("link", { name: "reactivate one" });
    expect(link.getAttribute("href")).toContain("state=deactivated");
    expect(screen.queryAllByRole("radio")).toHaveLength(0);
    expect(
      screen
        .getByRole("button", { name: "Add to project" })
        .hasAttribute("disabled"),
    ).toBe(true);
  });
});

describe("the access page on an ambiguous target", () => {
  it("waits for the opener to say which project it means", async () => {
    stubFetch();
    renderWithProviders(
      <GrantAccessCard
        search={{ targets: ["M-1"], login: "bot", uid: 5 }}
        reason={null}
        me={me}
        agents={[agent(5, "bot")]}
        projects={PROJECTS}
        directory={{
          ...DIRECTORY,
          entries: [
            { prefix: "M", slug: "mine", from: SINCE, to: null },
            { prefix: "M", slug: "theirs", from: SINCE, to: null },
          ],
        }}
      />,
    );
    expect(await screen.findByText(/pick the one it means/)).toBeTruthy();
    // Nothing to act on until then.
    expect(screen.queryByRole("button", { name: "Add to project" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "mine" }));
    expect(
      await screen.findByRole("button", { name: "Add to project" }),
    ).toBeTruthy();
    expect(await screen.findByLabelText("role in mine")).not.toBeNull();
  });
});

describe("the access page without admin of the target", () => {
  it("says so, names who to ask, and still offers a decline", async () => {
    stubFetch();
    renderCard({ targets: ["theirs"], login: "bot", uid: 5 });
    expect(
      await screen.findByText(/You are not an admin of Theirs/),
    ).toBeTruthy();
    expect(await screen.findByText("keeper")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Decline" })).toBeTruthy();
    // No role to set, and nothing to add: the grant half is absent entirely.
    expect(screen.queryByLabelText("role in theirs")).toBeNull();
    expect(screen.queryByRole("button", { name: "Add to project" })).toBeNull();
  });

  // "Ask one of these people" is only useful if you can reach them, and the
  // opener shares this project with every admin named here, so the page
  // resolves (T-391). Scoped to that sentence: the rest of the card carries
  // chips of its own.
  it("makes each admin it names reachable", async () => {
    stubFetch();
    renderCard({ targets: ["theirs"], login: "bot", uid: 5 });
    // Wait on the admin's own name: the sentence renders before the member
    // list arrives, so the paragraph alone is not yet the thing to measure.
    const sentence = (await screen.findByText("keeper")).closest(
      "p",
    ) as HTMLElement;

    expect(
      [...sentence.querySelectorAll('a[href^="/users/"]')].map((a) =>
        a.getAttribute("href"),
      ),
    ).toEqual(["/users/keeper"]);
  });
});

describe("the access page on a target it cannot see", () => {
  it("says the same thing whether or not the project exists", async () => {
    stubFetch();
    renderCard({ targets: ["hidden", "definitely-not-a-project"], uid: 5 });
    const rows = await screen.findAllByText(
      /No project you can read answers to this/,
    );
    expect(rows).toHaveLength(2);
    // Byte-for-byte, because the difference between the two is the leak.
    expect(rows[0]?.textContent).toBe(rows[1]?.textContent);
  });

  it("offers no decline, which would name a project", async () => {
    stubFetch();
    renderCard({ targets: ["hidden"], login: "bot", uid: 5 });
    expect(
      await screen.findByText(/No project you can read answers to this/),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Decline" })).toBeNull();
  });
});

describe("the reason the requester attached", () => {
  it("shows it literally, marked unverified, with no markup of its own", async () => {
    stubFetch();
    const reason = "**urgent** <b>now</b> [link](http://evil.test)";
    renderCard({ targets: ["mine"], login: "bot", uid: 5 }, { reason });
    const shown = await screen.findByText(reason);
    expect(shown).not.toBeNull();
    // Rendered as text: no element the markup would have produced exists.
    expect(shown.querySelector("b")).toBeNull();
    expect(shown.querySelector("strong")).toBeNull();
    expect(shown.querySelector("a")).toBeNull();
    expect(screen.getByText(/not verified/)).toBeTruthy();
  });
});

describe("the refusal Grant can now walk into (T-340)", () => {
  it("names the project and what to do about it", () => {
    const message = grantFailure(
      "acme",
      new Error(
        "the owner of this machine, @bob, is not a member of this project — add them first",
      ),
    );

    // The server knows the owner but not which project was being written,
    // and Grant writes several in a row — so the slug has to come back in.
    expect(message).toContain("acme");
    expect(message).toContain("@bob");
    expect(message).toContain("add @bob");
  });

  it("passes any other failure through, still naming the project", () => {
    expect(grantFailure("acme", new Error("requires admin role"))).toBe(
      "acme: requires admin role",
    );
  });
});

const PAGE_PROJECTS: Project[] = PROJECTS.map((project) => ({
  ...project,
  description: "",
  created_at: SINCE,
}));

function renderPage({
  cached = false,
  projectsFailure,
  directoryFailure,
}: {
  cached?: boolean;
  projectsFailure?: Error;
  directoryFailure?: Error;
} = {}) {
  const getMe = vi.spyOn(api, "me").mockResolvedValue(me);
  const getAgents = vi
    .spyOn(api, "listAgents")
    .mockResolvedValue([agent(5, "bot")]);
  const getProjects = vi
    .spyOn(api, "listProjects")
    .mockResolvedValue(PAGE_PROJECTS);
  const getDirectory = vi
    .spyOn(api, "getReferenceDirectory")
    .mockResolvedValue(DIRECTORY);
  const getMembers = vi
    .spyOn(api, "listMembers")
    .mockImplementation(async (slug) => {
      if (slug === "mine")
        return [
          memberRow(me, "admin"),
          memberRow({ id: 5, login: "bot" }, "reader"),
        ];
      if (slug === "theirs") return [memberRow(me, "reader")];
      throw new Error(`Unexpected members request for ${slug}`);
    });
  if (projectsFailure) getProjects.mockRejectedValueOnce(projectsFailure);
  if (directoryFailure) getDirectory.mockRejectedValueOnce(directoryFailure);

  const client = testQueryClient();
  if (cached) {
    client.setQueryData(meQuery.queryKey, me);
    client.setQueryData(agentsQuery.queryKey, [agent(5, "bot")]);
    client.setQueryData(projectsQuery.queryKey, PAGE_PROJECTS);
    client.setQueryData(referenceDirectoryQuery.queryKey, DIRECTORY);
  }
  const view = renderWithProviders(<GrantAccessPage />, client, {
    initialEntry: "/?target=mine&login=bot",
  });
  return {
    ...view,
    client,
    getMe,
    getAgents,
    getProjects,
    getDirectory,
    getMembers,
  };
}

describe("GrantAccessPage · saved core data", () => {
  it("keeps the concrete project card on a 500 refresh and Retry replaces it with fresh data", async () => {
    const { client, getMe, getAgents, getProjects, getDirectory, getMembers } =
      renderPage({ cached: true });
    expect(
      await screen.findByRole("checkbox", { name: "include mine" }),
    ).toBeTruthy();
    expect(screen.getByText("Mine")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Add to project" })).toBeTruthy();
    expect(getMembers).toHaveBeenCalledWith("mine");

    getProjects.mockRejectedValueOnce(
      Object.assign(new Error("projects unavailable"), { status: 500 }),
    );
    await act(async () => {
      await client.refetchQueries({ queryKey: projectsQuery.queryKey });
    });
    const notice = await screen.findByText(/Couldn't refresh your projects/);
    expect(notice.textContent).toContain("projects unavailable");
    expect(screen.getByText("Mine")).toBeTruthy();
    expect(screen.getByRole("checkbox", { name: "include mine" })).toBeTruthy();
    expect(screen.queryByText(/Could not load your projects/)).toBeNull();

    const updated = withResolvers<Project[]>();
    getProjects.mockReturnValueOnce(updated.promise);
    const directoryCalls = getDirectory.mock.calls.length;
    const meCalls = getMe.mock.calls.length;
    const agentCalls = getAgents.mock.calls.length;
    const projectCalls = getProjects.mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() =>
      expect(getProjects).toHaveBeenCalledTimes(projectCalls + 1),
    );
    expect(getMe.mock.calls.length).toBeGreaterThan(meCalls);
    expect(getAgents.mock.calls.length).toBeGreaterThan(agentCalls);
    expect(getDirectory).toHaveBeenCalledTimes(directoryCalls);
    await act(async () => {
      updated.resolve(
        PAGE_PROJECTS.map((project) =>
          project.slug === "mine"
            ? { ...project, name: "Mine after retry" }
            : project,
        ),
      );
    });
    expect(await screen.findByText("Mine after retry")).toBeTruthy();
    expect(screen.queryByText("Mine")).toBeNull();
    expect(screen.queryByText(/Couldn't refresh your projects/)).toBeNull();
  });

  it("lets a projects 403 replace cache even when me also failed with 500", async () => {
    const { client, getMe, getProjects } = renderPage({ cached: true });
    await screen.findByRole("checkbox", { name: "include mine" });
    expect(screen.getByText("Mine")).toBeTruthy();
    getMe.mockRejectedValue(
      Object.assign(new Error("me temporarily unavailable"), { status: 500 }),
    );
    getProjects.mockRejectedValue(
      Object.assign(new Error("projects forbidden"), { status: 403 }),
    );

    await act(async () => {
      await Promise.all([
        client.refetchQueries({ queryKey: meQuery.queryKey, exact: true }),
        client.refetchQueries({
          queryKey: projectsQuery.queryKey,
          exact: true,
        }),
      ]);
    });
    await waitFor(() => {
      expect(client.getQueryState(meQuery.queryKey)?.status).toBe("error");
      expect(client.getQueryState(projectsQuery.queryKey)?.status).toBe(
        "error",
      );
    });
    await screen.findByText("Could not load your projects: projects forbidden");
    expect(screen.queryByText("Mine")).toBeNull();
    expect(screen.queryByText(/Couldn't refresh your projects/)).toBeNull();
  });

  it("keeps a cold 500 LoadFailure during a deferred Retry, then shows the fetched card", async () => {
    const { getProjects, getMembers } = renderPage({
      projectsFailure: Object.assign(new Error("projects unavailable"), {
        status: 500,
      }),
    });
    expect(
      await screen.findByText(
        /Could not load your projects: projects unavailable/,
      ),
    ).toBeTruthy();
    expect(screen.queryByText("Mine")).toBeNull();

    const recovered = withResolvers<Project[]>();
    getProjects.mockReturnValueOnce(recovered.promise);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() =>
      expect(
        (screen.getByRole("button", { name: "Retry" }) as HTMLButtonElement)
          .disabled,
      ).toBe(true),
    );
    expect(
      screen.getByText(/Could not load your projects: projects unavailable/),
    ).toBeTruthy();
    await act(async () => {
      recovered.resolve(
        PAGE_PROJECTS.map((project) =>
          project.slug === "mine"
            ? { ...project, name: "Recovered Mine" }
            : project,
        ),
      );
    });
    expect(await screen.findByText("Recovered Mine")).toBeTruthy();
    expect(
      await screen.findByRole("checkbox", { name: "include mine" }),
    ).toBeTruthy();
    expect(getMembers).toHaveBeenCalledWith("mine");
    expect(screen.queryByText(/Could not load your projects/)).toBeNull();
  });

  it("does not gate the concrete page on a failed reference directory", async () => {
    const { client, getDirectory, getMembers } = renderPage({
      directoryFailure: Object.assign(new Error("directory unavailable"), {
        status: 500,
      }),
    });
    expect(
      await screen.findByRole("checkbox", { name: "include mine" }),
    ).toBeTruthy();
    expect(screen.getByText("Mine")).toBeTruthy();
    await waitFor(() =>
      expect(
        client.getQueryState(referenceDirectoryQuery.queryKey)?.status,
      ).toBe("error"),
    );
    expect(getDirectory).toHaveBeenCalledTimes(1);
    expect(getMembers).toHaveBeenCalledWith("mine");
    expect(screen.queryByText(/Could not load your projects/)).toBeNull();
    expect(screen.queryByText(/Couldn't refresh your projects/)).toBeNull();
  });

  it("keeps cached content on a me 401 without a page failure notice", async () => {
    const { client, getMe, getMembers } = renderPage({ cached: true });
    expect(
      await screen.findByRole("checkbox", { name: "include mine" }),
    ).toBeTruthy();
    getMe.mockRejectedValueOnce(
      Object.assign(new Error("session expired"), { status: 401 }),
    );
    await act(async () => {
      await client.refetchQueries({ queryKey: meQuery.queryKey });
    });
    await waitFor(() =>
      expect(client.getQueryState(meQuery.queryKey)?.status).toBe("error"),
    );
    expect(getMembers).toHaveBeenCalledWith("mine");
    await waitFor(() => expect(screen.getByText("Mine")).toBeTruthy());
    expect(screen.getByRole("button", { name: "Add to project" })).toBeTruthy();
    expect(screen.queryByText(/Could not load your projects/)).toBeNull();
    expect(screen.queryByText(/Couldn't refresh your projects/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });
});
