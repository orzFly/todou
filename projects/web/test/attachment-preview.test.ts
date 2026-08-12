import { describe, expect, it } from "vitest";
import {
  isMarkdownDocument,
  isPreviewableImage,
  isTextDocument,
  previewKind,
  TEXT_PREVIEW_MAX_BYTES,
} from "@/lib/attachment-preview.ts";

const attachment = (filename: string, content_type: string, size = 1) => ({
  id: 1,
  filename,
  content_type,
  size,
  url: `/attachments/${filename}`,
  uploader: {
    id: 1,
    login: "claude-agent",
    display_name: "claude-agent",
    kind: "machine" as const,
    avatar_url: null,
    owner: null,
  },
  created_at: "2026-08-12T00:00:00Z",
});

describe("isPreviewableImage", () => {
  it("trusts an image/* content type", () => {
    expect(isPreviewableImage(attachment("shot.png", "image/png"))).toBe(true);
    expect(isPreviewableImage(attachment("weird.bin", "image/webp"))).toBe(
      true,
    );
  });

  it("falls back to the filename for typeless uploads", () => {
    expect(
      isPreviewableImage(attachment("shot.png", "application/octet-stream")),
    ).toBe(true);
    expect(isPreviewableImage(attachment("shot.JPG", ""))).toBe(true);
  });

  it("never previews non-images", () => {
    expect(isPreviewableImage(attachment("notes.txt", "text/plain"))).toBe(
      false,
    );
    expect(
      isPreviewableImage(attachment("archive.zip", "application/octet-stream")),
    ).toBe(false);
    // a real (non-generic) content type wins over the extension
    expect(isPreviewableImage(attachment("fake.png", "text/plain"))).toBe(
      false,
    );
  });
});

describe("isTextDocument", () => {
  it("trusts text/* and text-shaped application types", () => {
    expect(isTextDocument(attachment("notes.txt", "text/plain"))).toBe(true);
    expect(isTextDocument(attachment("report.md", "text/markdown"))).toBe(true);
    expect(isTextDocument(attachment("data.json", "application/json"))).toBe(
      true,
    );
  });

  it("falls back to the filename for generic types (CLI code uploads)", () => {
    expect(
      isTextDocument(attachment("main.rs", "application/octet-stream")),
    ).toBe(true);
    expect(isTextDocument(attachment("build.log", ""))).toBe(true);
    expect(
      isTextDocument(attachment("archive.zip", "application/octet-stream")),
    ).toBe(false);
  });

  it("does not let the extension override a real binary type", () => {
    expect(isTextDocument(attachment("fake.txt", "application/zip"))).toBe(
      false,
    );
  });
});

describe("isMarkdownDocument", () => {
  it("matches by content type or extension", () => {
    expect(isMarkdownDocument(attachment("report.md", ""))).toBe(true);
    expect(
      isMarkdownDocument(attachment("REPORT.MARKDOWN", "text/plain")),
    ).toBe(true);
    expect(isMarkdownDocument(attachment("notes", "text/markdown"))).toBe(true);
    expect(isMarkdownDocument(attachment("notes.txt", "text/plain"))).toBe(
      false,
    );
  });
});

describe("previewKind", () => {
  it("classifies images and small text files", () => {
    expect(previewKind(attachment("shot.png", "image/png"))).toBe("image");
    expect(previewKind(attachment("notes.txt", "text/plain", 512))).toBe(
      "text",
    );
    expect(
      previewKind(attachment("archive.zip", "application/octet-stream")),
    ).toBe(null);
  });

  it("keeps oversized text download-only (#31: no page-freezing renders)", () => {
    expect(
      previewKind(
        attachment("huge.log", "text/plain", TEXT_PREVIEW_MAX_BYTES + 1),
      ),
    ).toBe(null);
    expect(
      previewKind(attachment("edge.log", "text/plain", TEXT_PREVIEW_MAX_BYTES)),
    ).toBe("text");
  });

  it("needs a known size before offering a text preview", () => {
    expect(
      previewKind({ filename: "notes.txt", content_type: "text/plain" }),
    ).toBe(null);
  });

  it("prefers the image lightbox for files that are both (svg)", () => {
    expect(previewKind(attachment("logo.svg", "image/svg+xml"))).toBe("image");
  });
});
