import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import type { Project, Settings, Status, StatusUsage } from "@todou/shared";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { insightsSettingsQuery } from "../src/api/insights.ts";
import {
  projectQuery,
  statusesQuery,
  statusUsageQuery,
} from "../src/api/queries.ts";
import { StatusesSection } from "../src/components/settings/statuses-section.tsx";
import { renderWithProviders, testQueryClient } from "./render.tsx";

const NAMES: Array<[string, "open" | "closed", string]> = [
  ["Backlog", "open", "#9ca3af"],
  ["Todo", "open", "#6b7280"],
  ["Next", "open", "#06b6d4"],
  ["In Progress", "open", "#3b82f6"],
  ["Ready to Ship", "open", "#f59e0b"],
  ["Shipped", "open", "#8b5cf6"],
  ["Done", "closed", "#22c55e"],
  ["Invalid", "closed", "#475569"],
];
const STATUSES: Status[] = NAMES.map(([name, category, color], i) => ({
  id: i + 1,
  name,
  category,
  color,
  position: i,
  is_default: name === "Todo",
}));
const SHIPPED = 6;
const DONE = 7;

const ROLES: Record<string, string> = {
  Shipped: "completed",
  Done: "completed",
  Invalid: "excluded",
};
const settings = (overrides: Record<number, string> = {}): Settings =>
  ({
    version: "1.x",
    source: "default",
    roles: STATUSES.map((s) => ({
      status_id: s.id,
      name: s.name,
      category: s.category,
      color: s.color,
      position: s.position,
      role: overrides[s.id] ?? ROLES[s.name] ?? "remaining",
    })),
  }) as Settings;

const USAGE: StatusUsage[] = STATUSES.map((s) => ({
  id: s.id,
  issues: s.name === "Next" ? 5 : 0,
  trashed: s.name === "Invalid" ? 2 : 0,
}));

const project = (
  line: number | null,
  role: Project["viewer_role"] = "admin",
): Project => ({
  id: 1,
  slug: "todou",
  name: "todou",
  description: "",
  created_at: "2026-01-01T00:00:00Z",
  viewer_role: role,
  block_clear_status_id: line,
});

type Call = { url: string; method?: string; body?: string };

function stubFetch(fail: (call: Call) => string | null = () => null) {
  const calls: Call[] = [];
  // The project refetched after a drop has to carry the line it placed.
  let line: number | null = SHIPPED;
  vi.stubGlobal("fetch", (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const call = {
      url,
      method: init?.method,
      body: init?.body === undefined ? undefined : String(init.body),
    };
    calls.push(call);
    const failure = fail(call);
    if (failure === null && url.endsWith("/statuses/order")) {
      line = JSON.parse(call.body ?? "{}").block_clear_status_id ?? null;
    }
    if (failure !== null) {
      return new Response(
        JSON.stringify({ error: { code: "conflict", message: failure } }),
        { status: 409, headers: { "content-type": "application/json" } },
      );
    }
    const payload = url.endsWith("/statuses/usage")
      ? USAGE
      : url.endsWith("/statuses") && (init?.method ?? "GET") === "GET"
        ? STATUSES
        : url.endsWith("/insights/settings") ||
            url.includes("/insights/settings/roles/")
          ? settings()
          : url.endsWith("/statuses/order")
            ? { statuses: STATUSES, block_clear_status_id: line }
            : url.endsWith("/projects/todou")
              ? project(line)
              : STATUSES[0];
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch);
  return calls;
}

const writes = (calls: Call[]) =>
  calls.filter((c) => c.method !== undefined && c.method !== "GET");
const bodyOf = (call: Call | undefined) => JSON.parse(call?.body ?? "{}");

async function renderSection({
  line = SHIPPED as number | null,
  role = "admin" as Project["viewer_role"],
  roles = {} as Record<number, string>,
} = {}) {
  const client = testQueryClient();
  client.setQueryData(statusesQuery("todou").queryKey, STATUSES);
  client.setQueryData(projectQuery("todou").queryKey, project(line, role));
  client.setQueryData(insightsSettingsQuery("todou").queryKey, settings(roles));
  client.setQueryData(statusUsageQuery("todou").queryKey, USAGE);
  const view = renderWithProviders(<StatusesSection slug="todou" />, client);
  await screen.findByText("Backlog");
  return view;
}

/**
 * happy-dom lays nothing out, and dnd-kit's keyboard sensor moves by the
 * rows' rectangles: give each child of the list a 44px slot in order.
 */
function layOutRows() {
  const original = Element.prototype.getBoundingClientRect;
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(
    function (this: Element) {
      const parent = this.parentElement;
      if (!parent?.classList.contains("divide-y")) {
        return original.call(this);
      }
      const index = [...parent.children].indexOf(this);
      const top = index * 44;
      return {
        x: 0,
        y: top,
        top,
        left: 0,
        right: 600,
        bottom: top + 44,
        width: 600,
        height: 44,
        toJSON: () => ({}),
      } as DOMRect;
    },
  );
}

/** dnd-kit listens for the keys after a pick-up from a timer. */
const tick = () =>
  act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));

