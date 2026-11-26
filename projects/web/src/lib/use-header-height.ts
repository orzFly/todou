import { useElementHeight } from "@orz/ui/hooks/use-element-height";
import { useShellHeader } from "@/lib/shell-header.ts";

/** The shell header's desktop height, until the measurement lands. */
const FALLBACK_HEADER_HEIGHT = 56;

/**
 * How far a layer pinned beneath the header tucks up under its bottom border.
 * Firefox at a fractional zoom (175%) can snap the header and the layer under
 * it to different device-pixel rows, leaving one row of page showing between
 * them; headless Firefox and Chromium never do, so no automated check here
 * sees it (T-480, T-595). The header paints above every such layer, so the
 * overlap is hidden behind the border.
 */
const BORDER_OVERLAP = 1;

/**
 * The live height of the shell header, less `BORDER_OVERLAP`, for anything
 * that has to sit directly beneath it. The header carries a second row of nav
 * below sm, so its height is a runtime value no CSS offset can name — measure
 * it, as the issue list's group headers do.
 */
export function useHeaderHeight(): number {
  const header = useShellHeader();
  return (
    useElementHeight(() => header.current, FALLBACK_HEADER_HEIGHT) -
    BORDER_OVERLAP
  );
}

/**
 * Where `header` ends in the viewport right now, which is less than its
 * height while it is sliding away. For insets read at the moment they are
 * used, rather than rendered.
 */
export function headerBottom(header: HTMLElement | null): number {
  return header === null
    ? 0
    : Math.max(0, header.getBoundingClientRect().bottom);
}
