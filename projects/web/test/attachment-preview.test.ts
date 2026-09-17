import { describe, expect, it } from "vitest";
import {
  isArchiveFile,
  isAudioFile,
  isHtmlDocument,
  isMarkdownDocument,
  isPreviewableImage,
  isTextDocument,
  isVideoFile,
  opensInBrowserTab,
  previewKind,
  TEXT_PREVIEW_MAX_BYTES,
} from "@/lib/attachment-preview.ts";
import { viewHrefFromDownload } from "@/lib/attachment-refs.ts";

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

describe("isHtmlDocument / html previews (T-58)", () => {
  it("matches by content type or extension", () => {
    expect(isHtmlDocument(attachment("demo.html", "text/html"))).toBe(true);
    expect(isHtmlDocument(attachment("page", "application/xhtml+xml"))).toBe(
      true,
    );
    expect(
      isHtmlDocument(attachment("demo.htm", "application/octet-stream")),
    ).toBe(true);
    // A real non-HTML type wins over the extension.
    expect(isHtmlDocument(attachment("fake.html", "application/zip"))).toBe(
      false,
    );
  });

  it("routes html to the reader, with no size cap", () => {
    expect(previewKind(attachment("demo.html", "text/html"))).toBe("html");
    expect(
      previewKind(
        attachment("big.html", "text/html", TEXT_PREVIEW_MAX_BYTES * 10),
      ),
    ).toBe("html");
    // Images still win the tie (an svg is both).
    expect(previewKind(attachment("logo.svg", "image/svg+xml"))).toBe("image");
  });

  it("maps download URLs onto the inline-view route", () => {
    expect(
      viewHrefFromDownload("/api/projects/p/attachments/7/download/a.html"),
    ).toBe("/api/projects/p/attachments/7/view/a.html");
    expect(viewHrefFromDownload("/api/projects/p/attachments/7/download")).toBe(
      "/api/projects/p/attachments/7/view",
    );
    // Only the path segment swaps, never a filename that contains the word.
    expect(
      viewHrefFromDownload(
        "/api/projects/p/attachments/7/download/download.html",
      ),
    ).toBe("/api/projects/p/attachments/7/view/download.html");
  });
});

describe("isArchiveFile / isAudioFile / isVideoFile (T-401)", () => {
  it("trusts a declared archive, audio or video type", () => {
    expect(isArchiveFile(attachment("bundle.zip", "application/zip"))).toBe(
      true,
    );
    expect(isArchiveFile(attachment("src.tgz", "application/gzip"))).toBe(true);
    expect(isArchiveFile(attachment("old.rar", "application/vnd.rar"))).toBe(
      true,
    );
    expect(isAudioFile(attachment("take.m4a", "audio/mp4"))).toBe(true);
    expect(isVideoFile(attachment("clip.mp4", "video/mp4"))).toBe(true);
  });

  it("falls back to the filename for generic types (CLI uploads)", () => {
    expect(
      isArchiveFile(attachment("bundle.zip", "application/octet-stream")),
    ).toBe(true);
    expect(isArchiveFile(attachment("dump.7z", ""))).toBe(true);
    expect(
      isAudioFile(attachment("take.flac", "application/octet-stream")),
    ).toBe(true);
    expect(
      isVideoFile(attachment("clip.mp4", "application/octet-stream")),
    ).toBe(true);
    expect(isVideoFile(attachment("CLIP.MOV", ""))).toBe(true);
  });

  it("does not let the extension override a declared type", () => {
    // Same file, mislabelled: every new predicate defers, and the declared
    // type is what decides — the gate the extension tables sit behind.
    const mislabelled = attachment("clip.mp4", "text/plain");
    expect(isVideoFile(mislabelled)).toBe(false);
    expect(isAudioFile(mislabelled)).toBe(false);
    expect(isArchiveFile(mislabelled)).toBe(false);
    expect(isTextDocument(mislabelled)).toBe(true);
    expect(isArchiveFile(attachment("fake.zip", "text/plain"))).toBe(false);
  });

  it("leaves the files the older tiers already claimed alone", () => {
    for (const file of [
      attachment("shot.png", "image/png"),
      attachment("demo.html", "text/html"),
      attachment("main.rs", "application/octet-stream"),
      attachment("notes.md", ""),
      // TypeScript source, not MPEG transport stream.
      attachment("index.ts", "application/octet-stream"),
    ]) {
      expect(isArchiveFile(file)).toBe(false);
      expect(isAudioFile(file)).toBe(false);
      expect(isVideoFile(file)).toBe(false);
    }
    expect(isPreviewableImage(attachment("shot.png", "image/png"))).toBe(true);
    expect(isHtmlDocument(attachment("demo.html", "text/html"))).toBe(true);
    expect(
      isTextDocument(attachment("index.ts", "application/octet-stream")),
    ).toBe(true);
  });
});

describe("opensInBrowserTab (T-201)", () => {
  it("accepts the types a tab renders inline", () => {
    for (const type of [
      "image/png",
      "image/svg+xml",
      "text/html",
      "text/plain",
      "text/markdown",
      "application/xhtml+xml",
      "application/json",
      "application/xml",
      "application/pdf",
    ]) {
      expect(opensInBrowserTab(attachment("f", type))).toBe(true);
    }
  });

  it("keeps generic and unmeasured types on /download", () => {
    expect(
      opensInBrowserTab(attachment("main.rs", "application/octet-stream")),
    ).toBe(false);
    expect(opensInBrowserTab(attachment("build.log", ""))).toBe(false);
    expect(opensInBrowserTab({})).toBe(false);
    expect(
      opensInBrowserTab(attachment("archive.zip", "application/zip")),
    ).toBe(false);
    // Text-shaped for the in-app preview, but never measured against /view.
    expect(opensInBrowserTab(attachment("c.yaml", "application/yaml"))).toBe(
      false,
    );
  });

  it("ignores the filename, unlike the preview predicates", () => {
    // /view answers nosniff, so an extension cannot talk the browser into
    // rendering an octet-stream — while previewKind still highlights it.
    const code = attachment("main.rs", "application/octet-stream", 512);
    expect(previewKind(code)).toBe("text");
    expect(opensInBrowserTab(code)).toBe(false);
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

  it("keeps oversized text download-only (T-31: no page-freezing renders)", () => {
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
