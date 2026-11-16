import { toast } from "sonner";

/**
 * Copy, saying so only on failure — for a control that shows its own
 * success where the reader is already looking. Every failure here is the
 * same one: no clipboard to write to.
 */
export async function writeClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    toast.error("Clipboard is unavailable in this browser");
    return false;
  }
}

/**
 * Copy and say so. The success message names what was copied — the caller
 * knows that; the failure one does not.
 */
export async function copyToClipboard(text: string, ok: string): Promise<void> {
  if (await writeClipboard(text)) toast.success(ok);
}
