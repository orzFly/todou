import type { QueryClient } from "@tanstack/react-query";
import { within } from "@testing-library/react";
import type {
  Attachment,
  Issue,
  Label,
  Member,
  SpecInfo,
  SpecPushedPayload,
} from "@todou/shared";
import { describe, expect, it } from "vitest";
import { attachmentsQuery } from "../src/api/attachments.ts";
import { issueQuery } from "../src/api/issues.ts";
import { issueMetadataQuery } from "../src/api/metadata.ts";
import { mutesQuery } from "../src/api/mutes.ts";
import { projectQuery } from "../src/api/queries.ts";
import { latestSpecPushQuery, specQuery } from "../src/api/spec.ts";
import { Sidebar } from "../src/pages/issue-detail.tsx";
import { renderWithProviders, testQueryClient } from "./render.tsx";

/**
 * The sidebar's shape after T-403: what order the sections come in, and what
 * an empty one is allowed to draw.
 */

const SLUG = "p";
const NUMBER = 7;
/** The id seeded onto the spec push, so the Latest spec link is checked
 *  against a value this file chose rather than one read back out of it. */
const PUSH_EVENT_ID = 4242;

const user = {
  id: 1,
  login: "user",
  display_name: "User",
  kind: "human" as const,
  avatar_url: null,
  owner: null,
};

const BUG: Label = { id: 10, name: "bug", color: "#ff0000" };

const CARD: Issue = {
  id: 11,
  number: NUMBER,
  title: "Fix the potato",
  body: "the first draft",
  status: {
    id: 1,
    name: "Todo",
    category: "open",
    color: "#6b7280",
    position: 0,
    is_default: true,
  },
  author: user,
  assignees: [],
  labels: [],
  created_at: "2026-09-08T09:00:00Z",
  updated_at: "2026-09-08T09:00:00Z",
  body_edited_at: null,
  open_questions: 0,
  spec_version: null,
  spec_review_status: null,
  spec_unresolved_comments: 0,
  deleted_at: null,
} as unknown as Issue;

const attachment = (n: number): Attachment => ({
  id: n,
  filename: `shot-${n}.png`,
  content_type: "image/png",
  size: 512,
  url: `/api/projects/${SLUG}/attachments/${n}/download/shot-${n}.png`,
  uploader: user,
  created_at: `2026-09-01T00:0${n}:00Z`,
  aliases: [],
});

/**
 * Everything the sidebar's own queries would otherwise go to the network for.
 * `projectQuery` is not optional: `useCanCreateLabels` suspends on it, and a
 * suspending query with no seed renders the shell's spinner instead.
 */
function seed({ full }: { full: boolean }): QueryClient {
  const client = testQueryClient();
  client.setQueryData(projectQuery(SLUG).queryKey, {
    id: 1,
    slug: SLUG,
    name: SLUG,
    description: "",
    created_at: "2026-01-01T00:00:00Z",
    viewer_role: "writer",
  });
  client.setQueryData(mutesQuery.queryKey, { issues: [], projects: [] });
  client.setQueryData(issueMetadataQuery(SLUG, NUMBER).queryKey, {
    entries: full
      ? [
          {
            namespace: "ci",
            key: "run",
            value: "green",
            updated_at: "2026-09-08T09:00:00Z",
            updated_by: user,
          },
        ]
      : [],
  });
  client.setQueryData(
    attachmentsQuery(SLUG, NUMBER).queryKey,
    full ? [attachment(1), attachment(2)] : [],
  );
  client.setQueryData(issueQuery(SLUG, NUMBER).queryKey, {
    ...CARD,
    spec_version: full ? 2 : null,
  });
  if (full) {
    const spec: SpecInfo = {
      current_version: 2,
      current_version_cursor: "1:a.1.a",
      review_status: "approved",
      unresolved_comments: 0,
      unresolved_carried_comments: 0,
      files: [{ path: "design.md", size: 10 }],
      versions: [],
    };
    const push: { eventId: number; payload: SpecPushedPayload } = {
      eventId: PUSH_EVENT_ID,
      payload: {
        version: 2,
        message: null,
        added: [],
        changed: [],
        removed: [],
      },
    };
    client.setQueryData(specQuery(SLUG, NUMBER).queryKey, spec);
    client.setQueryData(latestSpecPushQuery(SLUG, NUMBER).queryKey, push);
  }
  return client;
}

function mount({ full }: { full: boolean }, issue: Issue = CARD) {
  return renderWithProviders(
    <Sidebar
      slug={SLUG}
      issue={issue}
      statuses={[issue.status]}
      allLabels={[BUG]}
      members={[{ user, role: "writer" }] as unknown as Member[]}
      canDelete={true}
      trashed={false}
    />,
    seed({ full }),
  );
}

