import { waitFor } from "@testing-library/react";
import type {
  Project,
  PublicUser,
  ReferenceDirectory,
  UserMembership,
} from "@todou/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../src/api/queries.ts";
import { referenceDirectoryQuery } from "../src/api/references.ts";
import { userQuery } from "../src/api/users.ts";
import { UserProfilePage } from "../src/pages/user-profile.tsx";
import { renderWithProviders, testQueryClient } from "./render.tsx";

/**
 * The user page's seats: one row per project this person holds a seat in,
 * in the page's sidebar.
 *
 * This used to be the projects home's own card (T-390), and the test beside
 * it asserted that both pages drew the same one. The sidebar is a single
 * narrow column, and the card is built for a three-across grid — it carries a
 * three-line description and a REF watermark sized against its own box — so
 * the seats are a row now and the parity is gone on purpose. What is asserted
 * here is that the row still answers the two questions the card answered:
 * where the project is, and what this person is in it.
 */

const reader = {
  id: 1,
  login: "user",
  display_name: "User",
  kind: "human" as const,
  avatar_url: null,
  owner: null,
  email: null,
  is_instance_admin: false,
  created_at: "2026-01-01T00:00:00Z",
};

const alice: PublicUser = {
  id: 7,
  login: "alice",
  display_name: "Alice Potato",
  kind: "human",
  avatar_url: null,
  owner: null,
  created_at: "2026-01-01T00:00:00Z",
};

const PROJECT_IDS: Record<string, number> = {
  homelab: 1,
  refract: 2,
  pathological: 3,
  plain: 4,
};

function project(slug: string, name: string, description = ""): Project {
  return {
    id: PROJECT_IDS[slug] ?? 99,
    slug,
    name,
    description,
    icon_url: null,
    created_at: "2026-01-01T00:00:00Z",
  };
}

/** A seat, carrying the `ProjectBrief` the user endpoint really answers with. */
function seat(p: Project, role: UserMembership["role"]): UserMembership {
  return {
    project: { id: p.id, slug: p.slug, name: p.name, icon_url: p.icon_url },
    role,
    created_at: "2026-05-02T11:03:21.000Z",
  };
}

const LONG = "W".repeat(20);

/** `plain` holds no claim; the other three hold one each. */
const DIRECTORY: ReferenceDirectory = {
  entries: [
    {
      prefix: "CH",
      slug: "homelab",
      from: "2020-01-01T00:00:00.000Z",
      to: null,
    },
    {
      prefix: "REFRACT",
      slug: "refract",
      from: "2020-01-01T00:00:00.000Z",
      to: null,
    },
    {
      prefix: LONG,
      slug: "pathological",
      from: "2020-01-01T00:00:00.000Z",
      to: null,
    },
  ],
  contested: [],
};

function renderSeats(
  projects: Project[],
  seats: UserMembership[],
  directory?: ReferenceDirectory,
) {
  const client = testQueryClient();
  client.setQueryData(["me"], reader);
  client.setQueryData(["projects"], projects);
  client.setQueryData(userQuery(alice.login).queryKey, alice);
  if (directory) {
    client.setQueryData(referenceDirectoryQuery.queryKey, directory);
  }
  vi.spyOn(api, "me").mockResolvedValue(reader);
  vi.spyOn(api, "listProjects").mockResolvedValue(projects);
  vi.spyOn(api, "listUserProjects").mockResolvedValue({ items: seats });
  vi.spyOn(api, "listUserIssues").mockResolvedValue({
    items: [],
    next_cursor: null,
    has_more: false,
  });
  return renderWithProviders(<UserProfilePage ref="alice" />, client).container;
}

/** The link a seat drew, which is the row's outermost node. */
function rowOf(container: HTMLElement, slug: string): HTMLElement {
  const link = container.querySelector(`a[href="/projects/${slug}"]`);
  if (link === null) throw new Error(`no seat row for ${slug}`);
  return link as HTMLElement;
}

async function seatRow(container: HTMLElement, slug: string) {
  await waitFor(() => expect(rowOf(container, slug)).toBeTruthy());
  return rowOf(container, slug);
}

const textOf = (row: HTMLElement, slot: string) =>
  row.querySelector(`[data-slot="${slot}"]`)?.textContent;

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("the user page's seats (T-374)", () => {
  it("draws one row per seat, naming the project and the role in it", async () => {
    const homelab = project("homelab", "Homelab");
    const refract = project("refract", "Refract");
    const container = renderSeats(
      [homelab, refract],
      [seat(homelab, "admin"), seat(refract, "reader")],
      DIRECTORY,
    );

    const row = await seatRow(container, "homelab");
    // The href is what makes middle-click and ⌘-click work; a handler-only
    // control would satisfy a click assertion and silently drop both.
    expect(row.getAttribute("href")).toBe("/projects/homelab");
    expect(row.textContent).toContain("Homelab");
    expect(textOf(row, "badge")).toBe("admin");
    // Not interactive: the row is already one anchor, and a nested control
    // would both be invalid HTML and split it into two focusable things.
    expect(row.querySelector("button, a, input")).toBeNull();
    expect((await seatRow(container, "refract")).textContent).toContain(
      "reader",
    );
  });

  it("carries none of the home card's chrome into the sidebar", async () => {
    // The description and the watermark are what the row gave up; naming
    // their slots is what stops the card creeping back in one node at a time.
    const homelab = project(
      "homelab",
      "Homelab",
      "Every machine under the sink",
    );
    const container = renderSeats(
      [homelab],
      [seat(homelab, "admin")],
      DIRECTORY,
    );
    const row = await seatRow(container, "homelab");

    expect(row.querySelector('[data-slot="card"]')).toBeNull();
    expect(row.querySelector('[data-slot="card-description"]')).toBeNull();
    expect(row.querySelector('[data-slot="ref-watermark"]')).toBeNull();
    expect(row.textContent).not.toContain("Every machine under the sink");
  });

  it("takes the icon's glyphs from the directory, never from the slug", async () => {
    // Literals, not `GLYPH_LIMIT` recomputed — an expected value derived from
    // the constant moves with it and can never fail.
    const projects = [
      project("homelab", "Homelab"),
      project("refract", "Refract"),
      project("pathological", "Pathological"),
      project("plain", "Home Lab"),
    ];
    const container = renderSeats(
      projects,
      projects.map((p) => seat(p, "reader")),
      DIRECTORY,
    );

    const expected: Record<string, string> = {
      homelab: "CH",
      refract: "REF",
      pathological: "WWW",
      plain: "HL",
    };
    for (const [slug, glyphs] of Object.entries(expected)) {
      const row = await seatRow(container, slug);
      expect(textOf(row, "avatar-fallback"), `icon for ${slug}`).toBe(glyphs);
    }
  });

  it("falls through to initials where the directory holds no claim", async () => {
    // With no directory there is no prefix anywhere, so the icon falls all
    // the way through to initials. A page that minted a prefix of its own out
    // of the slug would draw `HOM`.
    const homelab = project("homelab", "Homelab");
    const container = renderSeats([homelab], [seat(homelab, "writer")]);
    const row = await seatRow(container, "homelab");

    expect(textOf(row, "avatar-fallback")).toBe("H");
  });
});
