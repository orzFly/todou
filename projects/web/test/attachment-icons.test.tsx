import type { QueryClient } from "@tanstack/react-query";
import { waitFor } from "@testing-library/react";
import type { Attachment } from "@todou/shared";
import { describe, expect, it } from "vitest";
import { attachmentsQuery } from "../src/api/attachments.ts";
import {
  AttachmentEventLink,
  AttachmentList,
  AttachmentRichLink,
  AttachmentSidebarSection,
} from "../src/components/issue/attachment-list.tsx";
import { renderWithProviders, testQueryClient } from "./render.tsx";

/**
 * One icon table, every surface that draws from it (T-401). The archive,
 * audio and video tiers were added for the timeline rows, and the table is
 * shared, so the body list, the sidebar and markdown rich links show them
 * as well. That reach is the subject here — each surface's own layout is
 * covered by its own file.
 */

const uploader = {
  id: 1,
  login: "bot-one",
  display_name: "bot-one",
  kind: "machine" as const,
  avatar_url: null,
  owner: null,
};

/**
 * Filename, declared type, and the icon the shared table owes it. The audio
 * and video glyphs are `file-headphone` and `file-play` in lucide's current
 * naming; `FileAudio` and `FileVideo` are aliases of them.
 */
const FILES = [
  ["shot.png", "image/png", "lucide-image"],
  ["bundle.zip", "application/zip", "lucide-file-archive"],
  ["take.mp3", "audio/mpeg", "lucide-file-headphone"],
  ["clip.mp4", "video/mp4", "lucide-file-play"],
] as const;

const WANTED = FILES.map(([, , identity]) => identity);

const attachment = (index: number): Attachment => {
  const [filename, content_type] = FILES[index] as (typeof FILES)[number];
  return {
    id: index + 1,
    filename,
    content_type,
    size: 512,
    url: `/api/projects/demo/attachments/${index + 1}/download/${filename}`,
    uploader,
    created_at: `2026-09-01T00:0${index}:00Z`,
    aliases: [],
  };
};

function seeded(): QueryClient {
  const client = testQueryClient();
  client.setQueryData(
    attachmentsQuery("demo", 7).queryKey,
    FILES.map((_, i) => attachment(i)),
  );
  return client;
}

/**
 * lucide writes the icon's identity into a class of its own. Read it off
 * `classList` rather than the joined string: `lucide-file-archive` contains
 * `lucide-file`, so a substring test would accept the fallback icon.
 */
const identityOf = (icon: Element | null | undefined) =>
  [...(icon?.classList ?? [])].find((c) => c.startsWith("lucide-")) ?? null;

// The body list puts a download icon in a second anchor on each row; the
// type icon is the first one, inside the row link.
const iconsOf = (roots: Iterable<Element>) =>
  [...roots].map((root) => identityOf(root.querySelector("a svg")));

describe("the shared attachment icon table", () => {
  it("types every row of the body list", async () => {
    const view = renderWithProviders(
      <AttachmentList slug="demo" issueNumber={7} />,
      seeded(),
    );
    await waitFor(() => {
      const rows = view.container.querySelectorAll("li");
      expect(rows).toHaveLength(FILES.length);
      expect(iconsOf(rows)).toEqual(WANTED);
    });
  });

  it("types every row of the sidebar section", async () => {
    const view = renderWithProviders(
      <AttachmentSidebarSection slug="demo" issueNumber={7} />,
      seeded(),
    );
    const section = await view.findByTestId("attachment-sidebar");
    await waitFor(() => {
      const rows = section.querySelectorAll("li");
      expect(rows).toHaveLength(FILES.length);
      expect(iconsOf(rows)).toEqual(WANTED);
    });
  });

  it("types a markdown rich link", async () => {
    const view = renderWithProviders(
      <div>
        {FILES.map(([filename], i) => (
          <AttachmentRichLink
            key={filename}
            slug="demo"
            issueNumber={7}
            attachmentId={i + 1}
            href={`/api/projects/demo/attachments/${i + 1}/download/${filename}`}
            fallbackName={filename}
          />
        ))}
      </div>,
      seeded(),
    );
    await waitFor(() =>
      expect(
        [...view.container.querySelectorAll("a")].map((a) =>
          identityOf(a.querySelector("svg")),
        ),
      ).toEqual(WANTED),
    );
  });

  it("types a timeline attached row", async () => {
    const view = renderWithProviders(
      <div>
        {FILES.map(([filename], i) => (
          <AttachmentEventLink
            key={filename}
            slug="demo"
            issueNumber={7}
            attachmentId={i + 1}
            filename={filename}
          />
        ))}
      </div>,
      seeded(),
    );
    await waitFor(() =>
      expect(
        [...view.container.querySelectorAll("a")].map((a) =>
          identityOf(a.querySelector("svg")),
        ),
      ).toEqual(WANTED),
    );
  });
});
