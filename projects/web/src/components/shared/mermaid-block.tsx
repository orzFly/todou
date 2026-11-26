import { useTheme } from "@orz/ui/theme";
import { Maximize2Icon } from "lucide-react";
import {
  type CSSProperties,
  type RefObject,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { CompareViewerContext } from "@/components/issue/attachment-markdown.tsx";
import {
  AttachmentViewerDialog,
  type DiagramPair,
  type ViewerState,
} from "@/components/issue/attachment-viewer.tsx";
import { FenceFrame } from "@/components/shared/fence-frame.tsx";
import {
  CompareLabelsContext,
  type CompareSide,
  MediaCompare,
} from "@/components/shared/media-compare.tsx";
import { CodeBlock, CodeDiffBlock } from "@/components/shared/pierre.tsx";
import { Button } from "@/components/ui/button.tsx";
import {
  type DiagramPalette,
  type DiagramResult,
  errorSummary,
  renderDiagram,
} from "@/lib/mermaid.ts";
import { colourChanges } from "@/lib/mermaid-change.ts";

let canvas: CanvasRenderingContext2D | null | undefined;

/**
 * Any CSS color → `#rrggbb`, composited over `under` so translucent tokens
 * (the dark themes' borders) come out as the color they actually paint.
 */
function toHex(color: string, under: string): string {
  canvas ??= document.createElement("canvas").getContext("2d", {
    willReadFrequently: true,
  });
  if (canvas == null) return color;
  canvas.clearRect(0, 0, 1, 1);
  canvas.fillStyle = under;
  canvas.fillRect(0, 0, 1, 1);
  canvas.fillStyle = color;
  canvas.fillRect(0, 0, 1, 1);
  const [r = 0, g = 0, b = 0] = canvas.getImageData(0, 0, 1, 1).data;
  return `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

function readPalette(el: Element): DiagramPalette {
  const style = getComputedStyle(el);
  const token = (name: string) => style.getPropertyValue(name).trim();
  const background = toHex(token("--background") || "#fff", "#fff");
  const hex = (name: string) => toHex(token(name), background);
  return {
    dark: document.documentElement.classList.contains("dark"),
    background,
    foreground: hex("--foreground"),
    muted: hex("--muted"),
    mutedForeground: hex("--muted-foreground"),
    border: hex("--border"),
  };
}

/**
 * A ```mermaid fence drawn as its diagram (T-523). The source shows until the
 * first render lands — the renderer is a lazy chunk — and stays one click
 * away afterwards. A diagram that does not parse keeps its source on screen
 * with the parser's complaint under it.
 */
export function MermaidBlock({
  filename,
  source,
  title,
  collapsible = false,
}: {
  filename: string;
  source: string;
  /** The fence's filename; see `FenceFrame`. */
  title?: string;
  /** Caps the source, never the drawn diagram. */
  collapsible?: boolean;
}) {
  const probe = useRef<HTMLDivElement>(null);
  const result = useDiagram(probe, source);
  const [showSource, setShowSource] = useState(false);
  const key = useId();
  const viewer = useContext(CompareViewerContext);
  // Outside a page that provides one, a diagram views alone.
  const [own, setOwn] = useState<ViewerState | null>(null);

  const diagram = result?.ok === true ? result : null;
  const drawn = diagram !== null && !showSource;
  const open = () => {
    if (diagram === null) return;
    const view = {
      key,
      title: title ?? "diagram",
      diagramType: diagramType(diagram.svg),
      svg: diagram.svg,
      source,
      size: { width: diagram.width, height: diagram.height },
    };
    if (viewer !== null) viewer.openDiagram(view);
    else setOwn({ diagram: view });
  };
  return (
    <div ref={probe}>
      <FenceFrame
        text={source}
        title={title}
        collapsible={collapsible && !drawn}
        // The toggle is the reader's only way to the source, so it is never
        // hidden behind a hover.
        toolbarAlwaysVisible={diagram !== null}
        actions={
          diagram !== null && (
            <>
              <SourceToggle
                shown={showSource}
                onToggle={() => setShowSource((shown) => !shown)}
              />
              <OpenInViewer onOpen={open} />
            </>
          )
        }
      >
        {drawn ? (
          <div
            className="mermaid-diagram overflow-x-auto p-4"
            style={{ "--diagram-width": `${diagram.width}px` } as CSSProperties}
          >
            <button
              type="button"
              aria-label="Open in the viewer"
              className="media-compare-open"
              onClick={open}
              // mermaid's own output under securityLevel "strict", which runs
              // labels through DOMPurify: markup survives, scripts and
              // handlers do not.
              // biome-ignore lint/security/noDangerouslySetInnerHtml: sanitized by mermaid, see above
              dangerouslySetInnerHTML={{ __html: diagram.svg }}
            />
          </div>
        ) : (
          <CodeBlock filename={filename} contents={source} bareFallback />
        )}
        {result?.ok === false && <ErrorLine error={result.error} />}
      </FenceFrame>
      {viewer === null && (
        <AttachmentViewerDialog
          state={own}
          onNavigate={() => {}}
          onClose={() => setOwn(null)}
        />
      )}
    </div>
  );
}

/**
 * A changed ```mermaid fence in a compare view (T-724): both versions drawn
 * side by side, what changed coloured red and green (T-773). Until both
 * renders are back, and when neither parses, it is the source diff the fence
 * would otherwise be. Either picture opens both in the viewer.
 */
export function MermaidCompare({
  filename,
  before,
  after,
  title,
}: {
  filename: string;
  before: string;
  after: string;
  /** The fence's filename; see `FenceFrame`. */
  title?: string;
}) {
  const probe = useRef<HTMLDivElement>(null);
  const old = useDiagram(probe, before);
  const next = useDiagram(probe, after);
  const labels = useContext(CompareLabelsContext);
  const [showSource, setShowSource] = useState(false);

  // Measured during render on purpose: the colours have to arrive with the
  // diagrams, and an effect would paint one frame of them plain first.
  const marked = useMemo(
    () =>
      old?.ok === true && next?.ok === true
        ? colourChanges(old.svg, next.svg)
        : null,
    [old, next],
  );

  const id = useId();
  const pair: DiagramPair | null =
    marked !== null && old?.ok === true && next?.ok === true
      ? {
          kind: "diagram",
          key: id,
          title: title ?? "diagram",
          diagramType: diagramType(next.svg),
          before: {
            label: labels.before,
            svg: marked.before,
            source: before,
            size: { width: old.width, height: old.height },
          },
          after: {
            label: labels.after,
            svg: marked.after,
            source: after,
            size: { width: next.width, height: next.height },
          },
        }
      : null;
  const viewer = useContext(CompareViewerContext);
  const latest = useRef(pair);
  useLayoutEffect(() => {
    latest.current = pair;
  });
  const [key] = useState(() => Symbol("comparison"));
  useEffect(
    () =>
      viewer?.register(key, {
        anchor: () => probe.current,
        pair: () => latest.current,
      }),
    [viewer, key],
  );
  // Outside a page that provides one, a comparison views alone.
  const [own, setOwn] = useState<ViewerState | null>(null);
  const open = () => {
    if (viewer !== null) viewer.open(key);
    else if (pair !== null) setOwn({ compare: [pair], index: 0 });
  };

  const sourceDiff = (
    <CodeDiffBlock
      filename={filename}
      before={before}
      after={after}
      bareFallback
    />
  );
  const pending = old === null || next === null;
  const neither = old?.ok === false && next?.ok === false;
  const side = (
    label: string,
    result: DiagramResult | null,
    source: string,
    svg: string | undefined,
  ): CompareSide =>
    result?.ok === true
      ? {
          label,
          size: { width: result.width, height: result.height },
          content: (
            <span
              className="mermaid-compare-diagram"
              // See MermaidBlock: mermaid's own output under securityLevel
              // "strict"; the colours added to it are styles and rects we set.
              // biome-ignore lint/security/noDangerouslySetInnerHtml: sanitized by mermaid, see above
              dangerouslySetInnerHTML={{ __html: svg ?? result.svg }}
            />
          ),
        }
      : {
          label,
          size: null,
          failed: true,
          content: (
            <div className="grid gap-1.5 p-3">
              <p
                className="truncate text-destructive text-xs"
                title={result?.ok === false ? result.error : undefined}
              >
                {result?.ok === false ? errorSummary(result.error) : null}
              </p>
              <CodeBlock filename={filename} contents={source} bareFallback />
            </div>
          ),
        };

  return (
    <div ref={probe}>
      <MediaCompare
        before={side(labels.before, old, before, marked?.before)}
        after={side(labels.after, next, after, marked?.after)}
        modes={["2up"]}
        onOpen={pair === null ? undefined : open}
        align="center"
        backdrop="page"
        text={after}
        title={title}
        actions={
          !pending &&
          !neither && (
            <>
              <SourceToggle
                shown={showSource}
                onToggle={() => setShowSource((shown) => !shown)}
              />
              {pair !== null && <OpenInViewer onOpen={open} />}
            </>
          )
        }
        replacement={
          pending || showSource ? (
            sourceDiff
          ) : neither ? (
            <>
              {sourceDiff}
              {next?.ok === false && <ErrorLine error={next.error} />}
            </>
          ) : undefined
        }
      />
      {viewer === null && (
        <AttachmentViewerDialog
          state={own}
          onNavigate={() => {}}
          onClose={() => setOwn(null)}
        />
      )}
    </div>
  );
}

/** `sequence`, `flowchart` …: the SVG's role description, less mermaid's renderer version. */
function diagramType(svg: string): string {
  const role = /aria-roledescription="([^"]*)"/.exec(svg)?.[1] ?? "diagram";
  return role.replace(/-v\d+$/, "");
}

