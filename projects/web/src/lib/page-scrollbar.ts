const LOCKED = "data-scroll-locked";
const WIDTH = "--page-scrollbar-width";

/**
 * Keep the shell from sliding sideways when a page starts or stops scrolling
 * (T-821). A classic scrollbar takes its width out of the page, and the
 * centred column and the header's right edge moved with it; reserving the
 * gutter on every page keeps them where a long page has them.
 *
 * The gutter goes on this window's root as an inline style, not in the
 * stylesheet: a Picture-in-Picture window copies every stylesheet and every
 * root attribute except `style` (`mirrorDocument`), and there an empty strip
 * would be all it gained.
 *
 * While a menu or dialog locks scrolling, `styles.css` hands the gutter back
 * and gives the body a right margin of `--page-scrollbar-width` instead, so a
 * fixed scrim covers the whole window. Measured here as what the root's box
 * is short of the window: `innerWidth - clientWidth`, the lock's own measure,
 * reads 0 on a page that does not scroll, because Chromium counts the empty
 * gutter as page. A `ResizeObserver` on the root fires for everything that
 * changes it: first layout, a resize, browser zoom (which rescales the bar in
 * CSS pixels), and the gutter going and coming back around a lock. During a
 * lock the gutter is gone and the difference is 0, so the last value stands
 * until the lock lifts and the root shrinks again.
 */
export function trackPageScrollbarWidth(): () => void {
  const root = document.documentElement;
  root.style.setProperty("scrollbar-gutter", "stable");
  const observer = new ResizeObserver(() => {
    if (document.body?.hasAttribute(LOCKED)) return;
    const width = window.innerWidth - root.getBoundingClientRect().width;
    root.style.setProperty(WIDTH, `${Math.max(0, width)}px`);
  });
  observer.observe(root);
  return () => {
    observer.disconnect();
    root.style.removeProperty("scrollbar-gutter");
    root.style.removeProperty(WIDTH);
  };
}
