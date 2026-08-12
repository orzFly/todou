import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render as renderBare } from "@testing-library/react";
import type { ReactElement } from "react";
import { describe, expect, it } from "vitest";
import { CommentItem } from "../src/components/timeline/comment-item.tsx";
import { EventRow } from "../src/components/timeline/event-row.tsx";

// CommentItem mounts an edit mutation, which needs a query client.
function render(ui: ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return renderBare(
    <QueryClientProvider client={client}>{ui}</QueryClientProvider>,
  );
}

const user = {
  id: 2,
  login: "claude-agent",
  display_name: "Claude @ Bot One",
  kind: "machine" as const,
  owner: { id: 1, login: "user" },
};

function comment(agentContext: unknown) {
  return {
    type: "comment" as const,
    id: 1,
    author: user,
    body: "hello",
    created_at: "2026-08-11T00:00:00Z",
    edited_at: null,
    // biome-ignore lint/suspicious/noExplicitAny: test fixture
    agent_context: agentContext as any,
  };
}

describe("AgentContextBadge in the timeline", () => {
  it("shows the model name with harness + session in the tooltip", () => {
    const { getByTestId } = render(
      <CommentItem
        slug="p"
        issueNumber={1}
        comment={comment({
          agent: "claude-code",
          session_id: "sess-123",
          model: "claude-fable-5",
        })}
      />,
    );
    const badge = getByTestId("agent-context-badge");
    expect(badge.textContent).toBe("claude-fable-5");
    expect(badge.getAttribute("title")).toBe("claude-code · session sess-123");
  });

  it("falls back to the agent name without a model", () => {
    const { getByTestId } = render(
      <CommentItem
        slug="p"
        issueNumber={1}
        comment={comment({ agent: "claude-code" })}
      />,
    );
    const badge = getByTestId("agent-context-badge");
    expect(badge.textContent).toBe("claude-code");
    expect(badge.getAttribute("title")).toBe("claude-code");
  });

  it("renders nothing without agent context", () => {
    const { queryByTestId } = render(
      <CommentItem slug="p" issueNumber={1} comment={comment(null)} />,
    );
    expect(queryByTestId("agent-context-badge")).toBeNull();
  });

  it("colors the badge deterministically from the session id", () => {
    // Same-test renders share document.body, so scope queries per container.
    const badgeIn = (sessionId: string) =>
      render(
        <CommentItem
          slug="p"
          issueNumber={1}
          comment={comment({ agent: "claude-code", session_id: sessionId })}
        />,
      ).container.querySelector<HTMLElement>(
        '[data-testid="agent-context-badge"]',
      );

    const badge = badgeIn("sess-123");
    expect(badge?.classList.contains("agent-session-badge")).toBe(true);
    const hue = badge?.style.getPropertyValue("--agent-h1");
    expect(hue).not.toBe("");

    expect(badgeIn("sess-123")?.style.getPropertyValue("--agent-h1")).toBe(hue);
    expect(badgeIn("sess-124")?.style.getPropertyValue("--agent-h1")).not.toBe(
      hue,
    );
  });

  it("stays neutral without a session id", () => {
    const { getByTestId } = render(
      <CommentItem
        slug="p"
        issueNumber={1}
        comment={comment({ agent: "claude-code", model: "claude-fable-5" })}
      />,
    );
    const badge = getByTestId("agent-context-badge");
    expect(badge.classList.contains("agent-session-badge")).toBe(false);
    expect(badge.style.getPropertyValue("--agent-h1")).toBe("");
  });

  it("picks the harness icon: Claude logo for claude-*, bot otherwise", () => {
    const iconsIn = (agent: string) => {
      const { container } = render(
        <CommentItem
          slug="p"
          issueNumber={1}
          comment={comment({ agent, model: "some-model" })}
        />,
      );
      return {
        claude: container.querySelector('[data-testid="harness-icon-claude"]'),
        bot: container.querySelector('[data-testid="harness-icon-bot"]'),
      };
    };

    const claude = iconsIn("claude-code");
    expect(claude.claude).not.toBeNull();
    expect(claude.bot).toBeNull();

    const other = iconsIn("aider");
    expect(other.bot).not.toBeNull();
    expect(other.claude).toBeNull();
  });

  it("also marks event rows", () => {
    const { getByTestId } = render(
      <EventRow
        event={{
          type: "event",
          id: 2,
          event_type: "closed",
          actor: user,
          payload: { to: { name: "Done" } },
          created_at: "2026-08-11T00:00:00Z",
          agent_context: { agent: "claude-code", model: "claude-fable-5" },
        }}
      />,
    );
    expect(getByTestId("agent-context-badge").textContent).toBe(
      "claude-fable-5",
    );
  });
});
