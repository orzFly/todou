// The escape: a server-rendered doc that cannot parse must still let the
// reader leave the tab — via JSON re-render AND via Browse.

import { Transaction } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import type { IssueMetadataEntry, MemberRole, Project } from "@todou/shared";
import { StrictMode } from "react";
import { describe, expect, it } from "vitest";
import { issueMetadataQuery } from "../src/api/metadata.ts";
import { projectQuery } from "../src/api/queries.ts";
import { MetadataSection } from "../src/components/issue/metadata-section.tsx";
import { hasUnsavedWork } from "../src/lib/unsaved-guard.ts";
import { cmGetValue, cmSetValue } from "./cm.ts";
import { renderWithProviders, testQueryClient } from "./render.tsx";

const writer = {
  id: 7,
  login: "bot-one",
  display_name: "Toolbot",
  kind: "machine" as const,
  avatar_url: null,
  owner: null,
};
const hourAgo = new Date(Date.now() - 3_600_000).toISOString();
const entry = (
  namespace: string,
  key: string,
  value: string,
): IssueMetadataEntry => ({
  namespace,
  key,
  value,
  updated_at: hourAgo,
  updated_by: writer,
});
const project = (role: MemberRole) =>
  ({
    id: 1,
    slug: "p",
    name: "Project",
    viewer_role: role,
  }) as unknown as Project;

function mountWithUnparseableRender() {
  // An empty key is storable via the JSON tab and server-side, but its Bulk
  // render (`ci/ = v`) cannot parse back — independent of T-341's `<<MARK`
  // round-trip defect. This is the stand-in for "an untouched document
  // whose render cannot parse", reachable through real data.
  const client = testQueryClient();
  client.setQueryData(projectQuery("p").queryKey, project("writer"));
  client.setQueryData(issueMetadataQuery("p", 282).queryKey, {
    entries: [entry("ci", "", "v")],
  });
  return renderWithProviders(
    <StrictMode>
      <MetadataSection slug="p" issueNumber={282} />
    </StrictMode>,
    client,
  );
}

