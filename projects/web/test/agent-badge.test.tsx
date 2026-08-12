import { fireEvent, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CommentItem } from "../src/components/timeline/comment-item.tsx";
import { EventRow } from "../src/components/timeline/event-row.tsx";
import { renderWithProviders } from "./render.tsx";

vi.mock("sonner", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  toast: { success: vi.fn(), error: vi.fn() },
}));
const { toast } = await import("sonner");

const user = {
  id: 2,
  login: "claude-agent",
  display_name: "Claude @ Bot One",
  kind: "machine" as const,
  avatar_url: null,
  owner: { id: 1, login: "user" },
};

function comment(agentContext: unknown) {
  return {
    type: "comment" as const,
    id: 1,
    author: user,
    body: "hello",
    created_at: "2026-08-11T00:00:00Z",
    component: null,
    edited_at: null,
    // biome-ignore lint/suspicious/noExplicitAny: test fixture
    agent_context: agentContext as any,
  };
}

/* RouterProvider mounts asynchronously, so wait for the badge (scoped to
   this render's container — same-test renders share document.body). */
async function renderBadge(agentContext: unknown) {
  const view = renderWithProviders(
    <CommentItem slug="p" issueNumber={1} comment={comment(agentContext)} />,
  );
  return waitFor(() => {
    const el = view.container.querySelector<HTMLElement>(
      '[data-testid="agent-context-badge"]',
    );
    expect(el).not.toBeNull();
    return el as HTMLElement;
  });
}

describe("AgentContextBadge in the timeline", () => {
  it("shows the model name with harness + session in the tooltip", async () => {
    const badge = await renderBadge({
      agent: "claude-code",
      session_id: "sess-123",
      model: "claude-fable-5",
    });
    expect(badge.textContent).toBe("claude-fable-5");
    expect(badge.getAttribute("title")).toBe(
      "claude-code · session sess-123 — click to copy the resume command",
    );
  });

  it("falls back to the agent name without a model", async () => {
    const badge = await renderBadge({ agent: "claude-code" });
    expect(badge.textContent).toBe("claude-code");
    expect(badge.getAttribute("title")).toBe("claude-code");
  });

  it("renders nothing without agent context", async () => {
    const view = renderWithProviders(
      <CommentItem slug="p" issueNumber={1} comment={comment(null)} />,
    );
    // The comment body proves the row mounted; only then is a missing badge meaningful.
    await view.findByText("hello");
    expect(view.queryByTestId("agent-context-badge")).toBeNull();
  });

  it("colors the badge deterministically from the session id", async () => {
    const badgeIn = (sessionId: string) =>
      renderBadge({ agent: "claude-code", session_id: sessionId });

    const badge = await badgeIn("sess-123");
    expect(badge.classList.contains("agent-session-badge")).toBe(true);
    const hue = badge.style.getPropertyValue("--agent-h1");
    expect(hue).not.toBe("");

    expect(
      (await badgeIn("sess-123")).style.getPropertyValue("--agent-h1"),
    ).toBe(hue);
    expect(
      (await badgeIn("sess-124")).style.getPropertyValue("--agent-h1"),
    ).not.toBe(hue);
  });

  it("stays neutral without a session id", async () => {
    const badge = await renderBadge({
      agent: "claude-code",
      model: "claude-fable-5",
    });
    expect(badge.classList.contains("agent-session-badge")).toBe(false);
    expect(badge.style.getPropertyValue("--agent-h1")).toBe("");
  });

  it("picks the harness icon: Claude logo for claude-*, bot otherwise", async () => {
    const iconsIn = async (agent: string) => {
      const badge = await renderBadge({ agent, model: "some-model" });
      return {
        claude: badge.querySelector('[data-testid="harness-icon-claude"]'),
        bot: badge.querySelector('[data-testid="harness-icon-bot"]'),
      };
    };

    const claude = await iconsIn("claude-code");
    expect(claude.claude).not.toBeNull();
    expect(claude.bot).toBeNull();

    const other = await iconsIn("aider");
    expect(other.bot).not.toBeNull();
    expect(other.claude).toBeNull();
  });

  it("copies the resume command on click without bubbling to the row", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    const rowClick = vi.fn();
    const view = renderWithProviders(
      // biome-ignore lint/a11y/useKeyWithClickEvents: stand-in for a timeline row with its own click handling
      // biome-ignore lint/a11y/noStaticElementInteractions: same stand-in
      <div onClick={rowClick}>
        <CommentItem
          slug="p"
          issueNumber={1}
          comment={comment({ agent: "claude-code", session_id: "sess-123" })}
        />
      </div>,
    );
    const badge = await view.findByTestId("agent-context-badge");
    expect(badge.tagName).toBe("BUTTON");

    fireEvent.click(badge);
    expect(writeText).toHaveBeenCalledExactlyOnceWith(
      "claude --resume sess-123",
    );
    expect(rowClick).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(toast.success).toHaveBeenCalledOnce());
  });

  it("is not clickable without a session id", async () => {
    const badge = await renderBadge({
      agent: "claude-code",
      model: "claude-fable-5",
    });
    expect(badge.tagName).not.toBe("BUTTON");
  });

  it("also marks event rows", async () => {
    const view = renderWithProviders(
      <EventRow
        slug="p"
        issueNumber={1}
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
    const badge = await view.findByTestId("agent-context-badge");
    expect(badge.textContent).toBe("claude-fable-5");
  });
});
