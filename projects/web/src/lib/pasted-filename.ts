/**
 * Pasted screenshots arrive from every browser as `image.png` (T-269), so a
 * card that collects a few of them ends up with a column of identical names.
 *
 * They are named here, at paste time, rather than on the server: the name has
 * to be settled before the upload so the staging tray, the request and the
 * markdown that lands in the body all say the same thing. That is also why
 * the id cannot be part of it — there is no id yet — and why a random short
 * string stands in for one.
 */

export const CLIPBOARD_DEFAULT =
  /^image\.(png|jpe?g|gif|webp|bmp|tiff?|avif)$/i;

const pad = (n: number, width: number) => String(n).padStart(width, "0");

/**
 * `image-20260905-214530-a3f9.png`, in the pasting browser's own timezone:
 * these digits are read by the person who pasted, off a tray sitting right
 * in front of them. (The 0013 migration spells its names in UTC instead —
 * the server has no timezone to offer, and those names carry an id anyway.)
 *
 * Time and randomness come in as arguments so the function stays pure.
 */
export function pastedFilename(at: Date, ext: string, rand: string): string {
  const stamp =
    `${at.getFullYear()}${pad(at.getMonth() + 1, 2)}${pad(at.getDate(), 2)}` +
    `-${pad(at.getHours(), 2)}${pad(at.getMinutes(), 2)}${pad(at.getSeconds(), 2)}`;
  return `image-${stamp}-${rand}${ext}`;
}

/**
 * Four hex digits: enough that two pastes in the same second rarely agree,
 * and if they do the server's own uniqueness rule catches it.
 */
function rand4(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(2));
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Rename only the browser's own default. A real file copied out of a file
 * manager and pasted keeps its name — the clipboard is not on its own
 * evidence that the name is meaningless.
 */
export function renameIfClipboardDefault(file: File): File {
  if (!CLIPBOARD_DEFAULT.test(file.name)) return file;
  const ext = file.name.slice(file.name.lastIndexOf("."));
  return new File([file], pastedFilename(new Date(), ext, rand4()), {
    type: file.type,
  });
}
