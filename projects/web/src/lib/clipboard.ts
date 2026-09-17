import { toast } from "sonner";

/**
 * Copy and say so. The success message names what was copied — the caller
 * knows that; the failure one does not, because every failure here is the
 * same one: no clipboard to write to.
 */
export async function copyToClipboard(text: string, ok: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(ok);
  } catch {
    toast.error("Clipboard is unavailable in this browser");
  }
}
