import { useSyncExternalStore } from "react";

/**
 * Whether markdown boxes are a plain <textarea> instead of CodeMirror
 * (T-709): the way out for a phone whose keyboard fights the
 * contenteditable. Per browser, not per account — the same person's desktop
 * keeps the full editor.
 */
export const PLAIN_TEXT_EDITOR_STORAGE_KEY = "todou:plain-text-editor:v1";

function read(): boolean {
  try {
    return localStorage.getItem(PLAIN_TEXT_EDITOR_STORAGE_KEY) === "on";
  } catch {
    // Storage may be unavailable (private mode); the full editor still works.
    return false;
  }
}

let current: boolean | null = null;
const listeners = new Set<() => void>();

export function plainTextEditor(): boolean {
  current ??= read();
  return current;
}

export function setPlainTextEditor(on: boolean) {
  current = on;
  try {
    if (on) localStorage.setItem(PLAIN_TEXT_EDITOR_STORAGE_KEY, "on");
    else localStorage.removeItem(PLAIN_TEXT_EDITOR_STORAGE_KEY);
  } catch {
    // Unsaved, but this page still switches.
  }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  const onStorage = (e: StorageEvent) => {
    if (e.key !== PLAIN_TEXT_EDITOR_STORAGE_KEY && e.key !== null) return;
    current = read();
    listener();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

export function usePlainTextEditor(): boolean {
  return useSyncExternalStore(subscribe, plainTextEditor, () => false);
}
