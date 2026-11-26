/** Tailwind's `lg`, `md` and `sm`. The one place these breakpoints are written outside CSS. */
export const LG_UP = "(min-width: 1024px)";
export const MD_UP = "(min-width: 768px)";
export const SM_UP = "(min-width: 640px)";

/**
 * Where the centred column leaves a gutter wide enough to hang a control in
 * (T-461). `<main>` is `max-w-6xl`, so from 1152px up the column stops growing
 * and every pixel of viewport past it becomes margin: 24px each side at
 * 1200px, 144px at 1440px, 384px at 1920px. A container query cannot ask this
 * — the column, and therefore every box inside it, measures the same at all
 * three — which is why the question is a viewport one however much the rest
 * of a component's responsiveness is not.
 */
export const XL_UP = "(min-width: 1440px)";
