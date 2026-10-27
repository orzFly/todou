import { type ReactNode, Suspense, use } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CodeBlock } from "../src/components/shared/pierre.tsx";

// T-600: a code block that suspended for pierre's chunk threw away the render
// of the page around it. The page had itself just been waiting on its data,
// and React does not commit a retry that suspends again within 300 ms of
// showing a fallback: once the chunk landed it rendered the whole page — the
// spec document's markdown parse included — a second time. The page must
// render once its data is in.
//
// Outside act() on purpose: act() flushes retries without that throttle, and
// the second render never happens there.
//
// One case per file: every pierre surface shares one module, and only the
// first render to ask for it waits.

// The delay is the chunk's network fetch. A module that resolves within a
// microtask is waited out by React in place, and nothing is thrown away.
vi.mock("@pierre/diffs/react", async () => {
  await new Promise((resolve) => setTimeout(resolve, 20));
  return { CodeView: () => <div data-testid="code-view" /> };
});

const env = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
let actEnvironment: boolean | undefined;
let cleanup: () => void = () => {};

beforeEach(() => {
  actEnvironment = env.IS_REACT_ACT_ENVIRONMENT;
  env.IS_REACT_ACT_ENVIRONMENT = false;
});

afterEach(() => {
  cleanup();
  env.IS_REACT_ACT_ENVIRONMENT = actEnvironment;
});

async function renderAfterData(block: ReactNode, testId: string) {
  let resolve!: () => void;
  const data = new Promise<void>((r) => {
    resolve = r;
  });
  let renders = 0;
  function Page() {
    use(data);
    renders++;
    return block;
  }
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  cleanup = () => {
    root.unmount();
    container.remove();
  };
  root.render(
    <Suspense fallback={<p>page pending</p>}>
      <Page />
    </Suspense>,
  );
  await vi.waitFor(() => expect(container.textContent).toBe("page pending"));
  // Lets React finish pre-rendering the suspended page behind the fallback,
  // so the data cannot land mid-pass and restart it for reasons of its own —
  // while staying well inside the 300 ms that makes the chunk's restart.
  await new Promise((r) => setTimeout(r, 30));
  resolve();
  await vi.waitFor(() =>
    expect(container.querySelector(`[data-testid="${testId}"]`)).not.toBeNull(),
  );
  return renders;
}

describe("a code block while pierre's chunk loads (T-600)", () => {
  it("renders the page around it once", async () => {
    const renders = await renderAfterData(
      <CodeBlock filename="a.ts" contents="const a = 1;" />,
      "code-view",
    );
    expect(renders).toBe(1);
  });
});
