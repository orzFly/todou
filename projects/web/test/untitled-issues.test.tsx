import { fireEvent, screen } from "@testing-library/react";
import type { Issue, Project } from "@todou/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { projectQuery } from "../src/api/queries.ts";
import {
  IssueTitle,
  issueTitleText,
} from "../src/components/shared/issue-title.tsx";
import { RefTitle } from "../src/components/shared/ref-title.tsx";
import { TitleBlock } from "../src/pages/issue-detail.tsx";
import { ProjectSection } from "../src/pages/project-settings.tsx";
import { render, renderWithClient, testQueryClient } from "./render.tsx";

const SLUG = "todou";

const PROJECT: Project = {
  id: 1,
  slug: SLUG,
  name: "todou",
  description: "",
  created_at: "2026-08-01T00:00:00.000Z",
  viewer_role: "admin",
  require_title: false,
};

const ISSUE: Issue = {
  id: 1,
  number: 7,
  title: "",
  body_preview: "Crash on save",
  body: "# Crash on save",
  status: {
    id: 1,
    name: "Todo",
    category: "open",
    color: "#6b7280",
    position: 1,
    is_default: true,
  },
  author: {
    id: 1,
    login: "alice",
    display_name: "Alice",
    kind: "human",
    avatar_url: null,
    owner: null,
  },
  assignees: [],
  labels: [],
  created_at: "2026-08-01T00:00:00.000Z",
  updated_at: "2026-08-01T00:00:00.000Z",
  body_edited_at: null,
  open_questions: 0,
  spec_version: null,
  spec_review_status: null,
  spec_unresolved_comments: 0,
  unread: false,
  unread_comments: 0,
  muted: null,
  deleted_at: null,
  deleted_by: null,
  moves: [],
  blocked_by: [],
  blocks: [],
};

let calls: Array<{ url: string; method?: string; body?: string }>;
beforeEach(() => {
  calls = [];
  vi.stubGlobal("fetch", (async (input: unknown, init?: RequestInit) => {
    calls.push({
      url: String(input),
      method: init?.method,
      body: init?.body === undefined ? undefined : String(init.body),
    });
    return new Response(JSON.stringify(PROJECT), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("IssueTitle (T-785)", () => {
  it("renders a real title as plain text", () => {
    const { container } = render(
      <IssueTitle item={{ title: "Crash", body_preview: null }} />,
    );
    expect(container.innerHTML).toBe("Crash");
  });

  it("renders an untitled card's preview muted and in parentheses", () => {
    render(<IssueTitle item={{ title: "", body_preview: "first line" }} />);
    const shown = screen.getByText("(first line)");
    expect(shown.className).toContain("text-muted-foreground");
    expect(shown.closest("a")).toBeNull();
  });

  it("falls back to (no title given) when the body has no text", () => {
    render(<IssueTitle item={{ title: "", body_preview: "" }} />);
    expect(screen.getByText("(no title given)").className).toContain(
      "text-muted-foreground",
    );
  });

  it("gives the same three answers as a string", () => {
    expect(issueTitleText({ title: "Crash", body_preview: null })).toBe(
      "Crash",
    );
    expect(issueTitleText({ title: "", body_preview: "x" })).toBe("(x)");
    expect(issueTitleText({ title: "", body_preview: null })).toBe(
      "(no title given)",
    );
  });
});

describe("RefTitle untitled (T-785)", () => {
  it("mutes the stand-in and leaves a real title alone", () => {
    const { rerender } = render(
      <RefTitle title="(first line)" untitled cap={false} data-testid="t" />,
    );
    expect(screen.getByTestId("t").className).toContain(
      "text-muted-foreground",
    );
    rerender(<RefTitle title="Crash" cap={false} data-testid="t" />);
    expect(screen.getByTestId("t").className).not.toContain(
      "text-muted-foreground",
    );
  });
});

describe("TitleBlock on an untitled card (T-785)", () => {
  function renderBlock(issue: Issue, project: Partial<Project> = {}) {
    const client = testQueryClient();
    client.setQueryData(projectQuery(SLUG).queryKey, {
      ...PROJECT,
      ...project,
    });
    return renderWithClient(<TitleBlock slug={SLUG} issue={issue} />, client);
  }

  it("heads the page with a muted (no title given), not the preview", () => {
    renderBlock(ISSUE);
    const heading = screen.getByRole("heading", { level: 1 });
    const placeholder = screen.getByText("(no title given)");
    expect(heading.contains(placeholder)).toBe(true);
    expect(placeholder.className).toContain("text-muted-foreground");
    expect(heading.textContent).not.toContain("Crash on save");
  });

  const saveWith = (typed: string) => {
    fireEvent.click(screen.getByRole("button", { name: "edit title" }));
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: typed },
    });
    return screen.getByRole("button", {
      name: "save title",
    }) as HTMLButtonElement;
  };

  it("lets a titled card with a body save an empty title", () => {
    renderBlock({ ...ISSUE, title: "Named", body_preview: null });
    expect(saveWith("  ").disabled).toBe(false);
  });

  it("refuses an empty title when the body is blank too", () => {
    renderBlock({ ...ISSUE, title: "Named", body: " ", body_preview: null });
    const save = saveWith("");
    expect(save.disabled).toBe(true);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "x" } });
    expect(save.disabled).toBe(false);
  });

  it("refuses an empty title where the project requires one", () => {
    renderBlock(
      { ...ISSUE, title: "Named", body_preview: null },
      { require_title: true },
    );
    expect(saveWith("").disabled).toBe(true);
  });
});

describe("Require a title switch (T-785)", () => {
  function renderSection(project: Partial<Project> = {}) {
    const client = testQueryClient();
    client.setQueryData(projectQuery(SLUG).queryKey, {
      ...PROJECT,
      ...project,
    });
    return renderWithClient(<ProjectSection slug={SLUG} />, client);
  }

  it("PATCHes require_title when an admin flips it", async () => {
    renderSection();
    const toggle = screen.getByRole("switch", { name: "Require a title" });
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(toggle);
    await vi.waitFor(() =>
      expect(calls.some((c) => c.method === "PATCH")).toBe(true),
    );
    const patch = calls.find((c) => c.method === "PATCH");
    expect(patch?.url).toContain(`/api/projects/${SLUG}`);
    expect(JSON.parse(patch?.body ?? "{}")).toEqual({ require_title: true });
  });

  it("shows the current setting", () => {
    renderSection({ require_title: true });
    expect(
      screen
        .getByRole("switch", { name: "Require a title" })
        .getAttribute("aria-checked"),
    ).toBe("true");
  });

  it("is not offered to a non-admin", () => {
    renderSection({ viewer_role: "writer" });
    expect(
      screen.queryByRole("switch", { name: "Require a title" }),
    ).toBeNull();
  });
});
