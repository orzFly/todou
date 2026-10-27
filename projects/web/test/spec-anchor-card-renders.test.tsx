import { act, fireEvent } from "@testing-library/react";
import type { SpecFiles } from "@todou/shared";
import { Profiler } from "react";
import { describe, expect, it } from "vitest";
import { specFilesQuery } from "../src/api/spec.ts";
import { SpecCommentAnchorCard } from "../src/components/timeline/spec-comment-card.tsx";
import { renderWithProviders, testQueryClient } from "./render.tsx";

// T-602: every annotation card on a review shares its version's files query
// with the spec sidebar. A disabled observer in each card still re-rendered
// it on every state change of that query, so a 31-annotation review rendered
// all 31 cards three times on load.

const component = {
  type: "spec_comment" as const,
  anchor: {
    path: "design.md",
    version: 2,
    line_start: 3,
    line_end: 3,
    col_start: null,
    col_end: null,
    quote: "line three",
  },
};

const FILES: SpecFiles = {
  version: 2,
  files: [
    {
      path: "design.md",
      body: "line one\nline two\nline three\nline four",
      size: 38,
    },
  ],
};

function mount() {
  const client = testQueryClient();
  const renders = { count: 0 };
  const view = renderWithProviders(
    <Profiler id="card" onRender={() => renders.count++}>
      <SpecCommentAnchorCard
        slug="p"
        issueNumber={23}
        commentId={412}
        component={component}
        resolvedAt={null}
        canResolve
      />
    </Profiler>,
    client,
  );
  return { client, renders, view };
}

describe("SpecCommentAnchorCard renders", () => {
  it("does not re-render when someone else loads its version's files", async () => {
    const { client, renders, view } = mount();
    await view.findByText("design.md");
    const settled = renders.count;
    await act(async () => {
      await client.prefetchQuery({
        ...specFilesQuery("p", 23, 2),
        queryFn: () => Promise.resolve(FILES),
      });
      // react-query hands observers their notifications on a timer.
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(renders.count).toBe(settled);
  });

  it("still widens the quote to its surrounding lines once expanded", async () => {
    const { client, view } = mount();
    client.setQueryData(specFilesQuery("p", 23, 2).queryKey, FILES);
    fireEvent.click(await view.findByTitle("expand surrounding context"));
    expect(await view.findByText("line one")).toBeTruthy();
    expect(view.getByText("line four")).toBeTruthy();
  });
});
