import type { QueryClient } from "@tanstack/react-query";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import type {
  BlockRef,
  IssueListItem,
  IssueListPage,
  Project,
  ReferenceConfig,
  ReferenceDirectory,
} from "@todou/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { issueRefQuery } from "../src/api/issue-refs.ts";
import {
  issueCompletionQuery,
  issueCompletionSearchQuery,
  recentOpenIssuesQuery,
} from "../src/api/issues.ts";
import { api, projectQuery, projectsQuery } from "../src/api/queries.ts";
import {
  referenceConfigQuery,
  referenceDirectoryQuery,
} from "../src/api/references.ts";
import { BlocksSection } from "../src/components/issue/blocks-section.tsx";
import { renderWithProviders, testQueryClient } from "./render.tsx";

afterEach(() => vi.restoreAllMocks());

const user = {
  id: 1,
  login: "user",
  display_name: "User",
  kind: "human" as const,
  avatar_url: null,
  owner: null,
};

const item = (
  number: number,
  title: string,
  category: "open" | "closed" = "open",
): IssueListItem => ({
  id: number,
  number,
  title,
  status: {
    id: category === "open" ? 1 : 2,
    name: category === "open" ? "Todo" : "Done",
    category,
    color: "#000000",
    position: 1,
    is_default: category === "open",
  },
  author: user,
  assignees: [],
  labels: [],
  created_at: "2026-09-01T00:00:00.000Z",
  updated_at: `2026-09-${String(Math.min(number, 28)).padStart(2, "0")}T00:00:00.000Z`,
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

const page = (items: IssueListItem[]): IssueListPage => ({
  items,
  next_cursor: null,
});

const projects: Project[] = [
  {
    id: 7,
    slug: "p",
    name: "P",
    description: "",
    created_at: "2026-09-01T00:00:00.000Z",
    viewer_role: "writer",
  },
  {
    id: 8,
    slug: "mirror",
    name: "Mirror",
    description: "",
    created_at: "2026-09-01T00:00:00.000Z",
    viewer_role: "writer",
  },
];

const config: ReferenceConfig = {
  format: { prefix: "T", history: [] },
  autolinks: [],
};

const directory: ReferenceDirectory = {
  entries: [
    { prefix: "T", slug: "p", from: "2020-01-01T00:00:00.000Z", to: null },
    {
      prefix: "MIR",
      slug: "mirror",
      from: "2020-01-01T00:00:00.000Z",
      to: null,
    },
  ],
  contested: [],
};

function client() {
  const queryClient = testQueryClient();
  queryClient.setQueryData(projectQuery("p").queryKey, projects[0]);
  queryClient.setQueryData(projectsQuery.queryKey, projects);
  queryClient.setQueryData(referenceConfigQuery("p").queryKey, config);
  queryClient.setQueryData(referenceDirectoryQuery.queryKey, directory);
  queryClient.setQueryData(recentOpenIssuesQuery("p", 8).queryKey, page([]));
  queryClient.setQueryData(issueCompletionQuery("p").queryKey, page([]));
  return queryClient;
}

const edge = (number: number, cleared = false): BlockRef => ({
  edge_id: number,
  project_id: 7,
  project: "p",
  number,
  ref: `T-${number}`,
  hidden: false,
  cleared_at: cleared ? "2026-09-12T00:00:00.000Z" : null,
  blocker_deleted: false,
});

type PickerFixture = {
  blockedBy?: BlockRef[];
  queryClient?: QueryClient;
};

function renderPicker(options?: PickerFixture) {
  const queryClient = options?.queryClient ?? client();
  const view = renderWithProviders(
    <BlocksSection
      slug="p"
      issue={{ number: 1, blocked_by: options?.blockedBy ?? [], blocks: [] }}
      trashed={false}
    />,
    queryClient,
  );
  return { view, queryClient };
}

async function openPicker(options?: PickerFixture) {
  const result = renderPicker(options);
  const trigger = await result.view.findByRole("button", {
    name: "Add a blocked by entry",
  });
  fireEvent.click(trigger);
  const input = (await screen.findByPlaceholderText(
    "#12 or other-project#12",
  )) as HTMLInputElement;
  return { ...result, trigger, input };
}

describe("block reference picker", () => {
  it("defaults to recent open cards and excludes self and every existing edge", async () => {
    const queryClient = client();
    queryClient.setQueryData(
      recentOpenIssuesQuery("p", 8).queryKey,
      page([
        item(1, "This card"),
        item(2, "Existing"),
        item(4, "Newest"),
        item(3, "Older"),
      ]),
    );
    queryClient.setQueryData(
      issueRefQuery("p", 2).queryKey,
      item(2, "Existing"),
    );
    const { trigger } = await openPicker({
      queryClient,
      blockedBy: [edge(2, true)],
    });
    const options = await screen.findAllByRole("option");
    expect(options.map((option) => option.textContent)).toEqual([
      "T-4NewestTodo",
      "T-3OlderTodo",
    ]);
    expect(
      options.every(
        (option) => option.getAttribute("aria-selected") === "false",
      ),
    ).toBe(true);
    expect(trigger.closest("a")).toBeNull();
    expect(document.querySelectorAll("a a")).toHaveLength(0);
  });

  it("groups closed word matches after all open matches", async () => {
    const queryClient = client();
    queryClient.setQueryData(
      issueCompletionQuery("p").queryKey,
      page([item(10, "Sidebar open"), item(11, "Sidebar closed", "closed")]),
    );
    queryClient.setQueryData(
      issueCompletionSearchQuery("p", "sidebar").queryKey,
      page([item(10, "Sidebar open"), item(11, "Sidebar closed", "closed")]),
    );
    const { input } = await openPicker({ queryClient });
    fireEvent.change(input, { target: { value: "sidebar" } });
    const list = await screen.findByRole("listbox", {
      name: "Issue references",
    });
    await waitFor(() =>
      expect(within(list).getAllByRole("option")).toHaveLength(2),
    );
    const options = within(list).getAllByRole("option");
    expect(options[0]?.textContent).toContain("Sidebar open");
    expect(options[1]?.textContent).toContain("Sidebar closed");
    expect(within(list).getByRole("group", { name: "Closed" })).toBeTruthy();
  });

  it("puts an exact numeric match before longer prefixes", async () => {
    const queryClient = client();
    queryClient.setQueryData(
      issueCompletionQuery("p").queryKey,
      page([item(370, "Longer"), item(37, "Exact")]),
    );
    queryClient.setQueryData(
      issueRefQuery("p", 37).queryKey,
      item(37, "Exact"),
    );
    const { input } = await openPicker({ queryClient });
    fireEvent.change(input, { target: { value: "37" } });
    await waitFor(() =>
      expect(
        screen.getAllByRole("option").map((option) => option.textContent),
      ).toEqual(["T-37ExactTodo", "T-370LongerTodo"]),
    );
  });

  it("fills a project spelling without submitting it", async () => {
    const add = vi
      .spyOn(api, "addIssueBlockedBy")
      .mockResolvedValue({ blocked_by: [] });
    const queryClient = client();
    queryClient.setQueryData(
      recentOpenIssuesQuery("mirror", 8).queryKey,
      page([]),
    );
    queryClient.setQueryData(issueCompletionQuery("mirror").queryKey, page([]));
    const { input } = await openPicker({ queryClient });
    fireEvent.change(input, { target: { value: "mir" } });
    await waitFor(() =>
      expect(screen.getByRole("option").textContent).toContain("MIR-"),
    );
    fireEvent.keyDown(input, { key: "Enter" });
    expect(input.value).toBe("MIR-");
    expect(add).not.toHaveBeenCalled();
  });

  it("shows the input-dependent initial highlight", async () => {
    const queryClient = client();
    queryClient.setQueryData(issueRefQuery("p", 999).queryKey, null);
    queryClient.setQueryData(
      issueCompletionQuery("p").queryKey,
      page([item(12, "Sidebar work")]),
    );
    queryClient.setQueryData(
      issueCompletionSearchQuery("p", "sidebar").queryKey,
      page([item(12, "Sidebar work")]),
    );
    const { input } = await openPicker({ queryClient });
    expect(screen.queryByRole("option", { selected: true })).toBeNull();
    fireEvent.change(input, { target: { value: "T-999" } });
    await waitFor(() =>
      expect(
        screen.getByRole("option", { selected: true }).textContent,
      ).toContain("as typed"),
    );
    fireEvent.change(input, { target: { value: "sidebar" } });
    await waitFor(() =>
      expect(
        screen.getByRole("option", { selected: true }).textContent,
      ).toContain("Sidebar work"),
    );
  });

  it("uses Tab to fill without submitting and Escape to close", async () => {
    const add = vi
      .spyOn(api, "addIssueBlockedBy")
      .mockResolvedValue({ blocked_by: [] });
    const queryClient = client();
    queryClient.setQueryData(
      issueCompletionQuery("p").queryKey,
      page([item(12, "Sidebar work")]),
    );
    queryClient.setQueryData(
      issueCompletionSearchQuery("p", "sidebar").queryKey,
      page([item(12, "Sidebar work")]),
    );
    const { input } = await openPicker({ queryClient });
    fireEvent.change(input, { target: { value: "sidebar" } });
    await waitFor(() =>
      expect(screen.getByRole("option", { selected: true })).toBeTruthy(),
    );
    fireEvent.keyDown(input, { key: "Tab" });
    expect(input.value).toBe("T-12");
    expect(add).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: "Escape" });
    await waitFor(() =>
      expect(
        screen.queryByPlaceholderText("#12 or other-project#12"),
      ).toBeNull(),
    );
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("keeps the original value open when submission fails", async () => {
    vi.spyOn(api, "addIssueBlockedBy").mockRejectedValue(
      new Error("not found"),
    );
    const queryClient = client();
    queryClient.setQueryData(issueRefQuery("p", 999).queryKey, null);
    const { input } = await openPicker({ queryClient });
    fireEvent.change(input, { target: { value: "T-999" } });
    await waitFor(() =>
      expect(screen.getByRole("option", { selected: true })).toBeTruthy(),
    );
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() =>
      expect(api.addIssueBlockedBy).toHaveBeenCalledWith("p", 1, "T-999"),
    );
    expect(screen.getByPlaceholderText("#12 or other-project#12")).toBeTruthy();
    expect(input.value).toBe("T-999");
  });

  it("keeps old project spellings while a foreign query is in flight", async () => {
    const queryClient = client();
    queryClient.setQueryData(
      recentOpenIssuesQuery("p", 8).queryKey,
      page([item(3, "Local third")]),
    );
    let resolveForeign: (value: IssueListPage) => void = () => {};
    const foreign = new Promise<IssueListPage>((resolve) => {
      resolveForeign = resolve;
    });
    vi.spyOn(api, "listIssues").mockImplementation((slug) =>
      slug === "mirror" ? foreign : Promise.resolve(page([])),
    );
    const { input } = await openPicker({ queryClient });
    await screen.findByRole("option", { name: /T-3.*Local third/ });
    fireEvent.change(input, { target: { value: "mirror/" } });
    expect(screen.getByRole("option").textContent).toContain("T-3Local third");
    expect(screen.queryByRole("option", { name: /mirror\/3/ })).toBeNull();
    resolveForeign(page([item(5, "Foreign fifth")]));
    await screen.findByRole("option", { name: /mirror\/5.*Foreign fifth/ });
  });

  it("does not rename a previous exact lookup to the newly typed number", async () => {
    const queryClient = client();
    queryClient.setQueryData(
      issueRefQuery("p", 37).queryKey,
      item(37, "Exact old"),
    );
    let resolveMissing: (value: IssueListPage) => void = () => {};
    const missing = new Promise<IssueListPage>((resolve) => {
      resolveMissing = resolve;
    });
    vi.spyOn(api, "listIssues").mockReturnValue(missing);
    const { input } = await openPicker({ queryClient });
    fireEvent.change(input, { target: { value: "37" } });
    await screen.findByRole("option", { name: /T-37.*Exact old/ });
    fireEvent.change(input, { target: { value: "999" } });
    expect(
      screen.getByRole("option", { name: /T-37.*Exact old/ }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("option", { name: /T-999.*Exact old/ }),
    ).toBeNull();
    expect(
      screen.getByRole("option", { selected: true }).textContent,
    ).toContain("as typed");
    resolveMissing(page([]));
  });

  it("resets arrow selection even when the next list has the same length", async () => {
    const queryClient = client();
    queryClient.setQueryData(
      issueCompletionQuery("p").queryKey,
      page([
        item(12, "Sidebar first"),
        item(13, "Sidebar second"),
        item(14, "Layout first"),
        item(15, "Layout second"),
      ]),
    );
    queryClient.setQueryData(
      issueCompletionSearchQuery("p", "sidebar").queryKey,
      page([]),
    );
    queryClient.setQueryData(
      issueCompletionSearchQuery("p", "layout").queryKey,
      page([]),
    );
    const { input } = await openPicker({ queryClient });
    fireEvent.change(input, { target: { value: "sidebar" } });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(
      screen.getByRole("option", { selected: true }).textContent,
    ).toContain("Sidebar first");
    fireEvent.change(input, { target: { value: "layout" } });
    expect(
      screen.getByRole("option", { selected: true }).textContent,
    ).toContain("Layout second");
  });

  it("asks for open updated-desc defaults rather than filtering the completion window", async () => {
    const queryClient = client();
    queryClient.removeQueries({
      queryKey: recentOpenIssuesQuery("p", 8).queryKey,
    });
    const list = vi
      .spyOn(api, "listIssues")
      .mockResolvedValue(page([item(4, "Recent")]));
    await openPicker({ queryClient });
    await screen.findByRole("option", { name: /Recent/ });
    expect(list).toHaveBeenCalledWith("p", {
      category: "open",
      sort: "updated",
      order: "desc",
      limit: 8,
    });
  });

  it("sorts merged title and body hits by recency within each group", async () => {
    const queryClient = client();
    queryClient.setQueryData(
      issueCompletionQuery("p").queryKey,
      page([item(12, "Sidebar title")]),
    );
    queryClient.setQueryData(
      issueCompletionSearchQuery("p", "sidebar").queryKey,
      page([item(14, "Body hit"), item(12, "Sidebar title")]),
    );
    const { input } = await openPicker({ queryClient });
    fireEvent.change(input, { target: { value: "sidebar" } });
    expect(screen.getAllByRole("option").map((row) => row.textContent)).toEqual(
      ["T-14Body hitTodo", "T-12Sidebar titleTodo"],
    );
  });

  it("takes the exact closed ref on Enter without choosing an open prefix match", async () => {
    const add = vi
      .spyOn(api, "addIssueBlockedBy")
      .mockResolvedValue({ blocked_by: [] });
    const queryClient = client();
    queryClient.setQueryData(
      issueCompletionQuery("p").queryKey,
      page([item(370, "Open prefix"), item(37, "Closed exact", "closed")]),
    );
    queryClient.setQueryData(
      issueRefQuery("p", 37).queryKey,
      item(37, "Closed exact", "closed"),
    );
    const { input } = await openPicker({ queryClient });
    fireEvent.change(input, { target: { value: "37" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(add).toHaveBeenCalledWith("p", 1, "T-37"));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("keeps keyboard selection in view and caps the list including the manual row", async () => {
    const queryClient = client();
    queryClient.setQueryData(
      issueCompletionQuery("p").queryKey,
      page(
        Array.from({ length: 25 }, (_, index) =>
          item(index + 2, "Sidebar work"),
        ),
      ),
    );
    queryClient.setQueryData(
      issueCompletionSearchQuery("p", "sidebar").queryKey,
      page([]),
    );
    const scroll = vi.spyOn(HTMLElement.prototype, "scrollIntoView");
    const { input } = await openPicker({ queryClient });
    fireEvent.change(input, { target: { value: "sidebar" } });
    scroll.mockClear();
    fireEvent.keyDown(input, { key: "End" });
    expect(scroll).toHaveBeenCalledWith({ block: "nearest" });
    expect(scroll.mock.instances[0]).toBe(
      screen.getByRole("option", { selected: true }),
    );
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(screen.getByRole("option", { selected: true })).toBe(
      screen.getAllByRole("option").at(-1),
    );
    fireEvent.keyDown(input, { key: "Home" });
    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(screen.getByRole("option", { selected: true })).toBe(
      screen.getAllByRole("option")[0],
    );
    expect(screen.getAllByRole("option").length).toBeLessThanOrEqual(20);
    expect(
      screen.getAllByRole("option").every((row) => row.tabIndex === -1),
    ).toBe(true);
  });

  it("preserves a pasted URL verbatim and disables interaction during the mutation", async () => {
    let finish: (value: { blocked_by: BlockRef[] }) => void = () => {};
    const mutation = new Promise<{ blocked_by: BlockRef[] }>((resolve) => {
      finish = resolve;
    });
    const add = vi.spyOn(api, "addIssueBlockedBy").mockReturnValue(mutation);
    const { input } = await openPicker();
    const ref = `${window.location.origin}/projects/8/issues/31`;
    fireEvent.change(input, { target: { value: ref } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(add).toHaveBeenCalledWith("p", 1, ref));
    expect(input.disabled).toBe(true);
    expect(
      screen
        .getAllByRole("option")
        .every((row) => (row as HTMLButtonElement).disabled),
    ).toBe(true);
    finish({ blocked_by: [] });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("scrolls the selected raw row again when async candidates move it down", async () => {
    const queryClient = client();
    queryClient.removeQueries({ queryKey: issueCompletionQuery("p").queryKey });
    queryClient.setQueryData(issueRefQuery("p", 1).queryKey, null);
    let finish: (value: IssueListPage) => void = () => {};
    const response = new Promise<IssueListPage>((resolve) => {
      finish = resolve;
    });
    vi.spyOn(api, "listIssues").mockReturnValue(response);
    const scroll = vi.spyOn(HTMLElement.prototype, "scrollIntoView");
    const { input } = await openPicker({ queryClient });
    fireEvent.change(input, { target: { value: "1" } });
    expect(
      screen.getByRole("option", { selected: true }).textContent,
    ).toContain("as typed");
    scroll.mockClear();
    finish(
      page(
        Array.from({ length: 20 }, (_, index) => item(100 + index, "Prefix")),
      ),
    );
    await waitFor(() =>
      expect(screen.getAllByRole("option").length).toBeGreaterThan(10),
    );
    expect(scroll).toHaveBeenCalledWith({ block: "nearest" });
    expect(scroll.mock.instances.at(-1)).toBe(
      screen.getByRole("option", { selected: true }),
    );
  });
});
