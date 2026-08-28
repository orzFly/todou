import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, waitFor } from "@testing-library/react";
import type { CommandInput, Label, Me, Member, Status } from "@todou/shared";
import { describe, expect, it, vi } from "vitest";
import {
  labelsQuery,
  membersQuery,
  meQuery,
  statusesQuery,
} from "../src/api/queries.ts";
import { Composer, submitLabel } from "../src/components/timeline/composer.tsx";
import { cmGetValue, cmSetValue } from "./cm.ts";

describe("submitLabel", () => {
  const base = {
    uploading: false,
    running: false,
    broken: 0,
    summaries: [] as string[],
    withComment: true,
  };

  it("names the comment alone when there are no commands", () => {
    expect(submitLabel(base)).toBe("Comment");
  });

  it("joins one command with an and, several with a comma", () => {
    expect(submitLabel({ ...base, summaries: ["close"] })).toBe(
      "Comment and close",
    );
    expect(submitLabel({ ...base, summaries: ["label bug", "close"] })).toBe(
      "Comment, label bug and close",
    );
  });

  it("drops the comment wording for a commands-only draft", () => {
    expect(
      submitLabel({ ...base, summaries: ["close"], withComment: false }),
    ).toBe("Run: close");
  });

  it("asks for a fix instead of advertising a blocked action", () => {
    expect(submitLabel({ ...base, broken: 1, summaries: ["close"] })).toBe(
      "Fix the command",
    );
    expect(submitLabel({ ...base, broken: 2 })).toBe("Fix 2 commands");
  });

  it("reports work in flight ahead of everything else", () => {
    expect(submitLabel({ ...base, uploading: true, broken: 1 })).toBe(
      "Uploading…",
    );
    expect(submitLabel({ ...base, running: true, summaries: ["close"] })).toBe(
      "Running…",
    );
  });
});

const status = (
  id: number,
  name: string,
  category: "open" | "closed",
  position: number,
  is_default = false,
): Status => ({ id, name, category, color: "#000000", position, is_default });

const ME: Me = {
  id: 100,
  login: "alice",
  display_name: "Alice",
  kind: "human",
  avatar_url: null,
  owner: null,
  email: null,
  is_instance_admin: false,
  created_at: "2026-01-01T00:00:00.000Z",
};

const MEMBERS: Member[] = [
  { user: ME, role: "writer", created_at: "2026-01-01T00:00:00.000Z" },
];
const LABELS: Label[] = [{ id: 10, name: "bug", color: "#ff0000" }];
const STATUSES: Status[] = [
  status(1, "Todo", "open", 0, true),
  status(2, "In Progress", "open", 1),
  status(3, "Done", "closed", 2),
];

function mount(
  handlers: {
    onSend?: (body: string) => void;
    onSendWithCommands?: (
      body: string,
      commands: CommandInput[],
    ) => Promise<unknown>;
  } = {},
) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  client.setQueryData(statusesQuery("todou").queryKey, STATUSES);
  client.setQueryData(labelsQuery("todou").queryKey, LABELS);
  client.setQueryData(membersQuery("todou").queryKey, MEMBERS);
  client.setQueryData(meQuery.queryKey, ME);
  const onSend = handlers.onSend ?? vi.fn();
  const onSendWithCommands =
    handlers.onSendWithCommands ?? vi.fn(async () => undefined);
  const view = render(
    <QueryClientProvider client={client}>
      <Composer
        slug="todou"
        issueNumber={7}
        onSend={onSend}
        onSendWithCommands={onSendWithCommands}
        failed={[]}
        onRetry={vi.fn()}
      />
    </QueryClientProvider>,
  );
  return { ...view, onSend, onSendWithCommands };
}

const submitButton = (view: { container: HTMLElement }) => {
  const button = view.container.querySelector('button[type="submit"]');
  if (button === null) throw new Error("no submit button");
  return button as HTMLButtonElement;
};

