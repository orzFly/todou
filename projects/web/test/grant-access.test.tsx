import { fireEvent, screen, waitFor } from "@testing-library/react";
import type { Agent, Me, ReferenceDirectory } from "@todou/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveGrantTarget } from "../src/lib/grant-target.ts";
import {
  GrantAccessCard,
  type GrantSearch,
  parseGrantSearch,
  readReason,
} from "../src/pages/grant-access.tsx";
import { renderWithProviders } from "./render.tsx";

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
) => ({
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

afterEach(() => {
  vi.unstubAllGlobals();
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
