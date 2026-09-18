import type { Window } from "happy-dom";
import { afterEach } from "vitest";

// happy-dom does not apply Tailwind's cascade layers / nested media rules.
// Supply its display utilities as flat CSS so role queries exclude the hidden
// branch. Real-browser checks cover the generated stylesheet and geometry.
const styles = document.createElement("style");
styles.textContent = `
  [role="dialog"] .hidden { display: none; }
  [role="dialog"] .flex { display: flex; }
  @media (min-width: 640px) {
    [role="dialog"] .sm\\:flex { display: flex; }
    [role="dialog"] .sm\\:hidden { display: none; }
  }
`;

export function reviewViewport(width: number) {
  styles.remove();
  (window as unknown as Window).happyDOM.setViewport({ width });
  document.head.append(styles);
}

afterEach(() => {
  styles.remove();
  (window as unknown as Window).happyDOM.setViewport({ width: 1024 });
});