function OpenInViewer({ onOpen }: { onOpen: () => void }) {
  return (
    <Button
      type="button"
      size="icon-xs"
      variant="ghost"
      aria-label="Open in the viewer"
      title="Open in the viewer"
      className="text-muted-foreground"
      onClick={onOpen}
    >
      <Maximize2Icon className="size-3.5" />
    </Button>
  );
}

/**
 * Renders `source` with the page's palette and font, again on every theme
 * switch; null until the first render is back.
 */
function useDiagram(
  probe: RefObject<HTMLElement | null>,
  source: string,
): DiagramResult | null {
  // The palette is baked into the SVG at render time, so a theme switch has
  // to re-render. The store rewrites its <style> and the root's attributes
  // before it notifies, so the computed style read below is already the new
  // theme's by the time this key changes. As shown, not as picked: under
  // "system" an OS switch changes the scheme and leaves the pick alone.
  const { theme: shown, colorScheme, variant } = useTheme();
  const theme = `${shown.id} ${colorScheme} ${variant}`;
  const [result, setResult] = useState<DiagramResult | null>(null);

  useEffect(() => {
    // Read only as a trigger: the colors come off the computed style below.
    void theme;
    const el = probe.current;
    if (el === null) return;
    let live = true;
    renderDiagram(
      source,
      readPalette(el),
      getComputedStyle(el).fontFamily,
    ).then((next) => {
      if (live) setResult(next);
    });
    return () => {
      live = false;
    };
  }, [probe, source, theme]);

  return result;
}

function SourceToggle({
  shown,
  onToggle,
}: {
  shown: boolean;
  onToggle: () => void;
}) {
  return (
    <Button
      type="button"
      size="xs"
      variant="ghost"
      className="font-normal text-muted-foreground"
      aria-pressed={shown}
      onClick={onToggle}
    >
      {shown ? "Diagram" : "Source"}
    </Button>
  );
}

function ErrorLine({ error }: { error: string }) {
  return (
    <p
      className="truncate border-t px-3 py-1 text-destructive text-xs"
      title={error}
    >
      {errorSummary(error)}
    </p>
  );
}
