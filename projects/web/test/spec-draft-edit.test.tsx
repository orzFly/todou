import { act, fireEvent, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AnnotatedMarkdown } from "../src/components/spec/annotated-markdown.tsx";
import { SpecComposer } from "../src/components/spec/spec-composer.tsx";
import type { SpecReviewDraft } from "../src/lib/spec-drafts.ts";
import { cmGetValue, cmSetValue } from "./cm.ts";
import { renderWithProviders } from "./render.tsx";

// T-159: a staged draft used to be write-once — Discard was the only way to
// change a word. Edit loads it back into the composer it was written in.

const DRAFT: SpecReviewDraft = {
  id: "d1",
  anchor: {
    path: "design.md",
    version: 1,
    line_start: 1,
    line_end: 1,
    col_start: null,
    col_end: null,
  },
  quote: "Alpha beta gamma.",
  body: "needs a caveat",
};

const STAGING = {
  path: "design.md",
  version: 1,
  lineStart: 1,
  lineEnd: 1,
  colStart: null,
  colEnd: null,
  quote: "Alpha beta gamma.",
};

describe("draft chip Edit affordance", () => {
  async function openChip(onEditDraft: (draft: SpecReviewDraft) => void) {
    const view = renderWithProviders(
      <AnnotatedMarkdown
        slug="p"
        issueNumber={1}
        body={"Alpha beta gamma.\n"}
        annotations={[
          {
            key: DRAFT.id,
            kind: "draft",
            draft: DRAFT,
            start: 1,
            end: 1,
            colStart: null,
            colEnd: null,
          },
        ]}
        onStage={() => {}}
        onEditDraft={onEditDraft}
        onRemoveDraft={() => {}}
        onResolve={() => {}}
      />,
    );
    const chip = await view.findByLabelText(/comment\(s\) on this block/);
    fireEvent.click(chip);
    return view;
  }

  it("hands the whole draft back and closes the popover", async () => {
    const onEditDraft = vi.fn();
    const view = await openChip(onEditDraft);

    expect(await view.findByText("needs a caveat")).toBeTruthy();
    fireEvent.click(view.getByText("Edit"));

    expect(onEditDraft).toHaveBeenCalledWith(DRAFT);
    // The composer opens at the bottom of the page; a popover left standing
    // over it would cover what the user came to rewrite.
    await waitFor(() => expect(view.queryByText("Edit")).toBeNull());
  });

  it("leaves Discard alongside it", async () => {
    const view = await openChip(() => {});
    expect(await view.findByText("Discard")).toBeTruthy();
  });
});

describe("SpecComposer editing an existing draft", () => {
  it("opens on the draft's body and stages the rewrite", async () => {
    const onStage = vi.fn();
    const view = renderWithProviders(
      <SpecComposer
        slug="p"
        staging={STAGING}
        initialBody={DRAFT.body}
        editing
        onCancel={() => {}}
        onStage={onStage}
      />,
    );

    const submit = await view.findByText("Update draft");
    expect(cmGetValue(view.baseElement)).toBe("needs a caveat");
    // Unedited text is still a valid update — the button cannot start
    // disabled the way an empty new comment does.
    expect((submit as HTMLButtonElement).disabled).toBe(false);

    // The submit button reads React state fed by the editor's onChange, so
    // the change has to be flushed before the click, as a real keystroke is.
    act(() => cmSetValue(view.baseElement, "needs a caveat, and a test"));
    fireEvent.click(submit);
    expect(onStage).toHaveBeenCalledWith("needs a caveat, and a test");
  });

  it("stays a new-comment composer without initialBody", async () => {
    const view = renderWithProviders(
      <SpecComposer
        slug="p"
        staging={STAGING}
        onCancel={() => {}}
        onStage={() => {}}
      />,
    );

    const submit = await view.findByText("Stage comment");
    expect(cmGetValue(view.baseElement)).toBe("");
    expect((submit as HTMLButtonElement).disabled).toBe(true);
    expect(view.queryByText("Update draft")).toBeNull();
  });
});
