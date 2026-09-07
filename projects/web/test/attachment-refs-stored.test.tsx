import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { render, waitFor } from "@testing-library/react";
import type {
  Attachment,
  Project,
  ReferenceConfig,
  ReferenceDirectory,
} from "@todou/shared";
import type { ReactElement } from "react";
import { describe, expect, it } from "vitest";
import {
  attachmentsQuery,
  attachmentTextQuery,
} from "../src/api/attachments.ts";
import { projectsQuery } from "../src/api/queries.ts";
import {
  referenceConfigQuery,
  referenceDirectoryQuery,
} from "../src/api/references.ts";
import { MarkdownView } from "../src/components/shared/markdown-view.tsx";

const config: ReferenceConfig = {
  format: { prefix: null, history: [] },
  autolinks: [],
};

const DIRECTORY: ReferenceDirectory = { entries: [], contested: [] };

const uploader = {
  id: 1,
  login: "user",
  display_name: "User",
  kind: "human" as const,
  avatar_url: null,
  owner: null,
};

const file = (
  id: number,
  filename: string,
  content_type: string,
  aliases: Attachment["aliases"] = [],
): Attachment => ({
  id,
  filename,
  content_type,
  size: 26,
  url: `/api/projects/a/attachments/${id}/download/${filename}`,
  uploader,
  created_at: "2026-01-01T00:00:00.000Z",
  aliases,
});

const TEXT = "hello from a.txt\n";

/** Projects 1 and 2 are readable; 9 is not in the viewer's directory. */
function seed(queries: QueryClient, attachments?: Attachment[]): QueryClient {
  queries.setQueryData(referenceDirectoryQuery.queryKey, DIRECTORY);
  queries.setQueryData(
    projectsQuery.queryKey,
    ["a", "b"].map(
      (slug, index): Project => ({
        id: index + 1,
        slug,
        name: slug,
        description: "",
        created_at: "2026-01-01T00:00:00.000Z",
      }),
    ),
  );
  queries.setQueryData(referenceConfigQuery("a").queryKey, config);
  queries.setQueryData(referenceConfigQuery("b").queryKey, config);
  const files = attachments ?? [
    file(1, "a.txt", "text/plain"),
    file(2, "b.png", "image/png"),
  ];
  queries.setQueryData(attachmentsQuery("a", 7).queryKey, files);
  for (const one of files) {
    queries.setQueryData(attachmentTextQuery(one.url).queryKey, TEXT);
  }
  return queries;
}

function renderWithProviders(ui: ReactElement, client: QueryClient) {
  const rootRoute = createRootRoute();
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => ui,
  });
  const projectRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/projects/$slug",
  });
  const issueRoute = createRoute({
    getParentRoute: () => projectRoute,
    path: "issues/$number",
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      indexRoute,
      projectRoute.addChildren([issueRoute]),
    ]),
  });
  return render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

const client = () =>
  new QueryClient({ defaultOptions: { queries: { retry: false } } });

const body = (markdown: string, queries: QueryClient) =>
  renderWithProviders(
    <MarkdownView slug="a" issueNumber={7}>
      {markdown}
    </MarkdownView>,
    queries,
  );

const richLink = async (
  view: ReturnType<typeof render>,
): Promise<HTMLAnchorElement> =>
  waitFor(() => {
    const el = view.container.querySelector("a.inline-flex");
    expect(el).not.toBeNull();
    return el as HTMLAnchorElement;
  });

/**
 * How a stored attachment reference renders (T-290). Everything the resolve
 * pass writes names the project by id (T-266), so reading only the slug
 * spelling left every reference in this deployment — historical bodies
 * included — as a plain link, and every document embed as a broken image.
 *
 * An enhanced anchor points at the attachment's current canonical address,
 * not at the address the reference was written with: the same trade an
 * id-anchored issue link makes, one redirect saved per click.
 */
describe("stored id-anchored attachment references", () => {
  it("enhances an id-anchored link", async () => {
    const view = body(
      "see [a.txt](/api/projects/1/attachments/1/download/a.txt)",
      seed(client()),
    );

    const link = await richLink(view);
    expect(link.getAttribute("href")).toBe(
      "/api/projects/a/attachments/1/view/a.txt",
    );
    expect(link.querySelector("svg")).not.toBeNull();
  });

  it("enhances the id-anchored /view twin", async () => {
    const view = body(
      "see [a.txt](/api/projects/1/attachments/1/view/a.txt)",
      seed(client()),
    );

    const link = await richLink(view);
    expect(link.getAttribute("href")).toBe(
      "/api/projects/a/attachments/1/view/a.txt",
    );
    expect(link.querySelector("svg")).not.toBeNull();
  });

  it("enhances an id-anchored inline image", async () => {
    const view = body(
      "![b.png](/api/projects/1/attachments/2/download/b.png)",
      seed(client()),
    );

    const img = await waitFor(() => {
      const el = view.container.querySelector("img");
      expect(el).not.toBeNull();
      return el as HTMLImageElement;
    });
    expect(img.className).toContain("cursor-zoom-in");
  });

  it("enhances an id-anchored document embed", async () => {
    const view = body(
      "![a.txt](/api/projects/1/attachments/1/download/a.txt)",
      seed(client()),
    );

    // The worst of the ten forms before this card: image syntax on a text
    // attachment fell through to a bare <img>, i.e. a broken-image icon.
    const card = await waitFor(() => {
      const el = view.container.querySelector("[aria-label='expand a.txt']");
      expect(el).not.toBeNull();
      return el as HTMLElement;
    });
    expect(card).not.toBeNull();
    expect(view.container.textContent).toContain("hello from a.txt");
    expect(view.container.querySelector("img")).toBeNull();
  });

  it("still enhances the slug spelling", async () => {
    const view = body(
      "see [a.txt](/api/projects/a/attachments/1/download/a.txt)",
      seed(client()),
    );

    const link = await richLink(view);
    expect(link.getAttribute("href")).toBe(
      "/api/projects/a/attachments/1/view/a.txt",
    );
  });

  it("leaves a reference into a project the reader cannot name alone", async () => {
    const view = body(
      "see [a.txt](/api/projects/9/attachments/1/download/a.txt)\n\n![b.png](/api/projects/9/attachments/2/download/b.png)",
      seed(client()),
    );

    await waitFor(() => expect(view.container.textContent).toContain("a.txt"));
    const link = view.container.querySelector("a");
    expect(link).not.toBeNull();
    expect(link?.getAttribute("href")).toBe(
      "/api/projects/9/attachments/1/download/a.txt",
    );
    expect(link?.querySelector("svg")).toBeNull();
    const img = view.container.querySelector("img");
    expect(img).not.toBeNull();
    expect(img?.className).not.toContain("cursor-zoom-in");
  });

  it("resolves an id-anchored address the attachment kept from elsewhere", async () => {
    // The one case that exercises both halves: the id has to become a slug
    // before the alias arm (T-242), which records slugs, can match at all.
    const queries = seed(client(), [
      file(3, "note.txt", "text/plain", [{ project: "b", id: 88 }]),
    ]);

    const view = body(
      "see [note.txt](/api/projects/2/attachments/88/download/note.txt)",
      queries,
    );

    const link = await richLink(view);
    expect(link.getAttribute("href")).toBe(
      "/api/projects/a/attachments/3/view/note.txt",
    );
  });
});
