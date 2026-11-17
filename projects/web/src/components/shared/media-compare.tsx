import { ChevronsLeftRightIcon } from "lucide-react";
import {
  type CSSProperties,
  createContext,
  type ReactNode,
  useState,
} from "react";
import { FenceFrame } from "@/components/shared/fence-frame.tsx";
import {
  type CompareMode,
  setCompareMode,
  useCompareMode,
} from "@/lib/compare-mode.ts";
import { SEGMENT, SEGMENT_OFF, SEGMENT_ON } from "@/lib/segment-styles.ts";
import { cn } from "@/lib/utils.ts";

type Size = { width: number; height: number };

export type CompareSide = {
  /** The side's tag, such as "v2". */
  label: string;
  /** An `<img>`, or a block holding an SVG; the component sets its width. */
  content: ReactNode;
  /** Natural size in px; null while loading, or when it failed to. */
  size: Size | null;
  /** This side cannot be drawn: a deleted attachment, an image that 404s. */
  failed?: boolean;
};

/** The side tags a comparison falls back to where no version names them. */
export const DEFAULT_COMPARE_LABELS = { before: "Before", after: "After" };

export const CompareLabelsContext = createContext(DEFAULT_COMPARE_LABELS);

const MODES: Array<{ value: CompareMode; long: string; short: string }> = [
  { value: "2up", long: "Side by side", short: "2-up" },
  { value: "swipe", long: "Swipe", short: "Swipe" },
  { value: "onion", long: "Onion skin", short: "Onion" },
  { value: "diff", long: "Difference", short: "Diff" },
];

/**
 * Two versions of a picture, compared side by side, by swipe, by onion skin or
 * by difference (T-722). It knows nothing of what the two are: an image and a
 * rendered diagram both come in as `content` with a natural size.
 *
 * Every mode draws both sides at one scale — the wider fills the space, and
 * neither is enlarged past its own size — so a picture that grew still looks
 * bigger, and in the overlay modes a pixel sits on the pixel it replaced.
 */
export function MediaCompare({
  before,
  after,
  align,
  backdrop,
  text,
  actions,
  replacement,
  className,
}: {
  before: CompareSide;
  after: CompareSide;
  /** Where two sizes line up in the overlay modes: a screenshot's corner, a diagram's top centre. */
  align: "start" | "center";
  /** What shows through transparency: the viewer's checkerboard, or the page. */
  backdrop: "checker" | "page";
  /** Handed to the frame's Copy; leave it out for no Copy. */
  text?: string;
  /** More controls at the head's right edge. */
  actions?: ReactNode;
  /** Drawn in place of the comparison, with no mode pressed. */
  replacement?: ReactNode;
  className?: string;
}) {
  const stored = useCompareMode();
  const overlayable =
    before.size !== null &&
    after.size !== null &&
    !before.failed &&
    !after.failed;
  // Falling back leaves the store alone: a block that cannot overlay must not
  // switch every other block on the page back with it.
  const mode = overlayable ? stored : "2up";
  const pressed = replacement === undefined ? mode : null;

  return (
    <div
      className={cn("media-compare select-none", className)}
      data-backdrop={backdrop}
    >
      <FenceFrame
        text={text}
        leading={<CompareModes pressed={pressed} overlayable={overlayable} />}
        actions={actions}
      >
        {replacement ??
          (mode === "2up" || before.size === null || after.size === null ? (
            <SideBySide before={before} after={after} align={align} />
          ) : (
            <Overlay
              mode={mode}
              before={{ ...before, size: before.size }}
              after={{ ...after, size: after.size }}
              align={align}
            />
          ))}
      </FenceFrame>
    </div>
  );
}

/**
 * The four modes as one segmented control, writing the page's shared mode.
 * The overlay three are off until both sides have a size to line up.
 */
export function CompareModes({
  pressed,
  overlayable,
}: {
  pressed: CompareMode | null;
  overlayable: boolean;
}) {
  return (
    <fieldset
      aria-label="Comparison"
      className="media-compare-modes inline-flex h-7 shrink-0 items-center rounded-full border p-0.5"
    >
      {MODES.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-label={option.long}
          title={option.long}
          aria-pressed={pressed === option.value}
          disabled={option.value !== "2up" && !overlayable}
          onClick={() => setCompareMode(option.value)}
          className={cn(
            SEGMENT,
            "cursor-pointer whitespace-nowrap disabled:cursor-default disabled:opacity-50 disabled:hover:text-muted-foreground",
            pressed === option.value ? SEGMENT_ON : SEGMENT_OFF,
          )}
        >
          <span className="media-compare-long">{option.long}</span>
          <span className="media-compare-short" aria-hidden>
            {option.short}
          </span>
        </button>
      ))}
    </fieldset>
  );
}

