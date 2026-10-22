import { useCallback, useLayoutEffect, useState } from "react";

/** The slice of the Document Picture-in-Picture API this app uses. */
type DocumentPictureInPicture = {
  requestWindow: (options?: {
    width?: number;
    height?: number;
  }) => Promise<Window>;
};

/**
 * Desktop Chromium 116+ and desktop Firefox 151+ (MDN browser-compat-data,
 * 2026-10); no Safari, no mobile browser, and nowhere outside a secure
 * context. Read at call time so a test can stub it on `window`.
 */
export function documentPip(): DocumentPictureInPicture | null {
  return (
    (window as { documentPictureInPicture?: DocumentPictureInPicture })
      .documentPictureInPicture ?? null
  );
}

const STYLE_NODES = 'style, link[rel="stylesheet"]';

/**
 * The PiP window opens as a blank document: nothing from this one is
 * inherited. Copy the stylesheets, and keep copying — a lazily loaded chunk
 * injects its CSS into this head after the window opened — and mirror the
 * root element's attributes, which is where the theme lives (`.dark`,
 * `data-theme`), so switching theme repaints the window too.
 *
 * Except `style`: it carries this page's scroll-padding, sized to its own
 * header and composer (`useScrollInsets`), and would push every
 * `scrollIntoView` in the window off by that much.
 */
function mirrorDocument(target: Document): () => void {
  for (const node of document.head.querySelectorAll(STYLE_NODES)) {
    target.head.append(node.cloneNode(true));
  }
  const copyRoot = () => {
    const from = document.documentElement;
    const to = target.documentElement;
    for (const name of to.getAttributeNames()) {
      if (!from.hasAttribute(name)) to.removeAttribute(name);
    }
    for (const name of from.getAttributeNames()) {
      if (name !== "style") {
        to.setAttribute(name, from.getAttribute(name) ?? "");
      }
    }
  };
  copyRoot();
  const rootObserver = new MutationObserver(copyRoot);
  rootObserver.observe(document.documentElement, { attributes: true });
  const headObserver = new MutationObserver((records) => {
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (node instanceof Element && node.matches(STYLE_NODES)) {
          target.head.append(node.cloneNode(true));
        }
      }
    }
  });
  headObserver.observe(document.head, { childList: true });
  return () => {
    rootObserver.disconnect();
    headObserver.disconnect();
  };
}

/**
 * One always-on-top window for this component's content (T-530). `open`
 * must run inside the click that asked for it — the browser refuses the
 * window without a user activation. The window closes when the component
 * unmounts, so content answered or navigated away from never leaves an
 * empty window behind; and `window` drops back to null whenever the window
 * goes away for any other reason — the user closing it, `close`, or another
 * component opening its own, since a tab holds one at a time.
 */
export function useDocumentPip(): {
  window: Window | null;
  open: (size: { width: number; height: number }) => Promise<void>;
  close: () => void;
} {
  const [pip, setPip] = useState<Window | null>(null);
  // Layout, not passive: the portal's content is committed into the window
  // in the same pass, and has to be styled before the window first paints.
  useLayoutEffect(() => {
    if (!pip) return;
    const stop = mirrorDocument(pip.document);
    const back = () => setPip(null);
    pip.addEventListener("pagehide", back);
    return () => {
      pip.removeEventListener("pagehide", back);
      stop();
      pip.close();
    };
  }, [pip]);
  const open = useCallback(async (size: { width: number; height: number }) => {
    const api = documentPip();
    if (!api) return;
    setPip(await api.requestWindow(size));
  }, []);
  const close = useCallback(() => setPip(null), []);
  return { window: pip, open, close };
}
