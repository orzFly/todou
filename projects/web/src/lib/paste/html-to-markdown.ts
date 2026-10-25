import type { RootContent as HastContent, Root as HastRoot } from "hast";
import { fromDom } from "hast-util-from-dom";
import { toMdast } from "hast-util-to-mdast";
import type {
  Nodes,
  Paragraph,
  Parents,
  PhrasingContent,
  Root,
  RootContent,
} from "mdast";
import { gfmToMarkdown } from "mdast-util-gfm";
import { toMarkdown } from "mdast-util-to-markdown";

export type PasteSource = {
  html: string;
  plain: string;
  types: readonly string[];
  /** The `vscode-editor-data` payload, when the clipboard carries one. */
  vscodeEditorData?: string;
};

export type PasteConversion = {
  /** `null`: the clipboard has no formatting worth a Markdown form. */
  markdown: string | null;
  /** Copied out of a code editor: the default form stays plain text. */
  codeLike: boolean;
  /** One line of text, so block structure is flattened to inline. */
  inline: boolean;
};

const DROPPED = "meta, style, script, head, title, link, template";

/**
 * What the clipboard's HTML says in Markdown. Never throws: a converter that
 * fails takes only the Markdown option with it, and the paste goes ahead as
 * plain text.
 */
export function htmlToMarkdown(source: PasteSource): PasteConversion {
  try {
    return convert(source);
  } catch {
    return {
      markdown: null,
      codeLike: false,
      inline: !source.plain.trim().includes("\n"),
    };
  }
}

function convert(source: PasteSource): PasteConversion {
  const doc = new DOMParser().parseFromString(source.html, "text/html");
  for (const element of doc.querySelectorAll(DROPPED)) element.remove();
  removeComments(doc.body);
  normalizeInlineStyles(doc);

  const plain =
    source.plain === "" ? (doc.body.textContent ?? "") : source.plain;
  const inline = !plain.trim().includes("\n");

  if (isCodeLike(doc.body, source.types)) {
    const lang = vscodeMode(source.vscodeEditorData);
    const tree: Root = inline
      ? {
          type: "root",
          children: [
            {
              type: "paragraph",
              children: [{ type: "inlineCode", value: plain.trim() }],
            },
          ],
        }
      : {
          type: "root",
          children: [{ type: "code", lang, value: plain.replace(/\n$/, "") }],
        };
    return { markdown: serialize(tree), codeLike: true, inline };
  }

  const hast: HastRoot = {
    type: "root",
    children: [...doc.body.childNodes].map(
      (node) => fromDom(node) as HastContent,
    ),
  };
  let tree = toMdast(hast) as Root;
  degradeUrls(tree);
  tidy(tree);
  if (inline) tree = flatten(tree);
  if (!hasFormatting(tree)) return { markdown: null, codeLike: false, inline };
  const markdown = serialize(tree);
  return {
    markdown: markdown === "" ? null : markdown,
    codeLike: false,
    inline,
  };
}

function removeComments(root: Node) {
  const doomed: Node[] = [];
  const walk = (node: Node) => {
    for (const child of node.childNodes) {
      if (child.nodeType === Node.COMMENT_NODE) doomed.push(child);
      else walk(child);
    }
  };
  walk(root);
  for (const node of doomed) node.parentNode?.removeChild(node);
}

function styleValue(element: Element, property: string): string | null {
  const style = element.getAttribute("style");
  if (style === null) return null;
  const match = new RegExp(`(?:^|;)\\s*${property}\\s*:\\s*([^;]+)`, "i").exec(
    style,
  );
  return match?.[1]?.trim().toLowerCase() ?? null;
}

function isBoldWeight(weight: string | null): boolean {
  if (weight === null) return false;
  if (weight === "bold" || weight === "bolder") return true;
  const numeric = Number.parseInt(weight, 10);
  return Number.isFinite(numeric) && numeric >= 600;
}

/**
 * Google Docs writes its formatting as inline styles: bold and italic are
 * `<span style="font-weight:700">`, and the whole fragment sits inside a
 * `<b style="font-weight:normal">` that would otherwise turn every word bold.
 */
function normalizeInlineStyles(doc: Document) {
  for (const element of doc.body.querySelectorAll("b, strong")) {
    const weight = styleValue(element, "font-weight");
    if (weight === "normal" || weight === "400") unwrap(element);
  }
  for (const span of doc.body.querySelectorAll("span")) {
    let inner: Element = span;
    if (styleValue(span, "font-style") === "italic") {
      inner = wrapChildren(inner, doc.createElement("em"));
    }
    if (isBoldWeight(styleValue(span, "font-weight"))) {
      wrapChildren(inner, doc.createElement("strong"));
    }
  }
}

function unwrap(element: Element) {
  element.replaceWith(...element.childNodes);
}

function wrapChildren(parent: Element, wrapper: Element): Element {
  wrapper.append(...parent.childNodes);
  parent.append(wrapper);
  return wrapper;
}

const PRE_WHITESPACE = /white-space\s*:\s*pre(?:-wrap)?(?![-\w])/i;

/**
 * VS Code says so in a clipboard type of its own. JetBrains IDEs and
 * terminals do not, but they wrap every character in preformatted styling,
 * which an ordinary page never does to all of its text.
 */
function isCodeLike(body: HTMLElement, types: readonly string[]): boolean {
  if (types.includes("vscode-editor-data")) return true;
  let texts = 0;
  const walk = (node: Node, pre: boolean): boolean => {
    for (const child of node.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) {
        if ((child.textContent ?? "").trim() === "") continue;
        texts += 1;
        if (!pre) return false;
      } else if (child.nodeType === Node.ELEMENT_NODE) {
        const element = child as Element;
        const inside =
          pre ||
          element.tagName === "PRE" ||
          PRE_WHITESPACE.test(element.getAttribute("style") ?? "");
        if (!walk(element, inside)) return false;
      }
    }
    return true;
  };
  return walk(body, false) && texts > 0;
}