describe("an untouched document that cannot parse is not a trap", () => {
  it("escapes to JSON, re-rendering from the snapshot", async () => {
    mountWithUnparseableRender();
    await openAndGoBulk();
    fireEvent.mouseDown(screen.getByRole("tab", { name: "JSON" }));
    await editorMounted();
    await new Promise((r) => setTimeout(r, 150));
    // Re-rendered from the snapshot: empty key survives as a JSON member.
    expect(cmGetValue(document.body)).toBe(
      '{\n  "ci": {\n    "": "v"\n  }\n}\n',
    );
  });

  it("escapes to Browse as a clean document", async () => {
    mountWithUnparseableRender();
    await openAndGoBulk();
    fireEvent.mouseDown(screen.getByRole("tab", { name: "Browse" }));
    await waitFor(() =>
      expect(
        screen
          .getByRole("tab", { name: "Browse" })
          .getAttribute("aria-selected"),
      ).toBe("true"),
    );
    await waitFor(() =>
      expect(screen.queryByTestId("metadata-editor-tab")).toBeNull(),
    );
  });

  it("a typed unparseable edit is still held", async () => {
    mountWithUnparseableRender();
    await openAndGoBulk();
    cmSetValue(await editorMounted(), "Bad = line");
    fireEvent.mouseDown(screen.getByRole("tab", { name: "JSON" }));
    await new Promise((r) => setTimeout(r, 400));
    expect(
      screen.getByRole("tab", { name: "JSON" }).getAttribute("aria-selected"),
    ).toBe("false");
    expect(screen.getByTestId("metadata-editor-tab").textContent).toContain(
      "line 1",
    );
  });

  it("escapes on every hop of a full Bulk → JSON → Bulk → JSON walk", async () => {
    // v4's escape died on the second hop: provenance must survive
    // re-renders, not track whichever text the previous tab happened to
    // spell. Falsifies by: any rendering-adjacent provenance (the old
    // session.renderedText) — hop four starts refusing again.
    mountWithUnparseableRender();
    await openAndGoBulk();
    for (const target of ["JSON", "Bulk", "JSON"] as const) {
      fireEvent.mouseDown(screen.getByRole("tab", { name: target }));
      await editorMounted();
      await waitFor(() => {
        expect(
          screen
            .getByRole("tab", { name: target })
            .getAttribute("aria-selected"),
        ).toBe("true");
      });
    }
    // Still unedited: Browse is reachable at the end of the walk.
    fireEvent.mouseDown(screen.getByRole("tab", { name: "Browse" }));
    await waitFor(() => {
      expect(screen.queryByTestId("metadata-editor-tab")).toBeNull();
    });
  });

  it("holds an edit made BEFORE a switch when Browse is clicked after it", async () => {
    // v5's provenance died exactly here: the flag lived on the panel, one
    // switch remounted it, and Browse silently dropped the draft while the
    // shell's own guard still held the same work. Provenance must ride the
    // session. Falsifies by: any per-panel provenance.
    mountWithUnparseableRender();
    await openAndGoBulk();
    cmSetValue(await editorMounted(), "ci/k = EDITED-UNSAVED");
    fireEvent.mouseDown(screen.getByRole("tab", { name: "JSON" }));
    await editorMounted();
    // Draft carried; now Browse.
    fireEvent.mouseDown(screen.getByRole("tab", { name: "Browse" }));
    await waitFor(() => {
      expect(
        screen
          .getByRole("tab", { name: "Browse" })
          .getAttribute("aria-selected"),
      ).toBe("false");
    });
    expect(screen.getByTestId("metadata-editor-tab")).toBeTruthy();
    expect(screen.getByTestId("metadata-editor-tab").textContent).toContain(
      "save or discard",
    );
  });

  it("holds a move.* transaction (line move) as an edit", async () => {
    // defaultKeymap's Alt-ArrowDown moves a line with the userEvent
    // "move.line" — not input/delete, so an input/delete whitelist cannot
    // see it and Browse would drop the reorder. cmSetValue cannot produce
    // this shape either (it stamps "input.type"), which is why the heredoc
    // seed goes into the mount entries and the move.line dispatch is the
    // ONLY docChanged transaction this test produces.
    //
    // The move swaps the heredoc's two body lines — it CHANGES the value
    // ("alpha\nbeta" → "beta\nalpha"), so this guards a real loss of work,
    // not a semantically-neutral reorder. Preconditions pin the isolation:
    // the shown text is the factory serialization and nothing is unsaved
    // yet, so the ONLY thing that can hold Browse afterwards is the gate's
    // provenance judge.
    const client = testQueryClient();
    client.setQueryData(projectQuery("p").queryKey, project("writer"));
    client.setQueryData(issueMetadataQuery("p", 282).queryKey, {
      entries: [entry("ci", "k", "alpha\nbeta")],
    });
    renderWithProviders(
      <StrictMode>
        <MetadataSection slug="p" issueNumber={282} />
      </StrictMode>,
      client,
    );
    fireEvent.click(await screen.findByTestId("metadata-open"));
    await waitFor(() => expect(screen.getByRole("dialog")).toBeTruthy());
    fireEvent.mouseDown(screen.getByRole("tab", { name: "Bulk" }));
    await editorMounted();
    await new Promise((r) => setTimeout(r, 150));
    const content = screen
      .getByTestId("metadata-editor-tab")
      .querySelector(".cm-content");
    const view =
      content === null
        ? undefined
        : EditorView.findFromDOM(content as HTMLElement);
    if (!view) throw new Error("editor view not mounted");
    // Factory render of the heredoc value; untouched, nothing unsaved.
    expect(view.state.doc.toString()).toBe("ci/k = <<EOF\nalpha\nbeta\nEOF");
    expect(hasUnsavedWork()).toBe(false);
    // The move swaps the body lines: value becomes "beta\nalpha".
    view.dispatch({
      changes: {
        from: 0,
        to: view.state.doc.length,
        insert: "ci/k = <<EOF\nbeta\nalpha\nEOF",
      },
      annotations: Transaction.userEvent.of("move.line"),
    });
    // The gate (session provenance) must hold this: Browse cannot show the
    // edited draft, and the rejection names its rule.
    fireEvent.mouseDown(screen.getByRole("tab", { name: "Browse" }));
    await waitFor(() => {
      expect(
        screen
          .getByRole("tab", { name: "Browse" })
          .getAttribute("aria-selected"),
      ).toBe("false");
    });
    expect(screen.getByTestId("metadata-editor-tab").textContent).toContain(
      "save or discard",
    );
  });

  it("escapes when the editor normalizes the text on its own (CRLF)", async () => {
    // A value containing \r\n: serializeBulk keeps the \r, CodeMirror's
    // mount normalizes it. diffMetadata then reads a change the reader
    // never made, and under v4 Browse refused it — Discard could not
    // rescue it. Provenance survives that too. Falsifies by: gateless
    // diff comparison (v4) — this stays red there.
    const client = testQueryClient();
    client.setQueryData(projectQuery("p").queryKey, project("writer"));
    client.setQueryData(issueMetadataQuery("p", 282).queryKey, {
      entries: [entry("ci", "k", "a\r\nb")],
    });
    renderWithProviders(
      <StrictMode>
        <MetadataSection slug="p" issueNumber={282} />
      </StrictMode>,
      client,
    );
    fireEvent.click(await screen.findByTestId("metadata-open"));
    await waitFor(() => expect(screen.getByRole("dialog")).toBeTruthy());
    fireEvent.mouseDown(screen.getByRole("tab", { name: "Bulk" }));
    await editorMounted();
    await new Promise((r) => setTimeout(r, 150));
    fireEvent.mouseDown(screen.getByRole("tab", { name: "Browse" }));
    await waitFor(() => {
      expect(screen.queryByTestId("metadata-editor-tab")).toBeNull();
    });
  });
});

async function openAndGoBulk() {
  fireEvent.click(await screen.findByTestId("metadata-open"));
  await waitFor(() => expect(screen.getByRole("dialog")).toBeTruthy());
  fireEvent.mouseDown(screen.getByRole("tab", { name: "Bulk" }));
  await editorMounted();
  await new Promise((r) => setTimeout(r, 150));
}

async function editorMounted(): Promise<HTMLElement> {
  await waitFor(() => {
    expect(
      screen.getByTestId("metadata-editor-tab").querySelector(".cm-content"),
    ).not.toBeNull();
  });
  return document.body;
}
