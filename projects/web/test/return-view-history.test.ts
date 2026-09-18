import {
  createMemoryHistory,
  type RouterHistory,
} from "@tanstack/react-router";
import { describe, expect, it, vi } from "vitest";
import {
  RETURN_VIEW_VERSION,
  type ReturnView,
} from "../src/lib/return-view.ts";
import {
  clearReturnMemory,
  readCurrentReturnEntry,
  updateReturnEntry,
  writeReturnEntry,
} from "../src/lib/return-view-history.ts";

const VIEWER = 7;

function view(over: Partial<ReturnView> = {}): ReturnView {
  return {
    v: RETURN_VIEW_VERSION,
    userId: VIEWER,
    snapshotId: "s1",
    target: { kind: "list", slug: "todou", search: { q: "guard" } },
    pages: [{ lane: "flat", extraPages: 2 }],
    scroll: [{ region: "window", x: 0, y: 640, candidates: [] }],
    ...over,
  };
}

const at = (host: { history: RouterHistory }) =>
  host.history.location.state as unknown as Record<string, unknown>;

/**
 * What the module needs off the router: a history, and the scroll flag it
 * clears so an annotation does not read as a navigation. `next` starts `true`
 * as the router's own does, so a test can see it being cleared.
 */
function hosting(...entries: string[]) {
  return {
    history: createMemoryHistory({ initialEntries: entries }),
    _scroll: { next: true },
  };
}

describe("a snapshot lives on the entry the reader is standing on", () => {
  it("comes back as it went in", () => {
    const history = hosting("/projects/todou?q=guard");
    writeReturnEntry(history, { view: view() });
    expect(readCurrentReturnEntry(history, VIEWER).view).toEqual(view());
  });

  it("leaves the router's own fields on the entry alone", () => {
    const history = hosting("/projects/todou");
    // Something else's field, standing in for whatever the router or a plugin
    // has already put here: a write that replaced the state wholesale would
    // take it with it.
    history.history.replace(history.history.location.href, {
      ...history.history.location.state,
      somebodyElse: 42,
    });
    const index = at(history).__TSR_index;
    writeReturnEntry(history, { view: view() });
    expect(at(history).somebodyElse).toBe(42);
    expect(at(history).__TSR_index).toBe(index);
  });

  it("is why a capture carries an id of its own: the router's key does not survive a replace", () => {
    const history = hosting("/projects/todou");
    const before = at(history).key;
    writeReturnEntry(history, { view: view() });
    expect(at(history).key).not.toBe(before);
    expect(readCurrentReturnEntry(history, VIEWER).view?.snapshotId).toBe("s1");
  });

  it("keeps two entries at the same address apart", () => {
    const history = hosting("/projects/todou");
    writeReturnEntry(history, { view: view({ snapshotId: "first" }) });
    history.history.push("/projects/todou/issues/407");
    history.history.back();
    // Same address, a second visit: the reader scrolled somewhere else this
    // time, and stepping back to the first visit must not find this one.
    history.history.push("/projects/todou");
    writeReturnEntry(history, { view: view({ snapshotId: "second" }) });
    expect(readCurrentReturnEntry(history, VIEWER).view?.snapshotId).toBe(
      "second",
    );
    history.history.back();
    expect(readCurrentReturnEntry(history, VIEWER).view?.snapshotId).toBe(
      "first",
    );
  });

  it("survives being serialised and read back, as a reload does", () => {
    const history = hosting("/projects/todou");
    writeReturnEntry(history, {
      view: view(),
      pending: { view: view({ snapshotId: "owed" }), locate: false },
    });
    const revived = hosting("/projects/todou");
    revived.history.replace(
      revived.history.location.href,
      JSON.parse(JSON.stringify(at(history))),
    );
    const entry = readCurrentReturnEntry(revived, VIEWER);
    expect(entry.view?.snapshotId).toBe("s1");
    expect(entry.pending?.view.snapshotId).toBe("owed");
    // A restore the reader already took over stays taken over across a reload:
    // the remaining pages still load, the viewport is not moved again.
    expect(entry.pending?.locate).toBe(false);
  });
});

