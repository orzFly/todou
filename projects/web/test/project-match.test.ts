import { describe, expect, it } from "vitest";
import { matchProject } from "../src/lib/project-match.ts";

const homelab = { name: "Homelab", slug: "homelab", prefix: "CH" };
const accel = { name: "Accel", slug: "accel", prefix: null };

describe("matching a project for a filtered list", () => {
  it("hits the name, and says where", () => {
    expect(matchProject(homelab, "omel")).toEqual({
      field: "name",
      range: { start: 1, end: 5 },
    });
  });

  it("hits the slug when the name does not carry the query", () => {
    // `lab` is in both here, so give the slug something of its own.
    expect(matchProject({ ...homelab, name: "Casa" }, "mel")).toEqual({
      field: "slug",
      range: { start: 2, end: 5 },
    });
  });

  it("hits the prefix, which is why this card exists", () => {
    expect(matchProject(homelab, "CH")).toEqual({
      field: "prefix",
      range: { start: 0, end: 2 },
    });
  });

  it("does not care which case the query was typed in", () => {
    expect(matchProject(homelab, "ch")).toEqual(matchProject(homelab, "CH"));
    expect(matchProject(homelab, "Ch")).toEqual(matchProject(homelab, "CH"));
  });

  it("eats a trailing hyphen off a prefix picked out of a card number", () => {
    expect(matchProject(homelab, "ch-")).toEqual({
      field: "prefix",
      range: { start: 0, end: 2 },
    });
  });

  it("is null for a project the query does not reach", () => {
    expect(matchProject(homelab, "zzz")).toBe(null);
  });

  it("never hits the prefix of a project that has none", () => {
    // `accel` has no prefix at all; nothing may stand in for one.
    expect(matchProject(accel, "zzz")).toBe(null);
    expect(matchProject({ ...accel, name: "X", slug: "y" }, "acc")).toBe(null);
  });

  it("is null for a query that is nothing but hyphens", () => {
    expect(matchProject({ ...homelab, name: "X", slug: "y" }, "-")).toBe(null);
  });

  it("gives one reason, the first, when the query is in two fields", () => {
    // `homelab` is both the name and the slug here; the row gets one segment.
    expect(matchProject({ ...homelab, name: "homelab" }, "home")).toEqual({
      field: "name",
      range: { start: 0, end: 4 },
    });
  });

  it("keeps the hit but drops the range where folding changes length", () => {
    // "İ".toLowerCase() is two characters, so an offset measured on the
    // folded string lands one glyph late in the original. The row still
    // belongs in the list; it just gets no <mark>.
    const match = matchProject(
      { name: "İstanbul", slug: "ist", prefix: null },
      "stan",
    );
    expect(match).toEqual({ field: "name", range: null });
  });
});
