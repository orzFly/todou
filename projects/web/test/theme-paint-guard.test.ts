import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { themePaintGuard } from "../vite.config.ts";

const INDEX = readFileSync(resolve(process.cwd(), "index.html"), "utf8");

function transform(html: string): string {
  const hook = themePaintGuard().transformIndexHtml as (html: string) => string;
  return hook(html);
}

const inlineScripts = (html: string) =>
  [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(
    (m) => ({ body: m[1] as string, at: m.index as number }),
  );

describe("theme paint guard", () => {
  it("puts one guard into index.html, after <meta charset>", () => {
    const html = transform(INDEX);
    const guards = inlineScripts(html).filter((s) =>
      s.body.includes('"todou-theme-paint"'),
    );
    expect(guards).toHaveLength(1);
    const charset = html.search(/<meta charset=/i);
    expect(charset).toBeGreaterThanOrEqual(0);
    expect(guards[0]?.at).toBeGreaterThan(charset);
    expect(html).not.toContain("<!-- theme-paint-guard -->");
  });

  it("refuses a page with no placeholder rather than dropping the guard", () => {
    const bare = INDEX.replace("<!-- theme-paint-guard -->", "");
    expect(() => transform(bare)).toThrow(/theme-paint-guard/);
  });
});
