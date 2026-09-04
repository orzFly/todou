import type { Attachment } from "@todou/shared";
import { describe, expect, it } from "vitest";
import {
  attachmentAnchorHref,
  attachmentAnswersTo,
  attachmentHref,
  attachmentImageMarker,
  parseAttachmentHref,
} from "@/lib/attachment-refs.ts";

describe("parseAttachmentHref", () => {
  it("parses the bare download URL", () => {
    expect(
      parseAttachmentHref("/api/projects/demo/attachments/12/download"),
    ).toEqual({ slug: "demo", id: 12, name: null });
  });

  it("parses the named form and decodes the name", () => {
    expect(
      parseAttachmentHref(
        "/api/projects/demo/attachments/12/download/shot%20%281%29.png",
      ),
    ).toEqual({ slug: "demo", id: 12, name: "shot (1).png" });
  });

  it("parses the /view twin, so a URL copied out of the UI renders rich", () => {
    expect(
      parseAttachmentHref("/api/projects/demo/attachments/12/view"),
    ).toEqual({ slug: "demo", id: 12, name: null });
    expect(
      parseAttachmentHref(
        "/api/projects/demo/attachments/12/view/shot%20%281%29.png",
      ),
    ).toEqual({ slug: "demo", id: 12, name: "shot (1).png" });
  });

  it("rejects other URLs", () => {
    expect(parseAttachmentHref(undefined)).toBeNull();
    expect(parseAttachmentHref("https://example.com/x.png")).toBeNull();
    expect(parseAttachmentHref("/api/projects/demo/issues/12")).toBeNull();
    expect(
      parseAttachmentHref("/api/projects/demo/attachments/12/download/a/b"),
    ).toBeNull();
    expect(
      parseAttachmentHref("/api/projects/demo/attachments/12/download?x=1"),
    ).toBeNull();
  });
});

describe("attachmentHref", () => {
  it("round-trips through parse", () => {
    const href = attachmentHref("demo", 7, "shot (1).png");
    expect(href).toBe(
      "/api/projects/demo/attachments/7/download/shot%20%281%29.png",
    );
    expect(parseAttachmentHref(href)).toEqual({
      slug: "demo",
      id: 7,
      name: "shot (1).png",
    });
  });
});

describe("attachmentAnchorHref (T-201)", () => {
  const url = "/api/projects/demo/attachments/12/download/f";

  it("points viewable types at /view", () => {
    expect(attachmentAnchorHref({ url, content_type: "text/html" })).toBe(
      "/api/projects/demo/attachments/12/view/f",
    );
    expect(attachmentAnchorHref({ url, content_type: "application/pdf" })).toBe(
      "/api/projects/demo/attachments/12/view/f",
    );
  });

  it("leaves everything else on the download URL", () => {
    expect(
      attachmentAnchorHref({ url, content_type: "application/octet-stream" }),
    ).toBe(url);
    // An unresolved markdown reference knows no type yet; it upgrades once
    // the attachments query fills one in.
    expect(attachmentAnchorHref({ url })).toBe(url);
  });
});

describe("attachmentAnswersTo (T-242)", () => {
  const uploader = {
    id: 1,
    login: "bot",
    display_name: "bot",
    kind: "machine" as const,
    avatar_url: null,
    owner: null,
  };
  const make = (id: number, aliases: Attachment["aliases"]): Attachment => ({
    id,
    filename: "note.txt",
    content_type: "text/plain",
    size: 5,
    url: `/api/projects/b/attachments/${id}/download/note.txt`,
    uploader,
    created_at: "2026-09-01T00:00:00Z",
    aliases,
  });
  const ref = (href: string) => {
    const parsed = parseAttachmentHref(href);
    if (parsed === null) throw new Error(`unparseable: ${href}`);
    return parsed;
  };

  it("matches the attachment's own address", () => {
    const found = make(7, []);
    expect(
      attachmentAnswersTo(
        found,
        ref("/api/projects/b/attachments/7/download/note.txt"),
        "b",
      ),
    ).toBe(true);
  });

  it("matches an address the attachment kept from elsewhere", () => {
    const found = make(7, [{ project: "a", id: 88 }]);
    expect(
      attachmentAnswersTo(
        found,
        ref("/api/projects/a/attachments/88/download/note.txt"),
        "b",
      ),
    ).toBe(true);
  });

  it("does not let a foreign id collide with a live local one", () => {
    // The trap this rule exists for: `a/88` and a real `b/88` are different
    // files, and matching on the id alone would show the wrong one.
    const live = make(88, []);
    expect(
      attachmentAnswersTo(
        live,
        ref("/api/projects/a/attachments/88/download/note.txt"),
        "b",
      ),
    ).toBe(false);
  });

  it("matches the /view twin and the named forms alike", () => {
    const found = make(7, [{ project: "a", id: 88 }]);
    for (const href of [
      "/api/projects/a/attachments/88/view",
      "/api/projects/a/attachments/88/view/whatever.txt",
      "/api/projects/a/attachments/88/download",
      "/api/projects/b/attachments/7/view",
    ]) {
      expect(attachmentAnswersTo(found, ref(href), "b")).toBe(true);
    }
  });
});

describe("attachmentImageMarker", () => {
  it("escapes markdown-hostile characters in the alt text", () => {
    expect(
      attachmentImageMarker(
        "a[b].png",
        "/api/projects/d/attachments/1/download/a%5Bb%5D.png",
      ),
    ).toBe(
      "![a\\[b\\].png](/api/projects/d/attachments/1/download/a%5Bb%5D.png)",
    );
  });
});