function SideBySide({
  before,
  after,
  align,
}: {
  before: CompareSide;
  after: CompareSide;
  align: "start" | "center";
}) {
  const widest =
    before.size === null || after.size === null
      ? null
      : Math.max(before.size.width, after.size.width);
  const pane = (side: CompareSide, which: "before" | "after") => (
    <div className="media-compare-pane" data-side={which}>
      <CompareLabel
        which={which}
        side={side}
        other={which === "before" ? after : before}
      />
      <div
        className="media-compare-box"
        data-sized={side.size === null ? undefined : ""}
        style={
          // Unsized until both are known: a box guessed at now would jump
          // when the other side's size arrives.
          widest === null || side.size === null
            ? undefined
            : {
                width: `${(side.size.width / widest) * 100}%`,
                maxWidth: `${side.size.width}px`,
                marginInline: align === "center" ? "auto" : undefined,
              }
        }
      >
        {side.content}
      </div>
    </div>
  );
  return (
    <div className="media-compare-stage">
      <div className="media-compare-2up">
        {pane(before, "before")}
        {pane(after, "after")}
      </div>
    </div>
  );
}

type SizedSide = CompareSide & { size: Size };

function Overlay({
  mode,
  before,
  after,
  align,
}: {
  mode: Exclude<CompareMode, "2up">;
  before: SizedSide;
  after: SizedSide;
  align: "start" | "center";
}) {
  const [cut, setCut] = useState(50);
  const [fade, setFade] = useState(50);
  const width = Math.max(before.size.width, after.size.width);
  const height = Math.max(before.size.height, after.size.height);
  const place = (side: SizedSide): CSSProperties => ({
    width: `${(side.size.width / width) * 100}%`,
    left:
      align === "center"
        ? `${((width - side.size.width) / 2 / width) * 100}%`
        : 0,
  });
  const stageWidth = `min(100%, ${width}px)`;
  const labels = (
    <>
      <CompareLabel which="before" side={before} other={after} />
      <CompareLabel which="after" side={after} other={before} />
    </>
  );

  return (
    <div className="media-compare-stage">
      <div
        className="media-compare-overlay"
        data-mode={mode}
        style={
          {
            width: stageWidth,
            aspectRatio: `${width} / ${height}`,
            "--cut": `${cut}%`,
          } as CSSProperties
        }
      >
        <div className="media-compare-layer" data-side="before">
          <div className="media-compare-box" style={place(before)}>
            {before.content}
          </div>
        </div>
        <div
          className="media-compare-layer"
          data-side="after"
          style={mode === "onion" ? { opacity: fade / 100 } : undefined}
        >
          <div className="media-compare-box" style={place(after)}>
            {after.content}
          </div>
        </div>
        {mode === "swipe" && (
          <>
            <div className="media-compare-handle" aria-hidden>
              <span className="media-compare-grip">
                <ChevronsLeftRightIcon className="size-4" />
              </span>
            </div>
            <input
              type="range"
              min={0}
              max={100}
              step="any"
              value={cut}
              aria-label={`Swipe between ${before.label} (left) and ${after.label} (right)`}
              onChange={(e) => setCut(Number(e.currentTarget.value))}
              className="media-compare-swipe"
            />
          </>
        )}
      </div>
      <div
        className="media-compare-foot"
        data-mode={mode}
        style={{ maxWidth: stageWidth }}
      >
        {mode === "onion" ? (
          <>
            <CompareLabel which="before" side={before} other={after} />
            <input
              type="range"
              min={0}
              max={100}
              value={fade}
              aria-label={`Opacity of ${after.label}`}
              onChange={(e) => setFade(Number(e.currentTarget.value))}
              className="media-compare-fade"
            />
            <CompareLabel which="after" side={after} other={before} />
          </>
        ) : mode === "diff" ? (
          <>
            <CompareLabel which="before" side={before} other={after} />
            <span className="media-compare-message">
              Unchanged pixels are black.
            </span>
            <CompareLabel which="after" side={after} other={before} />
          </>
        ) : (
          labels
        )}
      </div>
    </div>
  );
}

/**
 * A side's colour, its version and its natural size. The size earns the room
 * because scaling hides it: two screenshots drawn at one width look the same
 * size whatever their pixels say. A dimension the two disagree on is marked.
 */
export function CompareLabel({
  which,
  side,
  other,
}: {
  which: "before" | "after";
  side: CompareSide;
  other: CompareSide;
}) {
  const dimension = (key: keyof Size) => {
    const value = side.size?.[key];
    const differs =
      other.size !== null && value !== undefined && value !== other.size[key];
    return differs ? <mark data-changed="">{value}</mark> : value;
  };
  return (
    <span className="media-compare-label" data-side={which}>
      <span className="media-compare-tick" />
      <span className="font-semibold">{side.label}</span>
      {side.size !== null && (
        <span className="media-compare-dims">
          {dimension("width")}×{dimension("height")}
        </span>
      )}
    </span>
  );
}