const sectionsOf = (container: HTMLElement) =>
  [...container.querySelectorAll("[data-sidebar-section]")].map((el) =>
    el.getAttribute("data-sidebar-section"),
  );

const findSection = async (
  view: Awaited<ReturnType<typeof mount>>,
  name: string,
) => {
  await view.findByText("Status");
  const section = view.container.querySelector(
    `[data-sidebar-section="${name}"]`,
  );
  expect(section).not.toBeNull();
  return section as HTMLElement;
};

describe("the order of the sidebar's sections", () => {
  // Written out rather than imported from src: a shared constant would let
  // the source and the expectation move together and never disagree.
  it("runs status → … → more actions on a card with everything", async () => {
    const view = mount({ full: true });
    await view.findByText("Status");
    expect(sectionsOf(view.container)).toEqual([
      "status",
      "labels",
      "assignees",
      "blocked-by",
      "blocks",
      "notifications",
      "spec",
      "attachments",
      "metadata",
      "more-actions",
    ]);
  });

  it("drops Latest spec and Attachments on a card that has neither", async () => {
    const view = mount({ full: false });
    await view.findByText("Status");
    expect(sectionsOf(view.container)).toEqual([
      "status",
      "labels",
      "assignees",
      "blocked-by",
      "blocks",
      "notifications",
      "metadata",
      "more-actions",
    ]);
  });
});

describe("a sidebar section with nothing in it", () => {
  it.each([
    ["labels", "Labels", "Edit labels"],
    ["assignees", "Assignees", "Edit assignees"],
    ["blocked-by", "Blocked by", "Add a blocked by entry"],
    ["blocks", "Blocks", "Add a blocks entry"],
  ])(
    "draws %s as a heading row and nothing else",
    async (name, title, button) => {
      const view = mount({ full: false });
      const section = await findSection(view, name);

      // No placeholder text, and no emptied-out container left behind: an empty
      // `<div>` or `<ul>` still takes a `space-y-2` margin, so counting the
      // element children is what catches one.
      expect(section.textContent?.trim()).toBe(title);
      expect(section.children.length).toBe(1);

      const row = section.children[0] as HTMLElement;
      const control = within(section).getByRole("button", { name: button });
      expect(row.contains(control)).toBe(true);
      expect(row.lastElementChild).toBe(control);
    },
  );

  it("draws Metadata the same way, minus the summary block", async () => {
    const view = mount({ full: false });
    const section = await findSection(view, "metadata");

    // A closed dialog lives in this section, so count text rather than
    // children: the `—` this used to draw would land in it.
    expect(section.textContent?.trim()).toBe("Metadata");
    expect(view.queryByTestId("metadata-open")).toBeNull();

    const row = section.children[0] as HTMLElement;
    const control = within(section).getByRole("button", {
      name: "Edit metadata",
    });
    expect(row.contains(control)).toBe(true);
    expect(row.lastElementChild).toBe(control);
  });
});

describe("a sidebar section with content", () => {
  it("keeps the edit button in the heading row, above the chips", async () => {
    const view = mount({ full: false }, { ...CARD, labels: [BUG] });
    const section = await findSection(view, "labels");

    const row = section.children[0] as HTMLElement;
    const control = within(section).getByRole("button", {
      name: "Edit labels",
    });
    expect(row.contains(control)).toBe(true);

    const content = section.children[1] as HTMLElement;
    expect(content.textContent).toContain("bug");
    expect(content.contains(control)).toBe(false);
  });
});

describe("the Latest spec heading", () => {
  it("jumps to the newest push event in the timeline", async () => {
    const view = mount({ full: true });
    const section = await findSection(view, "spec");
    const heading = section.querySelector("h3") as HTMLElement;

    const link = within(heading).getByRole("link");
    expect(link.getAttribute("href")).toContain(`#event-${PUSH_EVENT_ID}`);
    // The version rides inside the link, not beside it — the whole heading is
    // the target.
    expect(link.textContent).toContain("v2");
  });

  it("is plain text while no push has been read back", async () => {
    const client = seed({ full: true });
    client.setQueryData(latestSpecPushQuery(SLUG, NUMBER).queryKey, null);
    const view = renderWithProviders(
      <Sidebar
        slug={SLUG}
        issue={CARD}
        statuses={[CARD.status]}
        allLabels={[BUG]}
        members={[]}
        canDelete={true}
        trashed={false}
      />,
      client,
    );
    await view.findByText("Status");
    const section = view.container.querySelector(
      '[data-sidebar-section="spec"]',
    ) as HTMLElement;
    const heading = section.querySelector("h3") as HTMLElement;
    expect(within(heading).queryByRole("link")).toBeNull();
    expect(heading.textContent).toContain("Latest spec");
  });
});
