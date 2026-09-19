import { QueryClient } from "@tanstack/react-query";
import { cleanup, waitFor } from "@testing-library/react";
import type { IssueListItem } from "@todou/shared";
import { Component, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { issueRefQuery } from "../src/api/issue-refs.ts";
import { referenceConfigQuery } from "../src/api/references.ts";
import { IssueLink } from "../src/components/shared/issue-link.tsx";
import { renderWithProviders } from "./render.tsx";

const clients: QueryClient[] = [];

function refItem(): IssueListItem {
  return {
    id: 7,
    number: 7,
    title: "Referenced card",
    status: {
      id: 1,
      name: "Workflow state",
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
    muted: null,
    blocked_by: [],
    blocks: [],
    moves: [],
  };
}

class CaptureRenderError extends Component<
  { children: ReactNode; onError: (error: Error) => void },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: Error) {
    this.props.onError(error);
  }

  render() {
    return this.state.failed ? null : this.props.children;
  }
}

function renderReference(item: IssueListItem, onError = vi.fn()) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, enabled: false } },
  });
  clients.push(client);
  // The API's list result reaches this cache without schema parsing. Inject
  // wire values here, preserving the production schema and the real consumer.
  client.setQueryData(issueRefQuery("p", 7).queryKey, item);
  client.setQueryData(referenceConfigQuery("p").queryKey, {
    format: { prefix: "T", history: [] },
    autolinks: [],
  });
  return renderWithProviders(
    <CaptureRenderError onError={onError}>
      <IssueLink slug="p" number={7} pageSlug="p" />
    </CaptureRenderError>,
    client,
  );
}

afterEach(() => {
  cleanup();
  for (const client of clients.splice(0)) client.clear();
  vi.restoreAllMocks();
});

describe("IssueLink status category", () => {
  it.each([
    ["open", "lucide-circle-dot", "lucide-circle-slash"],
    ["closed", "lucide-circle-slash", "lucide-circle-dot"],
  ] as const)(
    "preserves the %s icon and status color",
    async (category, icon, other) => {
      const item = refItem();
      item.status.category = category;
      const view = renderReference(item);
      const link = await view.findByRole("link", { name: /Referenced card/ });
      expect(link.getAttribute("href")).toBe("/projects/p/issues/7");
      expect(link.querySelector(`svg.${icon}`)).not.toBeNull();
      expect(link.querySelector(`svg.${other}, svg.lucide-circle`)).toBeNull();
      expect(link.querySelector("svg")?.style.color).toBe(item.status.color);
    },
  );

  it.each(["future_category", "constructor", "__proto__"])(
    "renders a neutral icon for unknown category %s",
    async (category) => {
      const item = refItem();
      Object.assign(item.status, { category });
      const view = renderReference(item);
      const link = await view.findByRole("link", { name: /Referenced card/ });
      expect(link.getAttribute("href")).toBe("/projects/p/issues/7");
      expect(link.textContent).toContain("T-7");
      expect(
        link.querySelector("svg.lucide-circle-dot, svg.lucide-circle-slash"),
      ).toBeNull();
      const icon = link.querySelector("svg.lucide-circle");
      expect(icon).not.toBeNull();
      expect(icon?.classList.contains("text-muted-foreground")).toBe(true);
      expect(icon?.getAttribute("aria-hidden")).toBe("true");
      expect(icon?.getAttribute("style")).toBeNull();
    },
  );

  it.each([
    ["missing", undefined],
    ["undefined", undefined],
    ["null", null],
    ["empty", ""],
    ["number", 42],
    ["boolean", false],
    ["object", {}],
    ["array", []],
  ])("throws TypeError for %s category", async (label, category) => {
    const item = refItem();
    if (label === "missing") Reflect.deleteProperty(item.status, "category");
    else Object.assign(item.status, { category });
    const onError = vi.fn();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const view = renderReference(item, onError);
    await waitFor(() => expect(onError).toHaveBeenCalled());
    expect(onError.mock.calls[0]?.[0]).toBeInstanceOf(TypeError);
    expect(onError.mock.calls[0]?.[0].message).toBe(
      "issue status category must be a non-empty string",
    );
    expect(view.container.querySelector("a[data-issue-link]")).toBeNull();
  });
});