/** Space, arrows, Space: one keyboard move of the item `name` labels. */
async function keyboardMove(
  name: string,
  key: "ArrowUp" | "ArrowDown",
  times = 1,
) {
  const grip = screen.getByRole("button", { name });
  grip.focus();
  fireEvent.keyDown(grip, { key: " ", code: "Space" });
  await tick();
  for (let i = 0; i < times; i += 1) {
    fireEvent.keyDown(grip, { key, code: key });
    await tick();
  }
  fireEvent.keyDown(grip, { key: " ", code: "Space" });
  await tick();
}

const capsule = () =>
  screen.getByRole("button", { name: "Blocks clear below; drag to move" });
const follows = (a: Element, b: Element) =>
  Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);

beforeEach(() => {
  layOutRows();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Statuses settings (T-712)", () => {
  it("names only what departs from a status's category", async () => {
    stubFetch();
    await renderSection();
    expect(screen.getByText("completed in charts")).toBeTruthy();
    expect(screen.getByText("closed")).toBeTruthy();
    expect(screen.getByText("closed · excluded from charts")).toBeTruthy();
    for (const name of ["Backlog", "Next", "In Progress", "Ready to Ship"]) {
      const row = screen.getByLabelText(`edit status ${name}`);
      expect(row.textContent).toBe(name);
    }
    expect(screen.getByLabelText("edit status Todo").textContent).toBe(
      "Tododefault",
    );
  });

  it("draws the line directly above the status it names", async () => {
    stubFetch();
    await renderSection();
    expect(
      follows(screen.getByLabelText("edit status Ready to Ship"), capsule()),
    ).toBe(true);
    expect(
      follows(capsule(), screen.getByLabelText("edit status Shipped")),
    ).toBe(true);
  });

  it("removes the line with ×, sending the order unchanged", async () => {
    const calls = stubFetch();
    await renderSection();
    fireEvent.click(
      screen.getByRole("button", { name: "Remove the block clear line" }),
    );
    await waitFor(() => expect(writes(calls)).toHaveLength(1));
    const [put] = writes(calls);
    expect(put?.method).toBe("PUT");
    expect(put?.url).toContain("/statuses/order");
    expect(bodyOf(put)).toEqual({
      ids: STATUSES.map((s) => s.id),
      block_clear_status_id: null,
    });
    // Optimistic: the note replaces the line before the server answers.
    expect(
      await screen.findByText("Blocks clear at any closed status."),
    ).toBeTruthy();
  });

  it("with no line, draws one above the first closed status", async () => {
    const calls = stubFetch();
    await renderSection({ line: null });
    expect(
      screen.queryByRole("button", {
        name: "Blocks clear below; drag to move",
      }),
    ).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Draw a line" }));
    await waitFor(() => expect(writes(calls)).toHaveLength(1));
    expect(bodyOf(writes(calls)[0])).toEqual({
      ids: STATUSES.map((s) => s.id),
      block_clear_status_id: DONE,
    });
  });

  it("moves a status by keyboard in one request", async () => {
    const calls = stubFetch();
    await renderSection();
    await keyboardMove("Move Backlog", "ArrowDown");
    await waitFor(() => expect(writes(calls)).toHaveLength(1));
    expect(bodyOf(writes(calls)[0])).toEqual({
      ids: [2, 1, 3, 4, 5, 6, 7, 8],
      block_clear_status_id: SHIPPED,
    });
  });

  it("moving the line's own status above it sends the order and the line together", async () => {
    const calls = stubFetch();
    await renderSection();
    await keyboardMove("Move Shipped", "ArrowUp");
    await waitFor(() => expect(writes(calls)).toHaveLength(1));
    expect(bodyOf(writes(calls)[0])).toEqual({
      ids: [1, 2, 3, 4, 5, 6, 7, 8],
      block_clear_status_id: DONE,
    });
  });

  it("never drops the line below the last status", async () => {
    const calls = stubFetch();
    await renderSection({ line: DONE });
    await keyboardMove("Blocks clear below; drag to move", "ArrowDown", 2);
    await waitFor(() => expect(writes(calls)).toHaveLength(1));
    expect(bodyOf(writes(calls)[0])).toEqual({
      ids: STATUSES.map((s) => s.id),
      block_clear_status_id: 8,
    });
  });

  it("links each count to the status's issues, closed ones included", async () => {
    stubFetch();
    await renderSection();
    const link = screen.getByRole("link", { name: "5 issues" });
    const params = new URL(link.getAttribute("href") ?? "", "http://x")
      .searchParams;
    expect(params.get("status")).toMatch(/^"?3"?$/);
    expect(params.get("category")).toBe("all");
  });

  it("saves only what changed", async () => {
    const calls = stubFetch();
    await renderSection();
    fireEvent.click(screen.getByLabelText("edit status Next"));
    const save = screen.getByRole("button", { name: "Save" });
    expect((save as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: " Up Next " },
    });
    fireEvent.click(save);
    await waitFor(() => expect(writes(calls)).toHaveLength(1));
    const [patch] = writes(calls);
    expect(patch?.method).toBe("PATCH");
    expect(patch?.url).toContain("/statuses/3");
    expect(bodyOf(patch)).toEqual({ name: "Up Next" });
    await waitFor(() => expect(screen.queryByLabelText("Name")).toBeNull());
  });

  it("sends a role change as its own request, beside the status's", async () => {
    const calls = stubFetch();
    await renderSection();
    fireEvent.click(screen.getByLabelText("edit status Next"));
    fireEvent.click(screen.getByRole("button", { name: "Closed" }));
    fireEvent.click(screen.getByRole("button", { name: "Excluded" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(writes(calls)).toHaveLength(2));
    const patch = writes(calls).find((c) => c.method === "PATCH");
    const role = writes(calls).find((c) => c.url.includes("/roles/3"));
    expect(bodyOf(patch)).toEqual({ category: "closed" });
    expect(role?.method).toBe("PUT");
    expect(bodyOf(role)).toEqual({ role: "excluded" });
  });

  it("keeps the row open with its draft when one request fails", async () => {
    const error = vi.spyOn(toast, "error");
    stubFetch((call) =>
      call.url.includes("/roles/") ? "insights settings are busy" : null,
    );
    await renderSection();
    fireEvent.click(screen.getByLabelText("edit status Next"));
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Up Next" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Completed" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(error).toHaveBeenCalledWith("insights settings are busy"),
    );
    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe(
      "Up Next",
    );
  });

  it("leaves an unknown stored role alone unless one is picked", async () => {
    const calls = stubFetch();
    await renderSection({ roles: { 3: "forecast" } });
    fireEvent.click(screen.getByLabelText("edit status Next"));
    expect(screen.getByText("forecast")).toBeTruthy();
    for (const label of ["Remaining", "Completed", "Excluded"]) {
      expect(
        screen
          .getByRole("button", { name: label })
          .getAttribute("aria-pressed"),
      ).toBe("false");
    }
    fireEvent.click(
      screen.getByRole("checkbox", { name: "New issues start here" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(writes(calls)).toHaveLength(1));
    expect(bodyOf(writes(calls)[0])).toEqual({ is_default: true });
  });

  it.each([
    ["Next", "5 issues are in it — move them first."],
    ["Invalid", "2 trashed issues are still in it."],
    ["Shipped", "Blocks clear here — move the line first."],
  ])("refuses to delete %s while the server would", async (name, reason) => {
    stubFetch();
    await renderSection();
    fireEvent.click(screen.getByLabelText(`edit status ${name}`));
    const remove = screen.getByRole("button", { name: /Delete/ });
    expect((remove as HTMLButtonElement).disabled).toBe(true);
    expect(remove.parentElement?.textContent).toContain(reason);
  });

  it("deletes an empty status only once confirmed", async () => {
    const calls = stubFetch();
    await renderSection();
    fireEvent.click(screen.getByLabelText("edit status Backlog"));
    fireEvent.click(screen.getByRole("button", { name: /Delete/ }));
    expect(
      await screen.findByText(
        "Burn charts will count time spent in it as unknown.",
        { exact: false },
      ),
    ).toBeTruthy();
    expect(writes(calls)).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Delete status" }));
    await waitFor(() => expect(writes(calls)).toHaveLength(1));
    expect(writes(calls)[0]?.method).toBe("DELETE");
    expect(writes(calls)[0]?.url).toContain("/statuses/1");
  });

  it("creates with the default role, and sends a role only when picked otherwise", async () => {
    const calls = stubFetch();
    await renderSection();
    fireEvent.click(screen.getByRole("button", { name: /New status/ }));
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Review" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Excluded" }));
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(writes(calls)).toHaveLength(2));
    expect(writes(calls)[0]?.method).toBe("POST");
    expect(bodyOf(writes(calls)[0])).toMatchObject({
      name: "Review",
      category: "open",
    });
    expect(bodyOf(writes(calls)[1])).toEqual({ role: "excluded" });
  });

  it("shows a read-only member the list without its controls", async () => {
    stubFetch();
    await renderSection({ role: "writer" });
    expect(screen.queryByRole("button", { name: /^Move / })).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Remove the block clear line" }),
    ).toBeNull();
    expect(screen.queryByRole("button", { name: /New status/ })).toBeNull();
    expect(screen.queryByLabelText("edit status Next")).toBeNull();
    expect(screen.getByText("Blocks clear below")).toBeTruthy();
    expect(screen.getByRole("link", { name: "5 issues" })).toBeTruthy();
  });
});
