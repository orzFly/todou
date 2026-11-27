import { type ChangeEvent, type CompositionEvent, useRef } from "react";

/**
 * Normalizes a controlled input per keystroke, except while an IME composes:
 * a rewritten value is written back into the DOM, which ends the composition
 * and duplicates or scrambles the letters.
 */
export function useComposedInput(
  value: string,
  setValue: (next: string) => void,
  normalize: (raw: string) => string,
) {
  const composing = useRef(false);
  return {
    value,
    onChange: (e: ChangeEvent<HTMLInputElement>) => {
      const raw = e.target.value;
      const inComposition =
        composing.current || (e.nativeEvent as InputEvent).isComposing === true;
      setValue(inComposition ? raw : normalize(raw));
    },
    onCompositionStart: () => {
      composing.current = true;
    },
    // Chrome sends the committing input event before compositionend and
    // nothing after it, so the committed text is normalized here.
    onCompositionEnd: (e: CompositionEvent<HTMLInputElement>) => {
      composing.current = false;
      setValue(normalize(e.currentTarget.value));
    },
  };
}
