import { fireEvent, screen, waitFor } from "@testing-library/react";
import type { IssueMetadataEntry, MemberRole, Project } from "@todou/shared";
import { StrictMode } from "react";
import { describe, expect, it } from "vitest";
import { issueMetadataQuery } from "../src/api/metadata.ts";
import { projectQuery } from "../src/api/queries.ts";
import { MetadataSection } from "../src/components/issue/metadata-section.tsx";
import { renderWithProviders, testQueryClient } from "./render.tsx";

const SLUG = "p";
const NUMBER = 282;

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
    slug: SLUG,
    name: "Project",
    viewer_role: role,
  }) as unknown as Project;

/**
 * The app mounts under StrictMode (main.tsx), whose double mount/unmount
 * used to eat the pending jump: the first EditorView claimed the jump and
 * was then discarded by StrictMode's remount, so no snippet ever appeared
 * and the click looked dead. Falsifies by: reverting to a jump that binds
 * to the first-mounted instance (or drops the pending state on unmount) —
 * under StrictMode the text below will not contain the snippet line.
 */
describe("jump survives StrictMode double mount", () => {
  it("inserts the snippet after a browse → bulk remount", async () => {
    const client = testQueryClient();
    client.setQueryData(projectQuery(SLUG).queryKey, project("writer"));
    client.setQueryData(issueMetadataQuery(SLUG, NUMBER).queryKey, {
      entries: [
        entry("ci", "status", "passing"),
        entry("deploy", "host", "todou"),
      ],
    });
    renderWithProviders(
      <StrictMode>
        <MetadataSection slug={SLUG} issueNumber={NUMBER} />
      </StrictMode>,
      client,
    );
    fireEvent.click(await screen.findByTestId("metadata-open"));
    await waitFor(() => expect(screen.getByRole("dialog")).toBeTruthy());
    // Visit Bulk first, then leave: the jump's target tab was opened and
    // unmounted once before the click, which is the exact StrictMode
    // discard-and-remount sequence.
    fireEvent.mouseDown(screen.getByRole("tab", { name: "Bulk" }));
    await waitFor(() =>
      expect(screen.getByTestId("metadata-editor-tab")).toBeTruthy(),
    );
    fireEvent.mouseDown(screen.getByRole("tab", { name: "Browse" }));
    await waitFor(() =>
      expect(screen.queryByTestId("metadata-editor-tab")).toBeNull(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Add key in deploy" }));
    await waitFor(() =>
      expect(screen.getByTestId("metadata-editor-tab")).toBeTruthy(),
    );
    await waitFor(() => {
      const text =
        document.querySelector('[data-slot="code-editor"] .cm-content')
          ?.textContent ?? "";
      expect(text).toContain("deploy/key = value");
    });
  });
});
