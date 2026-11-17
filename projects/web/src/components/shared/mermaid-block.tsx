import {
  type CSSProperties,
  type RefObject,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
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
import { markChangedLabels } from "@/lib/mermaid-label-diff.ts";

// The palette is baked into the SVG at render time, so a theme switch has to
// re-render. `data-theme` on <html> is the resolved theme — the preference
// store alone would miss an OS switch while the preference is "system".
function subscribeTheme(onChange: () => void): () => void {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-theme", "class"],
  });
  return () => observer.disconnect();
}

function themeSnapshot(): string {
  const root = document.documentElement;
  return `${root.dataset.theme ?? ""} ${root.classList.contains("dark")}`;
}

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

  const diagram = result?.ok === true ? result : null;
  const drawn = diagram !== null && !showSource;
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
            <SourceToggle
              shown={showSource}
              onToggle={() => setShowSource((shown) => !shown)}
            />
          )
        }
      >
        {drawn ? (
          <div
            className="mermaid-diagram overflow-x-auto p-4"
            style={{ "--diagram-width": `${diagram.width}px` } as CSSProperties}
            // mermaid's own output under securityLevel "strict", which runs
            // labels through DOMPurify: markup survives, scripts and handlers
            // do not.
            // biome-ignore lint/security/noDangerouslySetInnerHtml: sanitized by mermaid, see above
            dangerouslySetInnerHTML={{ __html: diagram.svg }}
          />
        ) : (
          <CodeBlock filename={filename} contents={source} bareFallback />
        )}
        {result?.ok === false && <ErrorLine error={result.error} />}
      </FenceFrame>
    </div>
  );
}

/**
 * A changed ```mermaid fence in a compare view (T-724): both versions drawn
 * side by side, the labels that have no partner on the other side boxed in
 * red and green. Until both renders are back, and when neither parses, it is
 * the source diff the fence would otherwise be.
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

  // Measured during render on purpose: the marks have to arrive with the
  // diagrams, and an effect would paint one frame of them unmarked first.
  const marked = useMemo(
    () =>
      old?.ok === true && next?.ok === true
        ? markChangedLabels(old.svg, next.svg)
        : null,
    [old, next],
  );

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
            <div
              className="mermaid-compare-diagram"
              // See MermaidBlock: mermaid's own output under securityLevel
              // "strict"; the marks added to it are rects we build.
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
        minScale={0.75}
        align="center"
        backdrop="page"
        text={after}
        title={title}
        actions={
          !pending &&
          !neither && (
            <SourceToggle
              shown={showSource}
              onToggle={() => setShowSource((shown) => !shown)}
            />
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
    </div>
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
  const theme = useSyncExternalStore(subscribeTheme, themeSnapshot);
  const [result, setResult] = useState<DiagramResult | null>(null);

  useEffect(() => {
    // Read only as a trigger: the colors come off the computed style below,
    // which has already changed by the time the snapshot does.
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
