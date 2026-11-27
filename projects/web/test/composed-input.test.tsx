import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { useComposedInput } from "../src/lib/composed-input.ts";

function Field() {
  const [value, setValue] = useState("");
  const input = useComposedInput(value, setValue, (raw) =>
    raw.toUpperCase().trim(),
  );
  return <input aria-label="field" {...input} />;
}

const field = () => {
  render(<Field />);
  return screen.getByLabelText("field") as HTMLInputElement;
};

const type = (el: HTMLInputElement, value: string, isComposing = false) =>
  fireEvent.input(el, { target: { value }, isComposing });

describe("useComposedInput", () => {
  it("normalizes every keystroke when no IME is composing", () => {
    const el = field();
    type(el, "t");
    expect(el.value).toBe("T");
    type(el, "To ");
    expect(el.value).toBe("TO");
  });

  // The order Chrome sends: each update is an input event marked composing,
  // and compositionend comes after the one that commits.
  it("leaves a composition as typed, then normalizes what it commits", () => {
    const el = field();
    fireEvent.compositionStart(el);
    type(el, "t", true);
    expect(el.value).toBe("t");
    type(el, "to ", true);
    expect(el.value).toBe("to ");
    fireEvent.compositionEnd(el);
    expect(el.value).toBe("TO");
  });

  it("holds off between compositionstart and compositionend even when the input event is not marked composing", () => {
    const el = field();
    fireEvent.compositionStart(el);
    type(el, "to");
    expect(el.value).toBe("to");
    fireEvent.compositionEnd(el);
    expect(el.value).toBe("TO");
  });

  it("holds off on an input event marked composing even without a compositionstart", () => {
    const el = field();
    type(el, "to", true);
    expect(el.value).toBe("to");
    type(el, "top");
    expect(el.value).toBe("TOP");
  });

  it("goes back to normalizing every keystroke once the composition ends", () => {
    const el = field();
    fireEvent.compositionStart(el);
    type(el, "a", true);
    fireEvent.compositionEnd(el);
    type(el, "Ab");
    expect(el.value).toBe("AB");
  });
});
