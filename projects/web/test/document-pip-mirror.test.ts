import { afterEach, describe, expect, it } from "vitest";
import { mirrorDocument } from "../src/lib/use-document-pip.ts";

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

let stop: (() => void) | undefined;
let original: HTMLStyleElement | undefined;

afterEach(() => {
  stop?.();
  stop = undefined;
  original?.remove();
  original = undefined;
});

function themed(text: string) {
  original = document.createElement("style");
  original.setAttribute("data-orz-theme", "");
  original.textContent = text;
  document.head.append(original);
  return original;
}

const copyIn = (target: Document) =>
  target.head.querySelector("style[data-orz-theme]");

describe("mirrorDocument", () => {
  it("rewrites a copied style when the theme store rewrites the original", async () => {
    const style = themed(":root { --background: white; }");
    const target = document.implementation.createHTMLDocument("pip");
    stop = mirrorDocument(target);
    expect(copyIn(target)?.textContent).toBe(":root { --background: white; }");

    // How the store repaints: the same element, its text replaced.
    style.textContent = ":root { --background: black; }";
    await settle();
    expect(copyIn(target)?.textContent).toBe(":root { --background: black; }");

    // An edit to the text node itself, rather than a replacement.
    (style.firstChild as Text).data = ":root { --background: gray; }";
    await settle();
    expect(copyIn(target)?.textContent).toBe(":root { --background: gray; }");
  });

  it("drops the copy when the original goes", async () => {
    const style = themed(":root { --background: white; }");
    const target = document.implementation.createHTMLDocument("pip");
    stop = mirrorDocument(target);
    expect(copyIn(target)).not.toBeNull();

    style.remove();
    await settle();
    expect(copyIn(target)).toBeNull();
  });

  it("copies a stylesheet added after the window opened, once", async () => {
    const target = document.implementation.createHTMLDocument("pip");
    stop = mirrorDocument(target);
    const style = themed(":root { --background: white; }");
    await settle();
    expect(target.head.querySelectorAll("style[data-orz-theme]")).toHaveLength(
      1,
    );
    // Moved to the end of <head>, as the store does with the guard's element.
    document.head.append(style);
    await settle();
    expect(target.head.querySelectorAll("style[data-orz-theme]")).toHaveLength(
      1,
    );
  });
});
