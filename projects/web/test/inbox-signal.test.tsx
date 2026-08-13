import { waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  INBOX_FALLBACK_MS,
  INBOX_POLL_MS,
  useInboxSignal,
} from "../src/api/inbox.ts";
import { renderWithProviders, testQueryClient } from "./render.tsx";

function Probe({ fetcher }: { fetcher: (url: string) => Promise<Response> }) {
  useInboxSignal(fetcher);
  return null;
}

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

function setup(fetcher: (url: string) => Promise<Response>) {
  const client = testQueryClient();
  client.setQueryData(["me"], { id: 7 });
  const invalidate = vi.spyOn(client, "invalidateQueries");
  const view = renderWithProviders(<Probe fetcher={fetcher} />, client);
  return { client, invalidate, view };
}

describe("useInboxSignal", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("bootstraps with last=1, then invalidates only when items arrive", async () => {
    const calls: string[] = [];
    const fetcher = vi.fn(async (url: string) => {
      calls.push(url);
      if (url.includes("last=1")) {
        return jsonResponse({ items: [], next_cursor: "c1" });
      }
      if (url.includes("after=c1")) {
        return jsonResponse({ items: [{}], next_cursor: "c2" });
      }
      return jsonResponse({ items: [], next_cursor: "c2" });
    });
    const { invalidate } = setup(fetcher);

    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    expect(calls[0]).toContain("last=1");
    expect(calls[0]).toContain("exclude_actor=7");
    // The bootstrap round never invalidates — there is nothing new yet.
    expect(invalidate).not.toHaveBeenCalledWith({ queryKey: ["inbox"] });

    await vi.advanceTimersByTimeAsync(INBOX_POLL_MS);
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    expect(calls[1]).toContain("after=c1");
    await waitFor(() =>
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ["inbox"] }),
    );

    // An empty increment moves the cursor but stays quiet.
    invalidate.mockClear();
    await vi.advanceTimersByTimeAsync(INBOX_POLL_MS);
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(3));
    expect(calls[2]).toContain("after=c2");
    expect(invalidate).not.toHaveBeenCalledWith({ queryKey: ["inbox"] });
  });

  it("downgrades to slow whole-query refetches on 404", async () => {
    const fetcher = vi.fn(async () => jsonResponse({}, 404));
    const { invalidate } = setup(fetcher);

    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));

    // The endpoint is gone for good (pre-T-93 server): no more probes...
    await vi.advanceTimersByTimeAsync(INBOX_POLL_MS * 3);
    expect(fetcher).toHaveBeenCalledTimes(1);

    // ...but the inbox still refreshes on the fallback cadence.
    invalidate.mockClear();
    await vi.advanceTimersByTimeAsync(INBOX_FALLBACK_MS);
    await waitFor(() =>
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ["inbox"] }),
    );
  });

  it("keeps the cursor across transient network failures", async () => {
    let failNext = false;
    const calls: string[] = [];
    const fetcher = vi.fn(async (url: string) => {
      calls.push(url);
      if (url.includes("last=1")) {
        return jsonResponse({ items: [], next_cursor: "c1" });
      }
      if (failNext) {
        failNext = false;
        throw new Error("offline");
      }
      return jsonResponse({ items: [], next_cursor: "c1" });
    });
    setup(fetcher);

    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    failNext = true;
    await vi.advanceTimersByTimeAsync(INBOX_POLL_MS);
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    await vi.advanceTimersByTimeAsync(INBOX_POLL_MS);
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(3));
    // The failed round did not lose the position.
    expect(calls[2]).toContain("after=c1");
  });
});
