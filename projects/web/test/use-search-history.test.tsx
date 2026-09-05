import type { QueryClient } from "@tanstack/react-query";
import { fireEvent, waitFor } from "@testing-library/react";
import type { Me } from "@todou/shared";
import { useRef } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { meQuery } from "../src/api/queries.ts";
import { useSearchHistory } from "../src/api/search-history.ts";
import { historyKey } from "../src/lib/search-history.ts";
import { renderWithProviders, testQueryClient } from "./render.tsx";

const NOW = Date.parse("2026-09-05T12:00:00Z");
const USER = 7;

const me: Me = {
  id: USER,
  login: "user",
  display_name: "User",
  kind: "human",
  avatar_url: null,
  owner: null,
  email: null,
  is_instance_admin: false,
  created_at: "2026-01-01T00:00:00Z",
};

function seeded(raw?: string): QueryClient {
  const client = testQueryClient();
  client.setQueryData(meQuery.queryKey, me);
  if (raw !== undefined) localStorage.setItem(historyKey(USER), raw);
  return client;
}

/**
 * The hook's output verbatim, plus the two calls as buttons, plus how often
 * React came back — the last one is what would catch a snapshot that mints a
 * new identity on every read.
 */
function Probe({ slug = "todou" }: { slug?: string }) {
  const history = useSearchHistory(slug);
  const renders = useRef(0);
  renders.current += 1;
  return (
    <div>
      <pre data-testid="entries">{JSON.stringify(history.entries)}</pre>
      <span data-testid="renders">{renders.current}</span>
      <button type="button" onClick={() => history.record("新查询")}>
        record
      </button>
      <button type="button" onClick={() => history.forget("bug")}>
        forget
      </button>
    </div>
  );
}

const listed = (view: { getByTestId: (id: string) => HTMLElement }) =>
  (
    JSON.parse(view.getByTestId("entries").textContent ?? "[]") as Array<{
      q: string;
    }>
  ).map((e) => e.q);

afterEach(() => localStorage.clear());

describe("useSearchHistory", () => {
  it("returns this project's entries only, newest first", async () => {
    const client = seeded(
      JSON.stringify({
        todou: [
          { q: "bug", t: NOW },
          { q: "spec", t: NOW - 1000 },
        ],
        accel: [{ q: "theirs", t: NOW }],
      }),
    );
    const view = renderWithProviders(<Probe />, client);
    await view.findByTestId("entries");
    expect(listed(view)).toEqual(["bug", "spec"]);
  });

  it("drops the row the moment it is forgotten", async () => {
    // Nothing else on the page changes when a row is deleted, so this is
    // also the case that proves the store announces its own writes.
    const client = seeded(JSON.stringify({ todou: [{ q: "bug", t: NOW }] }));
    const view = renderWithProviders(<Probe />, client);
    await view.findByTestId("entries");

    fireEvent.click(view.getByText("forget"));
    await waitFor(() => expect(listed(view)).toEqual([]));
  });

  it("puts a recorded query at the front", async () => {
    const client = seeded(JSON.stringify({ todou: [{ q: "bug", t: NOW }] }));
    const view = renderWithProviders(<Probe />, client);
    await view.findByTestId("entries");

    fireEvent.click(view.getByText("record"));
    await waitFor(() => expect(listed(view)).toEqual(["新查询", "bug"]));
  });

  it("reads a broken payload as no history at all", async () => {
    const client = seeded("{");
    const view = renderWithProviders(<Probe />, client);
    await view.findByTestId("entries");
    expect(listed(view)).toEqual([]);
  });

  it("settles instead of re-rendering forever", async () => {
    const client = seeded(JSON.stringify({ todou: [{ q: "bug", t: NOW }] }));
    const view = renderWithProviders(<Probe />, client);
    await view.findByTestId("entries");
    const before = Number(view.getByTestId("renders").textContent);

    fireEvent.click(view.getByText("record"));
    await waitFor(() => expect(listed(view)).toEqual(["新查询", "bug"]));
    const after = Number(view.getByTestId("renders").textContent);
    expect(after - before).toBeLessThan(5);
  });
});
