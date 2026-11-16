/**
 * Colors a diagram is drawn in, already resolved to `#rrggbb`: mermaid's
 * color math (khroma) cannot parse the app's oklch() custom properties.
 */
export type DiagramPalette = {
  dark: boolean;
  background: string;
  foreground: string;
  muted: string;
  mutedForeground: string;
  border: string;
};

export type DiagramResult =
  | { ok: true; svg: string; width: number }
  | { ok: false; error: string };

type Mermaid = typeof import("mermaid")["default"];

// mermaid is the heaviest optional dependency (T-523); like @pierre/diffs it
// is only ever reached through this dynamic import, so its chunks are fetched
// the first time a page actually holds a diagram.
let loaded: Promise<Mermaid> | undefined;
function loadMermaid(): Promise<Mermaid> {
  loaded ??= import("mermaid").then((m) => m.default);
  return loaded;
}

// `initialize` is global state, so a render for one palette must not
// interleave with a render for another: every call waits for the last.
let queue: Promise<unknown> = Promise.resolve();
let sequence = 0;

export function renderDiagram(
  source: string,
  palette: DiagramPalette,
  fontFamily: string,
): Promise<DiagramResult> {
  const run = queue.then(async (): Promise<DiagramResult> => {
    const mermaid = await loadMermaid();
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      layout: "elk",
      theme: "base",
      fontFamily,
      themeVariables: themeVariables(palette, fontFamily),
    });
    const scratch = scratchHost();
    try {
      // parse() first: a source that does not parse would otherwise be
      // drawn as mermaid's error diagram before render() throws the same
      // message.
      await mermaid.parse(source);
      const { svg } = await mermaid.render(
        `mermaid-${++sequence}`,
        source,
        scratch,
      );
      return { ok: true, svg, width: viewBoxWidth(svg) };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    } finally {
      scratch.remove();
    }
  });
  queue = run.catch(() => undefined);
  return run;
}

/**
 * Where mermaid draws a diagram to measure it (T-703). Left to itself it
 * appends that scratch drawing to the end of <body>, in flow, where it stays
 * on screen below the page for as long as layout takes — a whole queue of
 * diagrams on a long card — and for good if drawing throws. Hidden rather
 * than `display: none`, because text is measured with getBBox(), which needs
 * a layout box.
 */
function scratchHost(): HTMLDivElement {
  const host = document.createElement("div");
  host.setAttribute("aria-hidden", "true");
  host.style.cssText =
    "position:fixed;top:0;left:0;width:100%;visibility:hidden;pointer-events:none";
  document.body.append(host);
  return host;
}

function themeVariables(p: DiagramPalette, fontFamily: string) {
  return {
    darkMode: p.dark,
    fontFamily,
    background: p.background,
    primaryColor: p.muted,
    primaryTextColor: p.foreground,
    primaryBorderColor: p.mutedForeground,
    secondaryColor: p.muted,
    tertiaryColor: p.background,
    mainBkg: p.muted,
    nodeBorder: p.mutedForeground,
    textColor: p.foreground,
    nodeTextColor: p.foreground,
    lineColor: p.mutedForeground,
    clusterBkg: p.background,
    clusterBorder: p.border,
    edgeLabelBackground: p.background,
    titleColor: p.foreground,
    noteBkgColor: p.muted,
    noteTextColor: p.foreground,
    noteBorderColor: p.border,
  };
}

/** The diagram's natural width, which the fit rule in styles.css scales from. */
export function viewBoxWidth(svg: string): number {
  const match = /viewBox="[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)/.exec(svg);
  return match ? Number(match[1]) : 0;
}

/**
 * mermaid's parse errors quote the offending line and draw a caret under it,
 * which only lines up in the monospace block the error came from. One line
 * is what fits under the source: where it failed, and what it got there.
 */
export function errorSummary(message: string): string {
  const lines = message
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length <= 1) return lines[0] ?? "";
  const got = lines.at(-1) ?? "";
  return /^Parse error/.test(lines[0] ?? "") && /got /.test(got)
    ? `${lines[0]} ${got}`
    : (lines[0] ?? "");
}
