import { type ComponentProps, useLayoutEffect, useRef, useState } from "react";
import { REF_TITLE_CAP_EM } from "@/components/shared/rich-chip.ts";
import { canvasMeasurer, pixels } from "@/lib/ref-text-metrics.ts";
import { cutTitle, type TitleCut } from "@/lib/ref-title-cap.ts";

/**
 * A reference chip's title inside a markdown body: inline text, so it breaks
 * across lines with the prose around it (T-541), and with `cap` cut to
 * REF_TITLE_CAP_EM of text.
 *
 * The cut is drawn as a real `…`; what it leaves out stays in the DOM for a
 * screen reader rather than only in the link's `title`. Both sit inside a
 * title the sheet keeps out of every selection, so neither reaches a copy.
 */
export function RefTitle({
  title,
  cap,
  ...props
}: { title: string; cap: boolean } & Omit<ComponentProps<"span">, "title">) {
  const root = useRef<HTMLSpanElement>(null);
  const [cut, setCut] = useState<TitleCut | null>(null);

  useLayoutEffect(() => {
    const element = root.current;
    if (!cap || !element) {
      setCut(null);
      return;
    }
    let disposed = false;
    const measure = () => {
      if (disposed) return;
      const canvas = canvasMeasurer(element);
      // happy-dom has no text geometry: leave the title whole there.
      if (!canvas) return;
      const em = pixels(getComputedStyle(element).fontSize);
      const next = cutTitle(title, canvas, REF_TITLE_CAP_EM * em, canvas("…"));
      setCut((previous) =>
        previous?.head === next?.head && previous?.rest === next?.rest
          ? previous
          : next,
      );
    };
    measure();
    document.fonts?.addEventListener("loadingdone", measure);
    void document.fonts?.ready.then(measure);
    return () => {
      disposed = true;
      document.fonts?.removeEventListener("loadingdone", measure);
    };
  }, [title, cap]);

  return (
    <span ref={root} data-ref-title-cap={cap || undefined} {...props}>
      {cut ? (
        <>
          {cut.head}
          <span data-ref-title-rest className="sr-only">
            {cut.rest}
          </span>
          <span aria-hidden>…</span>
        </>
      ) : (
        title
      )}
    </span>
  );
}
