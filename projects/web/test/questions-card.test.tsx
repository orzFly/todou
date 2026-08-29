import { fireEvent, waitFor } from "@testing-library/react";
import type { QuestionsComponent } from "@todou/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { QuestionsCard } from "../src/components/timeline/questions-card.tsx";
import { cmSetValue } from "./cm.ts";
import { renderWithProviders } from "./render.tsx";

const user = {
  id: 1,
  login: "user",
  display_name: "User",
  kind: "human" as const,
  avatar_url: null,
  owner: null,
};

const component: QuestionsComponent = {
  type: "questions",
  questions: [
    {
      key: "schema",
      header: "Data model",
      question: "Where does the payload live?",
      multiple: false,
      options: [{ label: "New entity" }, { label: "Inline" }],
    },
    {
      key: "scope",
      question: "Which environments?",
      multiple: true,
      options: [{ label: "dev" }, { label: "prod" }],
    },
  ],
};

const item = (answer: unknown) => ({
  comment_id: 42,
  author: user,
  created_at: "2026-08-12T00:00:00Z",
  questions: component.questions,
  answer,
});

/** Route-table fetch stub; records POST bodies for assertions. */
function stubFetch(answer: unknown = null) {
  const posts: unknown[] = [];
  vi.stubGlobal("fetch", async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (method === "GET" && url.includes("/questions")) {
      return Response.json({ items: [item(answer)], open: answer ? 0 : 2 });
    }
    if (method === "POST" && url.includes("/comments/42/answers")) {
      posts.push(JSON.parse(String(init?.body)));
      return Response.json(
        { type: "event", id: 7, event_type: "question_answered" },
        { status: 201 },
      );
    }
    throw new Error(`unexpected fetch: ${method} ${url}`);
  });
  return posts;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

function renderCard() {
  return renderWithProviders(
    <QuestionsCard
      slug="p"
      issueNumber={19}
      commentId={42}
      component={component}
    />,
  );
}

const optionButton = (
  view: { getByText: (t: string) => HTMLElement },
  label: string,
) => view.getByText(label).closest("button") as HTMLButtonElement;

describe("QuestionsCard (unanswered)", () => {
  it("gates submit until every question is resolved", async () => {
    stubFetch();
    const view = renderCard();
    await view.findByText("awaiting answer");

    const submit = () =>
      view.container.querySelector<HTMLButtonElement>(
        ".flex.justify-end > button",
      ) as HTMLButtonElement;
    expect(submit().disabled).toBe(true);

    fireEvent.click(optionButton(view, "New entity"));
    expect(submit().disabled).toBe(true); // second question still open

    fireEvent.click(optionButton(view, "dev"));
    await waitFor(() => expect(submit().disabled).toBe(false));
  });

  it("keeps single-select single and decline exclusive", async () => {
    stubFetch();
    const view = renderCard();
    await view.findByText("awaiting answer");

    // Radio semantics: the second pick replaces the first.
    fireEvent.click(optionButton(view, "New entity"));
    fireEvent.click(optionButton(view, "Inline"));
    expect(optionButton(view, "New entity").getAttribute("aria-pressed")).toBe(
      "false",
    );
    expect(optionButton(view, "Inline").getAttribute("aria-pressed")).toBe(
      "true",
    );

    // Declining clears the selection; re-selecting withdraws the decline.
    const declines = view.getAllByText("Decline to answer");
    const declineBtn = declines[0]?.closest("button") as HTMLButtonElement;
    fireEvent.click(declineBtn);
    expect(declineBtn.getAttribute("aria-pressed")).toBe("true");
    expect(optionButton(view, "Inline").getAttribute("aria-pressed")).toBe(
      "false",
    );
    fireEvent.click(optionButton(view, "Inline"));
    expect(declineBtn.getAttribute("aria-pressed")).toBe("false");
  });

  it("re-clicking a selected option clears it, back to unanswered", async () => {
    stubFetch();
    const view = renderCard();
    await view.findByText("awaiting answer");

    const submit = () =>
      view.container.querySelector<HTMLButtonElement>(
        ".flex.justify-end > button",
      ) as HTMLButtonElement;

    // Both questions resolved, so the gate opens…
    fireEvent.click(optionButton(view, "New entity"));
    fireEvent.click(optionButton(view, "dev"));
    expect(optionButton(view, "New entity").getAttribute("aria-pressed")).toBe(
      "true",
    );
    await waitFor(() => expect(submit().disabled).toBe(false));

    // …and clearing the single-select pick closes it again (T-181).
    fireEvent.click(optionButton(view, "New entity"));
    expect(optionButton(view, "New entity").getAttribute("aria-pressed")).toBe(
      "false",
    );
    await waitFor(() => expect(submit().disabled).toBe(true));

    // Multi-select deselect keeps working.
    fireEvent.click(optionButton(view, "dev"));
    expect(optionButton(view, "dev").getAttribute("aria-pressed")).toBe(
      "false",
    );

    // Clearing an option does not hand the question back to decline…
    const declines = view.getAllByText("Decline to answer");
    const declineBtn = declines[0]?.closest("button") as HTMLButtonElement;
    fireEvent.click(declineBtn);
    fireEvent.click(optionButton(view, "Inline"));
    fireEvent.click(optionButton(view, "Inline"));
    expect(optionButton(view, "Inline").getAttribute("aria-pressed")).toBe(
      "false",
    );
    expect(declineBtn.getAttribute("aria-pressed")).toBe("false");
    // …it just stays available.
    fireEvent.click(declineBtn);
    expect(declineBtn.getAttribute("aria-pressed")).toBe("true");
  });

  it("submits everything at once, with other text and multi-select", async () => {
    const posts = stubFetch();
    const view = renderCard();
    await view.findByText("awaiting answer");

    fireEvent.click(optionButton(view, "Inline"));
    fireEvent.click(optionButton(view, "dev"));
    fireEvent.click(optionButton(view, "prod"));
    cmSetValue(view.container, "and keep it strict");

    const submit = await view.findByText("Submit answers");
    await waitFor(() =>
      expect((submit.closest("button") as HTMLButtonElement).disabled).toBe(
        false,
      ),
    );
    fireEvent.click(submit);

    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]).toEqual({
      answers: [
        {
          key: "schema",
          selected: [1],
          other: "and keep it strict",
          declined: false,
        },
        { key: "scope", selected: [0, 1], declined: false },
      ],
    });
  });
});

describe("QuestionsCard (answered)", () => {
  it("renders read-only results with no way back in", async () => {
    stubFetch({
      event_id: 7,
      actor: user,
      created_at: "2026-08-12T01:00:00Z",
      answers: [
        {
          key: "schema",
          selected: [{ index: 1, label: "Inline" }],
          other: "ship it",
          declined: false,
        },
        { key: "scope", selected: [], other: null, declined: true },
      ],
    });
    const view = renderCard();

    await view.findByText("answered by");
    expect(view.queryByText("Submit answers")).toBeNull();
    expect(view.queryByText("awaiting answer")).toBeNull();
    expect(view.getByText("declined to answer")).toBeTruthy();
    expect(view.getByText("ship it")).toBeTruthy();
    // No interactive option buttons remain.
    expect(view.getByText("Inline").closest("button")).toBeNull();
  });
});
