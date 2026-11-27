import { describe, expect, it } from "vitest";
import { FALLBACK, titleFor } from "../src/components/title-controller.tsx";
import { router } from "../src/router.tsx";

const ctx = {
  projectName: "Acme",
  issueNumber: 7,
  issueTitle: "Title",
  refPrefix: "T",
  refLeads: true,
  login: "bot-one",
};

/** Routes that can be the last match: they draw a page and nest none. */
const pageRouteIds = Object.values(router.routesById)
  .filter((route) => route.options.component && !route.children)
  .map((route) => route.id)
  // Its component is a <Navigate> to /projects, which titles the tab first.
  .filter((id) => id !== "/authed/");

describe("document title", () => {
  it("names the project and the page on Insights and search (T-803)", () => {
    expect(titleFor("/authed/projects/$slug/insights", ctx)).toBe(
      "Acme · insights",
    );
    expect(titleFor("/authed/projects/$slug/search", ctx)).toBe(
      "Acme · search",
    );
  });

  // A route registered without a case lands on the fallback with nothing to
  // say so; T-113 and T-803 were each found by someone reading a browser tab.
  it("leaves no page on the fallback but the known gaps", () => {
    const onFallback = pageRouteIds.filter(
      (id) => titleFor(id, ctx) === FALLBACK,
    );
    // T-808 gives these two their titles and empties this list.
    expect(onFallback.sort()).toEqual([
      "/authed/grant-access",
      "/authed/users/$ref",
    ]);
  });

  // A part interpolated as-is reads "undefined" while it loads, and one given
  // a stand-in reads as the stand-in; either way the tab shows a title that
  // the arriving data then replaces (T-820).
  it("titles no page before its parts arrive with anything but its final title", () => {
    const loading = {
      projectName: undefined,
      issueNumber: 7,
      issueTitle: undefined,
      refPrefix: undefined,
      refLeads: undefined,
      login: "bot-one",
    };
    const early = pageRouteIds
      .map((id) => [id, titleFor(id, loading), titleFor(id, ctx)] as const)
      .filter(([, before, after]) => before !== undefined && before !== after);
    expect(early).toEqual([]);
  });

  it("waits for each part a title shows, and only those", () => {
    const spec = "/authed/projects/$slug/issues/$number/spec";
    const issue = "/authed/projects/$slug/issues/$number";
    expect(titleFor(spec, { ...ctx, projectName: undefined })).toBeUndefined();
    expect(titleFor(spec, { ...ctx, refPrefix: undefined })).toBeUndefined();
    expect(
      titleFor(spec, { ...ctx, issueTitle: undefined, refLeads: undefined }),
    ).toBe("T-7 spec · Acme");
    expect(titleFor(issue, { ...ctx, issueTitle: undefined })).toBeUndefined();
    expect(titleFor(issue, { ...ctx, refLeads: undefined })).toBeUndefined();
    // An issue that failed to load is named by its ref, whatever the order.
    expect(
      titleFor(issue, { ...ctx, issueTitle: null, refLeads: undefined }),
    ).toBe("T-7 · Acme");
    expect(titleFor(issue, { ...ctx, refLeads: false })).toBe(
      "Title T-7 · Acme",
    );
  });
});
