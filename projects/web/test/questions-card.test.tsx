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
      options: [
        {
          label: "New entity",
          description: "A clean row per record, plus a migration.",
        },
        {
          label: "Inline",
          description: "No migration; queries can never filter on it.",
        },
      ],
    },
    {
      key: "scope",
      question: "Which environments?",
      multiple: true,
      options: [
        { label: "dev", description: "Cheap to revert." },
        { label: "prod" },
      ],
    },
  ],
};

/** Same shape, no `description` anywhere: the expand toggle has nothing to show. */
const noDescriptions: QuestionsComponent = {
  type: "questions",
  questions: [
    {
      key: "schema",
      header: "Data model",
      question: "Where does the payload live?",
      multiple: false,
      options: [{ label: "New entity" }, { label: "Inline" }],
    },
  ],
};

const answered = {
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
};

const item = (answer: unknown, comp: QuestionsComponent) => ({
  comment_id: 42,
  author: user,
  created_at: "2026-08-12T00:00:00Z",
  questions: comp.questions,
  answer,
});

/** Route-table fetch stub; records POST bodies for assertions. */
function stubFetch(
  answer: unknown = null,
  comp: QuestionsComponent = component,
) {
  const posts: unknown[] = [];
  vi.stubGlobal("fetch", async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (method === "GET" && url.includes("/questions")) {
      return Response.json({
        items: [item(answer, comp)],
        open: answer ? 0 : 2,
      });
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
  // A range left standing would trip the next test's click guard.
  window.getSelection()?.removeAllRanges();
});

function renderCard(comp: QuestionsComponent = component) {
  return renderWithProviders(
    <QuestionsCard slug="p" issueNumber={19} commentId={42} component={comp} />,
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

  it("lets the option rows be selected for copying", async () => {
    stubFetch();
    const view = renderCard();
    await view.findByText("awaiting answer");

    // Chromium refuses to *start* a selection inside a <button> unless the
    // used value of user-select is overridden (T-235).
    expect(optionButton(view, "New entity").className).toContain("select-text");
    const declineBtn = view
      .getAllByText("Decline to answer")[0]
      ?.closest("button") as HTMLButtonElement;
    expect(declineBtn.className).toContain("select-text");
  });

  it("does not toggle an option when the click ends a selection in the row", async () => {
    stubFetch();
    const view = renderCard();
    await view.findByText("awaiting answer");

    const row = optionButton(view, "New entity");
    const textNode = view.getByText("New entity").firstChild as Node;
    window.getSelection()?.setBaseAndExtent(textNode, 0, textNode, 3);
    fireEvent.click(row);
    expect(row.getAttribute("aria-pressed")).toBe("false");
  });

  it("still toggles on a plain click, and past a selection elsewhere", async () => {
    stubFetch();
    const view = renderCard();
    await view.findByText("awaiting answer");

    fireEvent.click(optionButton(view, "New entity"));
    expect(optionButton(view, "New entity").getAttribute("aria-pressed")).toBe(
      "true",
    );

    // A selection left standing on the question text must not freeze the row:
    // the guard only fires for a selection that ends inside the row itself.
    const elsewhere = view.getByText("Where does the payload live?")
      .firstChild as Node;
    window.getSelection()?.setBaseAndExtent(elsewhere, 0, elsewhere, 5);
    fireEvent.click(optionButton(view, "New entity"));
    expect(optionButton(view, "New entity").getAttribute("aria-pressed")).toBe(
      "false",
    );
  });

  it("double-clicking a word toggles exactly once", async () => {
    stubFetch();
    const view = renderCard();
    await view.findByText("awaiting answer");

    // A double click dispatches two clicks: the first before the word is
    // selected, the second with it — so the net effect matches one click.
    fireEvent.click(optionButton(view, "New entity"));
    const textNode = view.getByText("New entity").firstChild as Node;
    window.getSelection()?.setBaseAndExtent(textNode, 0, textNode, 3);
    fireEvent.click(optionButton(view, "New entity"));
    expect(optionButton(view, "New entity").getAttribute("aria-pressed")).toBe(
      "true",
    );
  });
});

describe("QuestionsCard (answered)", () => {
  it("renders read-only results with no way back in", async () => {
    stubFetch(answered);
    const view = renderCard();

    await view.findByText("answered by");
    expect(view.queryByText("Submit answers")).toBeNull();
    expect(view.queryByText("awaiting answer")).toBeNull();
    expect(view.getByText("declined to answer")).toBeTruthy();
    expect(view.getByText("ship it")).toBeTruthy();
    // No interactive option buttons remain.
    expect(view.getByText("Inline").closest("button")).toBeNull();
  });

  it("hides the option descriptions until the toggle is pressed", async () => {
    stubFetch(answered);
    const view = renderCard();

    await view.findByText("answered by");
    expect(
      view.queryByText("A clean row per record, plus a migration."),
    ).toBeNull();
    const toggle = view
      .getByText("show option descriptions")
      .closest("button") as HTMLButtonElement;
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
  });

  it("keeps the picked option marked while descriptions are expanded", async () => {
    stubFetch(answered);
    const view = renderCard();

    await view.findByText("answered by");
    const picked = () =>
      view.container.querySelector(".bg-primary\\/10") as HTMLElement;
    const checks = () =>
      view.container.querySelectorAll("svg.text-primary").length;
    const before = checks();

    fireEvent.click(view.getByText("show option descriptions"));
    expect(
      view.getByText("No migration; queries can never filter on it."),
    ).toBeTruthy();
    // The unpicked option keeps its description too, just dimmed with the row.
    expect(
      view.getByText("A clean row per record, plus a migration."),
    ).toBeTruthy();
    expect(checks()).toBe(before);
    expect(picked().textContent).toContain("Inline");
    const toggle = view
      .getByText("hide option descriptions")
      .closest("button") as HTMLButtonElement;
    expect(toggle.getAttribute("aria-expanded")).toBe("true");

    fireEvent.click(toggle);
    expect(
      view.queryByText("No migration; queries can never filter on it."),
    ).toBeNull();
  });

  it("omits the toggle when no option carries a description", async () => {
    stubFetch(answered, noDescriptions);
    const view = renderCard(noDescriptions);

    await view.findByText("answered by");
    expect(view.queryByText("show option descriptions")).toBeNull();
  });
});
