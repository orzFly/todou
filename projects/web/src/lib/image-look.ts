import { useSyncExternalStore } from "react";

/**
 * How the attachment viewer paints an image (T-537): what shows through its
 * transparent pixels, and whether a zoomed-in pixel stays a square. Kept per
 * browser in localStorage — the choice made on T-537 — and shared by every
 * viewer on the page, so paging and reopening keep it.
 */
export type ImageLook = {
  background: "black" | "checker";
  smoothing: "smooth" | "pixelated";
};

export const IMAGE_LOOK_STORAGE_KEY = "todou:image-look:v1";

// Checkerboard under the image only: an opaque image then looks exactly as it
// did before T-537, and a transparent one shows where it ends.
export const DEFAULT_IMAGE_LOOK: ImageLook = {
  background: "checker",
  smoothing: "smooth",
};

/** Parse a stored payload; an unknown or missing field falls back to its default. */
export function parseImageLook(raw: string | null): ImageLook {
  let parsed: unknown;
  try {
    parsed = raw === null ? null : JSON.parse(raw);
  } catch {
    parsed = null;
  }
  const stored =
    typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : {};
  return {
    background:
      stored.background === "black" || stored.background === "checker"
        ? stored.background
        : DEFAULT_IMAGE_LOOK.background,
    smoothing:
      stored.smoothing === "smooth" || stored.smoothing === "pixelated"
        ? stored.smoothing
        : DEFAULT_IMAGE_LOOK.smoothing,
  };
}

function read(): ImageLook {
  try {
    return parseImageLook(localStorage.getItem(IMAGE_LOOK_STORAGE_KEY));
  } catch {
    // Storage may be unavailable (private mode); the defaults still render.
    return DEFAULT_IMAGE_LOOK;
  }
}

let current: ImageLook | null = null;
const listeners = new Set<() => void>();

function snapshot(): ImageLook {
  current ??= read();
  return current;
}

export function setImageLook(patch: Partial<ImageLook>) {
  current = { ...snapshot(), ...patch };
  try {
    localStorage.setItem(IMAGE_LOOK_STORAGE_KEY, JSON.stringify(current));
  } catch {
    // Unsaved, but this page still switches.
  }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  // Another tab's choice applies here too.
  const onStorage = (e: StorageEvent) => {
    if (e.key !== IMAGE_LOOK_STORAGE_KEY) return;
    current = parseImageLook(e.newValue);
    listener();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

export function useImageLook(): ImageLook {
  return useSyncExternalStore(subscribe, snapshot, () => DEFAULT_IMAGE_LOOK);
}
