import { waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { CommentItem } from "../src/components/timeline/comment-item.tsx";
import { EventRow } from "../src/components/timeline/event-row.tsx";
// CommentItem needs a query client (edit mutation) and a router (the
// timestamp permalink Link).
import { renderWithProviders as render } from "./render.tsx";

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
  it("shows agent · model with the session in the tooltip", async () => {
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
    const badge = await waitFor(() => getByTestId("agent-context-badge"));
    expect(badge.textContent).toBe("claude-code · claude-fable-5");
    expect(badge.getAttribute("title")).toBe("session sess-123");
  });

  it("degrades to the agent name alone", async () => {
    const { getByTestId } = render(
      <CommentItem
        slug="p"
        issueNumber={1}
        comment={comment({ agent: "claude-code" })}
      />,
    );
    const badge = await waitFor(() => getByTestId("agent-context-badge"));
    expect(badge.textContent).toBe("claude-code");
    expect(badge.getAttribute("title")).toBeNull();
  });

  it("renders nothing without agent context", async () => {
    const { queryByTestId, getByText } = render(
      <CommentItem slug="p" issueNumber={1} comment={comment(null)} />,
    );
    await waitFor(() => getByText("hello"));
    expect(queryByTestId("agent-context-badge")).toBeNull();
  });

  it("also marks event rows", async () => {
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
    await waitFor(() =>
      expect(getByTestId("agent-context-badge").textContent).toBe(
        "claude-code · claude-fable-5",
      ),
    );
  });
});
