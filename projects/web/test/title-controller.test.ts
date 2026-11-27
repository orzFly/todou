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
});
