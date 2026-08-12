import { describe, expect, it } from "vitest";
import { isPreviewableImage } from "@/components/issue/attachment-list.tsx";

const attachment = (filename: string, content_type: string) => ({
  id: 1,
  filename,
  content_type,
  size: 1,
  url: `/attachments/${filename}`,
  uploader: {
    id: 1,
    login: "claude-agent",
    display_name: "claude-agent",
    kind: "machine" as const,
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
