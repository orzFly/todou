import { render, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  CodeBlock,
  PatchFiles,
  parsePatch,
} from "../src/components/shared/pierre.tsx";

// Real pierre, not a mock: what regressed is pierre's own reconciliation of a
// controlled CodeView, which a stand-in would only restate (T-787).

/** Text as the reader can reach it, shadow roots included. */
function deepText(root: Element | DocumentFragment): string {
  const parts = [root.textContent ?? ""];
  for (const el of root.querySelectorAll("*")) {
    if (el.shadowRoot !== null) parts.push(deepText(el.shadowRoot));
  }
  return parts.join("\n");
}

async function drawn(container: HTMLElement, text: string) {
  await waitFor(() => expect(deepText(container)).toContain(text), {
    timeout: 5000,
  });
}

describe("CodeBlock follows its contents", () => {
  it("drops a line removed from the fence", async () => {
    const { container, rerender } = render(
      <CodeBlock filename="snippet.txt" contents={"alpha\nstale"} plain />,
    );
    await drawn(container, "stale");
    rerender(<CodeBlock filename="snippet.txt" contents="alpha" plain />);
    await waitFor(() => expect(deepText(container)).not.toContain("stale"));
  });
});

function patchOf(added: string): string {
  return [
    "diff --git a/f.txt b/f.txt",
    "--- a/f.txt",
    "+++ b/f.txt",
    "@@ -1 +1,2 @@",
    " keep",
    `+${added}`,
    "",
  ].join("\n");
}

describe("PatchFiles follows its patch", () => {
  it("draws the edited patch rather than the one first shown", async () => {
    const first = await parsePatch(patchOf("first-addition"));
    const second = await parsePatch(patchOf("second-addition"));
    if (first === null || second === null) throw new Error("patch unparsed");
    const view = (patches: typeof first, text: string) => (
      <PatchFiles
        patches={patches}
        text={text}
        className="h-96"
        commits={patches.map(() => null)}
        renderHeader={() => null}
      />
    );
    const { container, rerender } = render(
      view(first, patchOf("first-addition")),
    );
    await drawn(container, "first-addition");
    rerender(view(second, patchOf("second-addition")));
    await drawn(container, "second-addition");
  });
});