describe("Composer with slash commands", () => {
  it("says what the submit is about to do", async () => {
    const view = mount();
    await waitFor(() => expect(submitButton(view).disabled).toBe(true));
    expect(submitButton(view).textContent).toContain("Comment");

    cmSetValue(view.container, "just talking");
    await waitFor(() => expect(submitButton(view).disabled).toBe(false));
    expect(submitButton(view).textContent).toContain("Comment");

    cmSetValue(view.container, "shipping this\n/close");
    await waitFor(() =>
      expect(submitButton(view).textContent).toContain("Comment and close"),
    );

    cmSetValue(view.container, "/close");
    await waitFor(() =>
      expect(submitButton(view).textContent).toContain("Run: close"),
    );

    cmSetValue(view.container, "/in-progress\n/label bug");
    await waitFor(() =>
      expect(submitButton(view).textContent).toContain(
        "Run: move to In Progress and label bug",
      ),
    );
  });

  it("sends a plain comment down the optimistic path", async () => {
    const view = mount();
    cmSetValue(view.container, "no commands here");
    await waitFor(() => expect(submitButton(view).disabled).toBe(false));
    submitButton(view).click();
    await waitFor(() =>
      expect(view.onSend).toHaveBeenCalledWith("no commands here"),
    );
    expect(view.onSendWithCommands).not.toHaveBeenCalled();
  });

  it("strips the command lines out of the body it submits", async () => {
    const view = mount();
    cmSetValue(view.container, "shipping this\n/close\n/label bug");
    await waitFor(() => expect(submitButton(view).disabled).toBe(false));
    submitButton(view).click();
    await waitFor(() =>
      expect(view.onSendWithCommands).toHaveBeenCalledWith("shipping this", [
        { type: "status", status_id: 3 },
        { type: "label_add", label_id: 10 },
      ]),
    );
    expect(view.onSend).not.toHaveBeenCalled();
  });

  it("submits commands with no body at all", async () => {
    const view = mount();
    cmSetValue(view.container, "/close");
    await waitFor(() => expect(submitButton(view).disabled).toBe(false));
    submitButton(view).click();
    await waitFor(() =>
      expect(view.onSendWithCommands).toHaveBeenCalledWith("", [
        { type: "status", status_id: 3 },
      ]),
    );
  });

  it("blocks the submit and says why when an argument names nothing", async () => {
    const view = mount();
    cmSetValue(view.container, "/label nope");
    await waitFor(() => expect(submitButton(view).disabled).toBe(true));
    expect(view.container.textContent).toContain('no label named "nope"');
    expect(submitButton(view).textContent).toContain("Fix the command");
    submitButton(view).click();
    expect(view.onSendWithCommands).not.toHaveBeenCalled();
    expect(view.onSend).not.toHaveBeenCalled();
  });

  it("keeps the draft verbatim when the server refuses", async () => {
    const view = mount({
      onSendWithCommands: vi.fn(async () => {
        throw new Error("no");
      }),
    });
    cmSetValue(view.container, "shipping this\n/close");
    await waitFor(() => expect(submitButton(view).disabled).toBe(false));
    submitButton(view).click();
    await waitFor(() => expect(view.onSendWithCommands).toHaveBeenCalled());
    // Command lines included — the draft is the only copy of the submission.
    expect(cmGetValue(view.container)).toBe("shipping this\n/close");
  });

  it("clears the draft once the submission lands", async () => {
    const view = mount();
    cmSetValue(view.container, "shipping this\n/close");
    await waitFor(() => expect(submitButton(view).disabled).toBe(false));
    submitButton(view).click();
    await waitFor(() => expect(cmGetValue(view.container)).toBe(""));
  });

  it("highlights the command lines and leaves prose alone", async () => {
    const view = mount();
    cmSetValue(view.container, "prose\n/close\n/label nope\n```\n/close\n```");
    await waitFor(() =>
      expect(
        view.container.querySelectorAll(".cm-command-line").length,
      ).toBeGreaterThan(0),
    );
    const lines = [...view.container.querySelectorAll(".cm-line")].map(
      (line) => ({
        text: line.textContent,
        command: line.classList.contains("cm-command-line"),
        broken: line.classList.contains("cm-command-line-broken"),
      }),
    );
    expect(lines.filter((l) => l.command).map((l) => l.text)).toEqual([
      "/close",
      "/label nope",
    ]);
    expect(lines.filter((l) => l.broken).map((l) => l.text)).toEqual([
      "/label nope",
    ]);
  });
});
