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
  it("shows agent · model with the session in the tooltip", () => {
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
    expect(badge.textContent).toBe("claude-code · claude-fable-5");
    expect(badge.getAttribute("title")).toBe("session sess-123");
  });

  it("degrades to the agent name alone", () => {
    const { getByTestId } = render(
      <CommentItem
        slug="p"
        issueNumber={1}
        comment={comment({ agent: "claude-code" })}
      />,
    );
    const badge = getByTestId("agent-context-badge");
    expect(badge.textContent).toBe("claude-code");
    expect(badge.getAttribute("title")).toBeNull();
  });

  it("renders nothing without agent context", () => {
    const { queryByTestId } = render(
      <CommentItem slug="p" issueNumber={1} comment={comment(null)} />,
    );
    expect(queryByTestId("agent-context-badge")).toBeNull();
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
      "claude-code · claude-fable-5",
    );
  });
});
