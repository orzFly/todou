import {
  type CSSProperties,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { CodeBlock } from "@/components/shared/pierre.tsx";
import { Button } from "@/components/ui/button.tsx";
import {
  type DiagramPalette,
  type DiagramResult,
  errorSummary,
  renderDiagram,
} from "@/lib/mermaid.ts";

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
}: {
  filename: string;
  source: string;
}) {
  const theme = useSyncExternalStore(subscribeTheme, themeSnapshot);
  const probe = useRef<HTMLDivElement>(null);
  const [result, setResult] = useState<DiagramResult | null>(null);
  const [showSource, setShowSource] = useState(false);

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
  }, [source, theme]);

  const diagram = result?.ok === true ? result : null;
  return (
    // The toggle sits in a strip of its own: over the diagram it would cover
    // whichever node lands in the corner.
    <div ref={probe} className={diagram === null ? undefined : "relative pt-7"}>
      {diagram !== null && !showSource ? (
        <div
          className="mermaid-diagram overflow-x-auto"
          style={{ "--diagram-width": `${diagram.width}px` } as CSSProperties}
          // mermaid's own output under securityLevel "strict", which runs
          // labels through DOMPurify: markup survives, scripts and handlers
          // do not.
          // biome-ignore lint/security/noDangerouslySetInnerHtml: sanitized by mermaid, see above
          dangerouslySetInnerHTML={{ __html: diagram.svg }}
        />
      ) : (
        <CodeBlock filename={filename} contents={source} />
      )}
      {result?.ok === false && (
        <p
          className="mt-1 truncate text-destructive text-xs"
          title={result.error}
        >
          {errorSummary(result.error)}
        </p>
      )}
      {diagram !== null && (
        <Button
          type="button"
          size="xs"
          variant="ghost"
          className="absolute top-0 right-0"
          aria-pressed={showSource}
          onClick={() => setShowSource((shown) => !shown)}
        >
          {showSource ? "Diagram" : "Source"}
        </Button>
      )}
    </div>
  );
}
