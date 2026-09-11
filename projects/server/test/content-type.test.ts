import { describe, expect, it } from "vitest";
import { servedContentType } from "../src/http/content-type.ts";

type Row = [stored: string, download: string, view: string];

const OCTET = "application/octet-stream";
const PLAIN = "text/plain; charset=utf-8";

/** The table decides both columns; the invariant below holds over all of it. */
const ROWS: Row[] = [
  // The card's headline requirement: a `script` or `style` destination
  // ignores content-disposition, so these must never come back as js/css.
  ["text/javascript", PLAIN, PLAIN],
  ["application/javascript", PLAIN, PLAIN],
  ["text/css", PLAIN, PLAIN],

  // Rendered only under /view's CSP sandbox; a download is never a document.
  ["text/html", PLAIN, "text/html"],
  ["application/xhtml+xml", PLAIN, "application/xhtml+xml"],
  ["application/json", PLAIN, "application/json"],
  ["application/xml", PLAIN, "application/xml"],
  // Named above "every other text/*", which is what decides this row.
  ["text/xml", PLAIN, "text/xml"],

  // Served as its own source on both routes.
  ["text/markdown", PLAIN, PLAIN],
  ["text/x-python", PLAIN, PLAIN],
  ["application/yaml", PLAIN, PLAIN],
  ["application/x-yaml", PLAIN, PLAIN],
  ["application/toml", PLAIN, PLAIN],
  ["application/ld+json", PLAIN, PLAIN],
  ["application/sql", PLAIN, PLAIN],
  ["application/x-sh", PLAIN, PLAIN],

  // Untouched: an image, a video or a PDF renders from the bytes, and nosniff
  // gates only script and style destinations.
  ["image/png", "image/png", "image/png"],
  ["image/svg+xml", "image/svg+xml", "image/svg+xml"],
  ["image/webp", "image/webp", "image/webp"],
  ["image/gif", "image/gif", "image/gif"],
  ["video/mp4", "video/mp4", "video/mp4"],
  ["audio/mpeg", "audio/mpeg", "audio/mpeg"],
  ["application/pdf", "application/pdf", "application/pdf"],

  // The pre-T-27 CLI rows stored every image this way, and they still render
  // off the bytes.
  ["application/octet-stream", OCTET, OCTET],
  ["application/zip", OCTET, OCTET],
  ["application/x-tar", OCTET, OCTET],
  ["application/vnd.ms-excel", OCTET, OCTET],
];

describe("servedContentType", () => {
  it.each(ROWS)("%s serves as %s / %s", (stored, download, view) => {
    expect(servedContentType(stored, "download")).toBe(download);
    expect(servedContentType(stored, "view")).toBe(view);
  });

  it("normalises case and surrounding whitespace", () => {
    expect(servedContentType("  IMAGE/PNG  ", "view")).toBe("image/png");
    expect(servedContentType("Text/HTML", "download")).toBe(
      "text/plain; charset=utf-8",
    );
  });

  describe("charset", () => {
    it("keeps a declared charset, lowercased", () => {
      expect(servedContentType("text/plain;charset=gbk", "download")).toBe(
        "text/plain; charset=gbk",
      );
      expect(servedContentType("TEXT/PLAIN; Charset=UTF-8", "view")).toBe(
        "text/plain; charset=utf-8",
      );
    });

    it("keeps a charset beside a type that is otherwise untouched", () => {
      expect(servedContentType("image/png; charset=utf-8", "download")).toBe(
        "image/png; charset=utf-8",
      );
    });

    it("drops a charset that does not look like one", () => {
      expect(servedContentType('text/plain; charset="../x"', "download")).toBe(
        PLAIN,
      );
      expect(servedContentType("text/plain; charset=", "download")).toBe(PLAIN);
      expect(
        servedContentType("text/plain; charset=../x\r\nX-Evil: 1", "download"),
      ).toBe(PLAIN);
    });

    it("drops every other parameter", () => {
      expect(
        servedContentType(
          "text/plain; boundary=x; charset=latin-1",
          "download",
        ),
      ).toBe("text/plain; charset=latin-1");
      expect(servedContentType("text/plain; boundary=x", "download")).toBe(
        PLAIN,
      );
    });

    it("appends utf-8 only where nothing usable came in", () => {
      expect(servedContentType("text/markdown", "download")).toBe(PLAIN);
      // Nothing is appended to a type that carries no text to decode.
      expect(servedContentType("application/pdf", "download")).toBe(
        "application/pdf",
      );
      expect(servedContentType("application/octet-stream", "download")).toBe(
        OCTET,
      );
    });

    it("keeps a charset even where the base type was downgraded to binary", () => {
      // The design carries a matched charset through and maps only the base
      // type, so a binary downgrade does not silently drop the parameter.
      expect(
        servedContentType("application/zip; charset=utf-8", "download"),
      ).toBe("application/octet-stream; charset=utf-8");
    });
  });

  describe("hostile input", () => {
    // Each of these used to reach Headers.set verbatim, where a CRLF throws
    // and a code point above U+00FF throws, 500ing the attachment for ever.
    const HOSTILE: string[] = [
      "text/plain\r\nX-Evil: 1",
      "text/plain中",
      "x".repeat(20000),
      "",
      "   ",
      "text",
      "/plain",
      "text/",
      "text plain",
      "text/pl ain",
      "text/plain/x",
      "*/*",
      "中",
    ];

    it.each(HOSTILE)("%j falls back to octet-stream", (stored) => {
      expect(servedContentType(stored, "download")).toBe(OCTET);
      expect(servedContentType(stored, "view")).toBe(OCTET);
    });
  });

  // The invariant, not a special case: whatever the route answers with has to
  // be a legal header value, so no stored row can make the response throw.
  it("produces a legal header value for every row and variant", () => {
    const stored = [
      ...ROWS.map((row) => row[0]),
      "text/plain\r\nX-Evil: 1",
      "text/plain中",
      "x".repeat(20000),
      "",
      "text",
      "text/plain; charset=中",
    ];
    for (const value of stored) {
      for (const variant of ["download", "view"] as const) {
        const result = servedContentType(value, variant);
        expect(() => new Headers().set("content-type", result)).not.toThrow();
      }
    }
  });
});
