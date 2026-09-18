import { fireEvent, screen, waitFor } from "@testing-library/react";
import {
  type Me,
  type SpecFiles,
  type SpecInfo,
  TodouClient,
} from "@todou/shared";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../src/api/queries.ts";
import { hasUnsavedWork } from "../src/lib/unsaved-guard.ts";
import { router } from "../src/router.tsx";
import {
  renderOnTheAppRouter,
  restoreAppRouterPage,
  teardownAppRouter,
} from "./app-router.tsx";
import { cmGetValue, cmSetValue } from "./cm.ts";
import { testQueryClient } from "./render.tsx";

const ME: Me = {
  id: 9,
  login: "user",
  display_name: "User",
  kind: "human",
  avatar_url: null,
  owner: null,
  email: null,
  is_instance_admin: false,
  created_at: "2026-01-01T00:00:00Z",
};

const PROJECT = {
  id: 1,
  slug: "demo",
  name: "Demo",
  description: "",
  created_at: "2026-01-01T00:00:00Z",
  viewer_role: "writer" as const,
  former_slugs: [],
};

const AUTHOR = {
  id: 2,
  login: "bot-one",
  display_name: "Bot One",
  kind: "machine" as const,
  avatar_url: null,
  owner: null,
};

const SPEC: SpecInfo = {
  current_version: 3,
  current_version_cursor: "c3",
  review_status: "unreviewed",
  unresolved_comments: 0,
  unresolved_carried_comments: 0,
  files: [
    { path: "a.md", size: 30 },
    { path: "b.md", size: 30 },
  ],
  versions: [1, 2, 3].map((number) => ({
    number,
    author: AUTHOR,
    message: `v${number}`,
    created_at: "2026-01-01T00:00:00Z",
  })),
};

const filesFor = (version: number): SpecFiles => ({
  version,
  files: [
    {
      path: "a.md",
      body: `# Version ${version}\n\nfirst line v${version}\nsecond line\n`,
      size: 50,
    },
    { path: "b.md", body: `# Other file v${version}\n`, size: 20 },
  ],
});

type FailureMode = "none" | "forbidden" | "network" | "body-reset";

function appFixture() {
  const calls: string[] = [];
  const batchCalls: string[][] = [];
  let failure: FailureMode = "none";
  let failureVersion: number | null = null;

  const answer = async (
    raw: string,
  ): Promise<{ status: number; body: unknown }> => {
    const url = new URL(raw, "http://localhost");
    const path = url.pathname.replace(/^\/api/, "");
    calls.push(`${path}${url.search}`);

    if (path === "/me") return { status: 200, body: ME };
    if (path === "/version") return { status: 200, body: { version: "test" } };
    if (path === "/auth/mode") return { status: 200, body: { mode: "local" } };
    if (path === "/projects") return { status: 200, body: [PROJECT] };
    if (path === "/me/preferences" || path === "/me/prefs") {
      return { status: 200, body: {} };
    }
    if (path === "/me/inbox") {
      return {
        status: 200,
        body: { items: [], unread_count: 0, next_cursor: null },
      };
    }
    if (path === "/me/reference-directory") {
      return { status: 200, body: { entries: [], projects: [], users: [] } };
    }
    if (path === "/me/unread-count" || path === "/inbox/count") {
      return { status: 200, body: { count: 0 } };
    }
    if (/^\/projects\/[^/]+$/.test(path)) {
      return { status: 200, body: { ...PROJECT, slug: path.split("/")[2] } };
    }
    if (
      path.endsWith("/reference-config") ||
      path.endsWith("/references/config")
    ) {
      return {
        status: 200,
        body: { format: { prefix: "T-", history: [] }, autolinks: [] },
      };
    }
    if (/\/(members|labels|statuses)$/.test(path)) {
      return { status: 200, body: [] };
    }
    if (path.endsWith("/spec")) return { status: 200, body: SPEC };
    if (path.endsWith("/spec/comments")) {
      return { status: 200, body: { current_version: 3, items: [] } };
    }
    if (path.endsWith("/spec/files")) {
      const version = Number(url.searchParams.get("version") ?? 3);
      if (version === failureVersion && failure === "network") {
        throw new TypeError("audit network failure");
      }
      if (version === failureVersion && failure === "forbidden") {
        return {
          status: 403,
          body: {
            error: { code: "forbidden", message: "audit blocked version" },
          },
        };
      }
      return { status: 200, body: filesFor(version) };
    }
    return {
      status: 404,
      body: {
        error: { code: "not_found", message: `fixture missing ${path}` },
      },
    };
  };

  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw =
      typeof input === "string" || input instanceof URL
        ? String(input)
        : input.url;
    const url = new URL(raw, "http://localhost");
    if (url.pathname !== "/api/batch") {
      const result = await answer(raw);
      if (
        url.pathname.endsWith("/spec/files") &&
        failure === "body-reset" &&
        Number(url.searchParams.get("version")) === failureVersion
      ) {
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('{"version":'));
              controller.error(new TypeError("body stream reset"));
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(JSON.stringify(result.body), {
        status: result.status,
        headers: { "content-type": "application/json" },
      });
    }

    const request = JSON.parse(String(init?.body)) as {
      requests: Array<{ url: string }>;
    };
    batchCalls.push(request.requests.map((item) => item.url));
    const responses = await Promise.all(
      request.requests.map((item) => answer(item.url)),
    );
    return new Response(JSON.stringify({ responses }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });

  return {
    calls,
    batchCalls,
    fetch,
    failWith(mode: Exclude<FailureMode, "none">, version: number) {
      failure = mode;
      failureVersion = version;
    },
    recover() {
      failure = "none";
      failureVersion = null;
    },
  };
}

