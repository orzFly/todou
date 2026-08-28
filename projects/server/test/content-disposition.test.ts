import { describe, expect, it } from "vitest";
import { contentDisposition } from "../src/http/content-disposition.ts";

/** The property that stops T-147 from coming back, whatever the name holds. */
function expectHeaderSafe(value: string) {
  for (const char of value) {
    expect(char.codePointAt(0)).toBeLessThanOrEqual(0x7e);
  }
  expect(() => new Headers({ "content-disposition": value })).not.toThrow();
}

describe("contentDisposition", () => {
  it("leaves an ASCII name as a single quoted parameter", () => {
    expect(contentDisposition("attachment", "notes.txt")).toBe(
      'attachment; filename="notes.txt"',
    );
  });

  it("carries a Chinese name in the extended parameter (T-147)", () => {
    const value = contentDisposition("attachment", "e2e-验收留证.txt");
    expect(value).toBe(
      'attachment; filename="e2e-____.txt"; ' +
        "filename*=UTF-8''e2e-%E9%AA%8C%E6%94%B6%E7%95%99%E8%AF%81.txt",
    );
    expectHeaderSafe(value);
  });

  it("handles Japanese and Korean names the same way", () => {
    const jp = contentDisposition("attachment", "検証レポート.pdf");
    expect(jp).toContain('filename="______.pdf"');
    expect(jp).toContain(
      "filename*=UTF-8''%E6%A4%9C%E8%A8%BC%E3%83%AC%E3%83%9D%E3%83%BC%E3%83%88.pdf",
    );
    expectHeaderSafe(jp);

    const kr = contentDisposition("attachment", "검수 증빙.txt");
    // The space is legal inside the quoted string and stays put.
    expect(kr).toContain('filename="__ __.txt"');
    expect(kr).toContain(
      "filename*=UTF-8''%EA%B2%80%EC%88%98%20%EC%A6%9D%EB%B9%99.txt",
    );
    expectHeaderSafe(kr);
  });

  it("neutralizes quotes and backslashes that would end the string early", () => {
    const value = contentDisposition("attachment", 'we"ird\\name.txt');
    expect(value).toBe(
      'attachment; filename="we_ird_name.txt"; ' +
        "filename*=UTF-8''we%22ird%5Cname.txt",
    );
    expectHeaderSafe(value);
  });

  it("keeps a semicolon inside the quoted string, not as a parameter break", () => {
    const value = contentDisposition("attachment", "report; final.txt");
    expect(value).toBe('attachment; filename="report; final.txt"');
    // Nothing was lost, so no second parameter is warranted.
    expect(value).not.toContain("filename*");
    expectHeaderSafe(value);
  });

  it("collapses an astral-plane character to one placeholder", () => {
    const value = contentDisposition("attachment", "🌱-seed.txt");
    expect(value).toContain('filename="_-seed.txt"');
    expect(value).toContain("filename*=UTF-8''%F0%9F%8C%B1-seed.txt");
    expectHeaderSafe(value);
  });

  it("emits the inline type for the view route", () => {
    expect(contentDisposition("inline", "demo.html")).toBe(
      'inline; filename="demo.html"',
    );
    expect(contentDisposition("inline", "演示.html")).toBe(
      "inline; filename=\"__.html\"; filename*=UTF-8''%E6%BC%94%E7%A4%BA.html",
    );
  });

  it("percent-encodes every byte outside RFC 5987 attr-char", () => {
    // Latin-1 code points never threw, but a raw ö in a header is read back
    // as Latin-1 mojibake — so they take the extended parameter as well.
    const value = contentDisposition("attachment", "größe.txt");
    expect(value).toBe(
      "attachment; filename=\"gr__e.txt\"; filename*=UTF-8''gr%C3%B6%C3%9Fe.txt",
    );
    expectHeaderSafe(value);
  });
});
