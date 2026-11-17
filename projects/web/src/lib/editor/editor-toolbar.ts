import { EditorView } from "@codemirror/view";

/**
 * The look and the keyboard every after-the-fact toolbar under the caret
 * shares: the paste options (`paste-as.ts`) and the image-pair offer
 * (`image-pairs.ts`). Each toolbar's own class sits beside this one.
 */
export const TOOLBAR_CLASS = "cm-editor-toolbar";

export const toolbarTheme = EditorView.theme({
  // Dressed like the completion panel (completionTheme) — the two are the
  // editor's only popups.
  [`.cm-tooltip.${TOOLBAR_CLASS}`]: {
    border: "1px solid var(--border)",
    borderRadius: "0.5rem",
    backgroundColor: "var(--popover)",
    color: "var(--popover-foreground)",
    boxShadow:
      "0 4px 6px -1px color-mix(in oklab, var(--foreground) 12%, transparent)",
    fontFamily: "var(--font-sans)",
    display: "flex",
    alignItems: "center",
    gap: "0.25rem",
    padding: "0.125rem",
    fontSize: "0.75rem",
  },
  [`.${TOOLBAR_CLASS} button`]: {
    padding: "0.125rem 0.5rem",
    borderRadius: "0.375rem",
    color: "var(--muted-foreground)",
    cursor: "pointer",
  },
  [`.${TOOLBAR_CLASS} button:hover`]: {
    backgroundColor: "var(--accent)",
    color: "var(--accent-foreground)",
  },
  [`.${TOOLBAR_CLASS} button[aria-pressed='true']`]: {
    backgroundColor: "var(--accent)",
    color: "var(--accent-foreground)",
    fontWeight: "500",
  },
  [`.${TOOLBAR_CLASS} button:focus-visible`]: {
    outline: "2px solid var(--ring)",
    outlineOffset: "-2px",
  },
});

/** A toolbar element, `role="toolbar"`, wearing the shared class and its own. */
export function createToolbarDom(className: string, label: string) {
  const dom = document.createElement("div");
  dom.className = `${TOOLBAR_CLASS} ${className}`;
  dom.setAttribute("role", "toolbar");
  dom.setAttribute("aria-label", label);
  return dom;
}

/** A toolbar button, out of the tab order until the toolbar picks one. */
export function toolbarButton(label: string) {
  const element = document.createElement("button");
  element.type = "button";
  element.textContent = label;
  element.tabIndex = -1;
  return element;
}

/**
 * Mouse and keyboard for a toolbar: the editor keeps focus (and its caret)
 * while the mouse is used; ←/→ move between the visible buttons; Escape and
 * Mod-. go back to the text; focus leaving for anywhere but the toolbar or
 * the text dismisses it.
 */
export function wireToolbar(
  view: EditorView,
  dom: HTMLElement,
  { onReturn, onDismiss }: { onReturn: () => void; onDismiss: () => void },
) {
  dom.addEventListener("mousedown", (event) => event.preventDefault());
  dom.addEventListener("keydown", (event) => {
    const visible = [
      ...dom.querySelectorAll<HTMLButtonElement>("button"),
    ].filter((b) => !b.hidden);
    const index = visible.indexOf(document.activeElement as HTMLButtonElement);
    const mod = event.metaKey || event.ctrlKey;
    if (event.key === "Escape" || (mod && event.key === ".")) {
      event.preventDefault();
      onReturn();
    } else if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
      event.preventDefault();
      const step = event.key === "ArrowRight" ? 1 : -1;
      visible[(index + step + visible.length) % visible.length]?.focus();
    }
  });
  dom.addEventListener("focusout", (event) => {
    const next = event.relatedTarget as Node | null;
    if (next !== null && (dom.contains(next) || view.contentDOM.contains(next)))
      return;
    onDismiss();
  });
}
