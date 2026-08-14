import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { VersionFooter } from "../src/components/footer.tsx";
import { router } from "../src/router.tsx";

vi.mock("../src/lib/version.ts", () => ({
  WEB_VERSION: "v0.2.0",
  REPO_URL: "https://github.com/orzFly/todou",
}));

const wrap = (children: ReactNode) => (
  <QueryClientProvider
    client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
  >
    {children}
  </QueryClientProvider>
);

const versionServer = (version: string) =>
  (async () =>
    new Response(JSON.stringify({ version }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;

describe("VersionFooter", () => {
  it("shows one version when web and server agree", async () => {
    vi.stubGlobal("fetch", versionServer("v0.2.0"));
    render(wrap(<VersionFooter />));
    const link = await screen.findByText("todou v0.2.0");
    expect(link.getAttribute("href")).toBe("https://github.com/orzFly/todou");
    expect(link.className).toContain("text-muted-foreground");
    expect(link.getAttribute("title")).toBeNull();
    vi.unstubAllGlobals();
  });

  it("shows both versions in amber when they differ", async () => {
    vi.stubGlobal("fetch", versionServer("v0.2.1"));
    render(wrap(<VersionFooter />));
    const link = await screen.findByText("todou web v0.2.0 · server v0.2.1");
    expect(link.className).toContain("text-amber-700");
    expect(link.getAttribute("title")).toBeTruthy();
    vi.unstubAllGlobals();
  });

  it("degrades to the web version alone when the endpoint is missing", async () => {
    // No stub: the suite's offline fetch 404s /api/version like an old server.
    render(wrap(<VersionFooter />));
    const link = await screen.findByText("todou v0.2.0");
    expect(link.className).toContain("text-muted-foreground");
  });
});

describe("board route", () => {
  it("declares fillsViewport so the shell suppresses the footer", () => {
    const board = router.routesById["/authed/projects/$slug/board"];
    expect(board.options.staticData?.fillsViewport).toBe(true);
  });
});