function beforeUnloadPrevented(): boolean {
  const event = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(event);
  return event.defaultPrevented;
}

async function navigateVersionInBatch(client: TodouClient, version: number) {
  const companion = client.getSpecComments("demo", 7).catch(() => undefined);
  void router.navigate({
    to: "/projects/$slug/issues/$number/spec",
    params: { slug: "demo", number: "7" },
    search: { v: version, file: "a.md" },
  });
  await companion;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
  expect(hasUnsavedWork()).toBe(false);
});

afterAll(teardownAppRouter);

describe("spec drafts on the application browser-history router", () => {
  it("keeps both drafts through HTTP, pre-header, and body-stream failures", async () => {
    const fixture = appFixture();
    vi.stubGlobal("fetch", fixture.fetch);
    const batchedApi = new TodouClient({ batch: true });
    vi.spyOn(api, "request").mockImplementation(
      batchedApi.request.bind(batchedApi),
    );
    await router.navigate({
      to: "/projects/$slug/issues/$number/spec",
      params: { slug: "demo", number: "7" },
      search: { v: 1, file: "a.md" },
      replace: true,
      ignoreBlocker: true,
    });
    const mounted = renderOnTheAppRouter(testQueryClient());

    try {
      fireEvent.click(
        await screen.findByRole("button", { name: "Comment file" }),
      );
      await screen.findByLabelText("Spec comment");
      cmSetValue(mounted.container, "P1 unsaved composer\nline two");

      fireEvent.click(screen.getByRole("button", { name: /finish review/i }));
      await screen.findByLabelText("Review summary");
      cmSetValue(document.body, "P1 hidden summary\nline two", 1);
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
      await waitFor(() =>
        expect(screen.queryByLabelText("Review summary")).toBeNull(),
      );

      expect(hasUnsavedWork()).toBe(true);
      expect(beforeUnloadPrevented()).toBe(true);
      expect(
        fixture.calls.filter((call) => call.includes("/spec/files")),
      ).toEqual(["/projects/demo/issues/7/spec/files?version=1"]);
      expect(fixture.batchCalls.length).toBeGreaterThan(0);

      fixture.failWith("forbidden", 2);
      await navigateVersionInBatch(batchedApi, 2);
      expect(fixture.batchCalls.flat()).toContain(
        "/projects/demo/issues/7/spec/files?version=2",
      );

      expect(await screen.findByText("Couldn't load this spec.")).toBeTruthy();
      expect(router.state.location.search).toMatchObject({ v: 2 });
      expect(screen.queryByText("Leave with unsaved changes?")).toBeNull();
      expect(hasUnsavedWork()).toBe(true);
      expect(beforeUnloadPrevented()).toBe(true);
      expect(screen.getByRole("banner")).toBeTruthy();

      fixture.recover();
      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
      await screen.findByText("Version 2");

      expect(cmGetValue(mounted.container)).toBe(
        "P1 unsaved composer\nline two",
      );
      expect(mounted.container.querySelector("main")?.textContent).toContain(
        "a.mdfile comment · v1",
      );
      fireEvent.click(screen.getByRole("button", { name: /finish review/i }));
      await screen.findByLabelText("Review summary");
      expect(cmGetValue(document.body, 1)).toBe("P1 hidden summary\nline two");
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
      await waitFor(() =>
        expect(screen.queryByLabelText("Review summary")).toBeNull(),
      );

      fixture.failWith("network", 3);
      await navigateVersionInBatch(batchedApi, 3);
      expect(fixture.batchCalls.flat()).toContain(
        "/projects/demo/issues/7/spec/files?version=3",
      );
      expect(await screen.findByText("Couldn't load this spec.")).toBeTruthy();
      expect(router.state.location.search).toMatchObject({ v: 3 });
      expect(hasUnsavedWork()).toBe(true);
      expect(beforeUnloadPrevented()).toBe(true);

      fixture.recover();
      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
      await screen.findByText("Version 3");
      expect(cmGetValue(mounted.container)).toBe(
        "P1 unsaved composer\nline two",
      );
      expect(mounted.container.querySelector("main")?.textContent).toContain(
        "a.mdfile comment · v1",
      );
      fireEvent.click(screen.getByRole("button", { name: /finish review/i }));
      await screen.findByLabelText("Review summary");
      expect(cmGetValue(document.body, 1)).toBe("P1 hidden summary\nline two");
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
      await waitFor(() =>
        expect(screen.queryByLabelText("Review summary")).toBeNull(),
      );

      fixture.failWith("body-reset", 4);
      void router.navigate({
        to: "/projects/$slug/issues/$number/spec",
        params: { slug: "demo", number: "7" },
        search: { v: 4, file: "a.md" },
      });
      expect(await screen.findByText("Couldn't load this spec.")).toBeTruthy();
      expect(router.state.location.search).toMatchObject({ v: 4 });
      expect(fixture.batchCalls.flat()).not.toContain(
        "/projects/demo/issues/7/spec/files?version=4",
      );
      expect(hasUnsavedWork()).toBe(true);
      expect(beforeUnloadPrevented()).toBe(true);
      expect(screen.getByRole("banner")).toBeTruthy();

      fixture.recover();
      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
      await screen.findByText("Version 4");
      expect(cmGetValue(mounted.container)).toBe(
        "P1 unsaved composer\nline two",
      );
      expect(mounted.container.querySelector("main")?.textContent).toContain(
        "a.mdfile comment · v1",
      );
      fireEvent.click(screen.getByRole("button", { name: /finish review/i }));
      await screen.findByLabelText("Review summary");
      expect(cmGetValue(document.body, 1)).toBe("P1 hidden summary\nline two");
    } finally {
      mounted.unmount();
      restoreAppRouterPage();
    }
  }, 20_000);
});