function vscodeMode(data: string | undefined): string | null {
  if (data === undefined || data === "") return null;
  try {
    const parsed: unknown = JSON.parse(data);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "mode" in parsed &&
      typeof parsed.mode === "string" &&
      /^[\w+#.-]+$/.test(parsed.mode)
    ) {
      return parsed.mode;
    }
  } catch {
    // An unreadable payload only costs the fence its language.
  }
  return null;
}

const LINK_SCHEMES = /^(?:https?|mailto):/i;
const IMAGE_SCHEMES = /^https?:\/\//i;

/**
 * A relative link points into the page it was copied from, which this
 * document is not; `javascript:` and `data:` must never become clickable or
 * loadable here. They keep their words and lose the target.
 */
function degradeUrls(parent: Parents) {
  const next: RootContent[] = [];
  for (const child of parent.children as RootContent[]) {
    if ("children" in child) degradeUrls(child);
    if (child.type === "link" && !LINK_SCHEMES.test(child.url)) {
      next.push(...child.children);
    } else if (child.type === "image" && !IMAGE_SCHEMES.test(child.url)) {
      const alt = child.alt?.trim() ?? "";
      if (alt !== "") next.push({ type: "text", value: alt });
    } else {
      next.push(child);
    }
  }
  (parent as { children: RootContent[] }).children = next;
}

const MARKS = new Set(["emphasis", "strong", "delete"]);

/**
 * Two cleanups the serializer cannot make for itself. A `<br>` standing
 * between paragraphs (Google Docs puts one there) arrives as a paragraph of
 * nothing but a break, which would print as a run of blank lines. And a space
 * at the edge of a mark (`<em> word</em>`) cannot sit inside `_…_`, so the
 * serializer escapes it as `&#x20;`; outside the mark it means the same.
 */
function tidy(parent: Parents) {
  const next: RootContent[] = [];
  for (const child of parent.children as RootContent[]) {
    if ("children" in child) tidy(child);
    if (child.type === "paragraph" && isBlank(child.children)) continue;
    if (MARKS.has(child.type) && "children" in child) {
      const inner = child.children as PhrasingContent[];
      const lead = takeEdgeSpace(inner, "start");
      const trail = takeEdgeSpace(inner, "end");
      if (lead !== "") next.push({ type: "text", value: lead });
      if (inner.length > 0) next.push(child);
      if (trail !== "") next.push({ type: "text", value: trail });
      continue;
    }
    next.push(child);
  }
  (parent as { children: RootContent[] }).children = next;
}

function isBlank(children: PhrasingContent[]): boolean {
  return children.every(
    (c) => c.type === "break" || (c.type === "text" && c.value.trim() === ""),
  );
}

function takeEdgeSpace(
  children: PhrasingContent[],
  edge: "start" | "end",
): string {
  const index = edge === "start" ? 0 : children.length - 1;
  const node = children[index];
  if (node?.type !== "text") return "";
  const match =
    edge === "start" ? /^\s+/.exec(node.value) : /\s+$/.exec(node.value);
  if (match === null) return "";
  node.value =
    edge === "start"
      ? node.value.slice(match[0].length)
      : node.value.slice(0, -match[0].length);
  if (node.value === "") children.splice(index, 1);
  return match[0];
}

const PLAIN_NODES = new Set(["root", "paragraph", "text", "break"]);

function hasFormatting(node: Nodes): boolean {
  if (!PLAIN_NODES.has(node.type)) return true;
  return "children" in node && node.children.some(hasFormatting);
}

/**
 * One line of text pasted into the middle of a sentence is meant to stay in
 * that sentence: a copied heading or list item keeps its links and emphasis
 * but none of the block it came from.
 */
const PHRASING = new Set([
  "text",
  "emphasis",
  "strong",
  "delete",
  "link",
  "image",
  "inlineCode",
  "break",
]);

function flatten(tree: Root): Root {
  const runs: PhrasingContent[][] = [];
  const collect = (node: Nodes) => {
    if (node.type === "code") {
      runs.push([{ type: "inlineCode", value: node.value.trim() }]);
      return;
    }
    if (
      node.type === "paragraph" ||
      node.type === "heading" ||
      node.type === "tableCell"
    ) {
      const phrasing = node.children.filter((c) => c.type !== "break");
      if (phrasing.length > 0) runs.push(phrasing);
      return;
    }
    if (!("children" in node)) return;
    // A fragment with no block around it (a bare <img>, a few words in a
    // <span>) arrives as phrasing straight under the root.
    let loose: PhrasingContent[] = [];
    for (const child of node.children as Nodes[]) {
      if (PHRASING.has(child.type)) {
        if (child.type !== "break") loose.push(child as PhrasingContent);
        continue;
      }
      if (loose.length > 0) runs.push(loose);
      loose = [];
      collect(child);
    }
    if (loose.length > 0) runs.push(loose);
  };
  collect(tree);
  const children: PhrasingContent[] = [];
  for (const run of runs) {
    if (children.length > 0) children.push({ type: "text", value: " " });
    children.push(...run);
  }
  const paragraph: Paragraph = { type: "paragraph", children };
  return { type: "root", children: children.length > 0 ? [paragraph] : [] };
}

function serialize(tree: Root): string {
  return toMarkdown(tree, {
    bullet: "-",
    emphasis: "_",
    strong: "*",
    fences: true,
    rule: "-",
    listItemIndent: "one",
    extensions: [gfmToMarkdown()],
  }).trim();
}