describe("whose snapshot it is", () => {
  it("refuses one written by another account", () => {
    const history = hosting("/projects/todou");
    writeReturnEntry(history, { view: view() });
    expect(readCurrentReturnEntry(history, VIEWER + 1).view).toBeUndefined();
  });

  it("reads nothing at all while the account is still in flight", () => {
    const history = hosting("/projects/todou");
    writeReturnEntry(history, { view: view() });
    expect(readCurrentReturnEntry(history, undefined)).toEqual({});
  });
});

describe("an annotation is not a navigation", () => {
  it("tells the router not to scroll this render to the top", () => {
    const history = hosting("/projects/todou");
    writeReturnEntry(history, { view: view() });
    // The router scrolls to the top after every history event it hears about
    // unless this flag says otherwise, and a snapshot is written exactly when
    // the reader stops scrolling — so without it the page bounces to the top
    // every time they pause. Measured in a real browser; happy-dom does not
    // scroll (T-407).
    expect(history._scroll.next).toBe(false);
  });

  it("does not ask the unsaved-changes guard whether the reader may leave", async () => {
    const history = hosting("/projects/todou");
    const blockerFn = vi.fn(() => true);
    history.history.block({ blockerFn });
    writeReturnEntry(history, { view: view() });
    // Synchronously visible, and the guard never heard about it: without
    // `ignoreBlocker` a reader with a draft would be asked to confirm leaving
    // the page every time they stopped scrolling.
    expect(readCurrentReturnEntry(history, VIEWER).view?.snapshotId).toBe("s1");
    expect(blockerFn).not.toHaveBeenCalled();
  });
});

describe("when the browser will not take the write", () => {
  /** A host whose every write throws, as a full or hardened store does. */
  function refusing(): ReturnType<typeof hosting> {
    const host = hosting("/projects/todou");
    return {
      ...host,
      history: new Proxy(host.history, {
        get(target, property, receiver) {
          if (property === "replace") {
            return () => {
              throw new DOMException("quota", "QuotaExceededError");
            };
          }
          return Reflect.get(target, property, receiver);
        },
      }) as RouterHistory,
    };
  }

  it("says so, and still answers for this tab", () => {
    clearReturnMemory();
    const history = refusing();
    expect(writeReturnEntry(history, { view: view() })).toBe(false);
    expect(readCurrentReturnEntry(history, VIEWER).view?.snapshotId).toBe("s1");
    clearReturnMemory();
  });

  it("does not hand that snapshot to a different entry", () => {
    clearReturnMemory();
    const history = refusing();
    writeReturnEntry(history, { view: view() });
    const elsewhere = hosting("/projects/todou", "/projects/todou");
    expect(readCurrentReturnEntry(elsewhere, VIEWER).view).toBeUndefined();
    clearReturnMemory();
  });

  it("is forgotten at logout, because the next account must not inherit it", () => {
    clearReturnMemory();
    const history = refusing();
    writeReturnEntry(history, { view: view() });
    clearReturnMemory();
    expect(readCurrentReturnEntry(history, VIEWER).view).toBeUndefined();
  });
});

describe("updateReturnEntry", () => {
  it("rewrites one field and leaves the rest of the snapshot standing", () => {
    const history = hosting("/projects/todou");
    writeReturnEntry(history, {
      view: view(),
      pending: { view: view({ snapshotId: "owed" }), locate: true },
    });
    // What the scroll sampler does, sixty times a scroll: it must not be able
    // to overwrite what the restore is still owed with the half-built page
    // underneath it.
    updateReturnEntry(history, VIEWER, (previous) => ({
      ...previous,
      view: view({ snapshotId: "moved", scroll: [] }),
    }));
    const entry = readCurrentReturnEntry(history, VIEWER);
    expect(entry.view?.snapshotId).toBe("moved");
    expect(entry.pending?.view.snapshotId).toBe("owed");
  });

  it("starts from nothing on an entry that never held one", () => {
    const history = hosting("/inbox");
    updateReturnEntry(history, VIEWER, (previous) => {
      expect(previous).toEqual({});
      return { origin: view() };
    });
    expect(readCurrentReturnEntry(history, VIEWER).origin?.snapshotId).toBe(
      "s1",
    );
  });

  it("does not let a detail entry's frozen origin be read as a collection view", () => {
    const history = hosting("/projects/todou/issues/407");
    writeReturnEntry(history, { origin: view() });
    const entry = readCurrentReturnEntry(history, VIEWER);
    expect(entry.origin?.snapshotId).toBe("s1");
    expect(entry.view).toBeUndefined();
  });
});
