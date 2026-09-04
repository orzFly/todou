/**
 * Scales an oversized avatar down in the browser so the upload fits the
 * server's cap. Pure module (no React, no direct DOM at import time) and the
 * browser primitives go through an injectable codec: happy-dom's `toBlob`
 * always yields a 0-byte Blob and its `createImageBitmap` never decodes, so
 * tests can only reach the ladder logic through a stand-in.
 */

import { AVATAR_MAX_BYTES, isAvatarContentType } from "@todou/shared";

export type DecodedImage = {
  readonly width: number;
  readonly height: number;
  readonly source: CanvasImageSource;
  close(): void;
};

export type AvatarCodec = {
  decode(file: File): Promise<DecodedImage>;
  encode(
    image: DecodedImage,
    width: number,
    height: number,
    type: string,
    quality: number,
  ): Promise<Blob | null>;
};

/**
 * `unchanged` and `resized` are kept apart because only a re-encode can lose
 * a GIF's animation, and the two failures need different wording: one means
 * we could not read the file, the other that we read it and still could not
 * get it under the cap.
 */
export type FitResult =
  | { kind: "unchanged"; file: File }
  | { kind: "resized"; file: File }
  | { kind: "undecodable" }
  | { kind: "too-large" };

/**
 * Quality drops before size does: a 512 px image at low quality still looks
 * sharper at the 64 px we render than a crisp 256 px one. Five rungs caps the
 * work a pathological input can put on the main thread.
 */
export const AVATAR_RESIZE_LADDER = [
  { box: 512, quality: 0.85 },
  { box: 512, quality: 0.7 },
  { box: 512, quality: 0.55 },
  { box: 384, quality: 0.7 },
  { box: 256, quality: 0.7 },
] as const;

/** Aspect-fit into a square box: never upscales, never crops. */
export function fitWithin(
  width: number,
  height: number,
  box: number,
): { width: number; height: number } {
  const scale = Math.min(box / width, box / height, 1);
  return {
    // A zero-pixel canvas throws, so a degenerate ratio still rounds up to 1.
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

const EXTENSIONS: Record<string, string | undefined> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
};

export const browserAvatarCodec: AvatarCodec = {
  async decode(file) {
    const bitmap = await createImageBitmap(file, {
      // Phones store the rotation in EXIF rather than in the pixels; without
      // this a portrait photo comes back on its side once re-encoded.
      imageOrientation: "from-image",
    });
    return {
      width: bitmap.width,
      height: bitmap.height,
      source: bitmap,
      close: () => bitmap.close(),
    };
  },
  encode(image, width, height, type, quality) {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) return Promise.resolve(null);
    context.drawImage(image.source, 0, 0, width, height);
    return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
  },
};

/**
 * Files already within the cap are handed back untouched — same `File`
 * object, no re-encode — so transparency, animation and lossless PNGs
 * survive. This is the only place the cap is compared against, so callers
 * must not pre-filter by size.
 */
export async function fitAvatar(
  file: File,
  codec: AvatarCodec = browserAvatarCodec,
): Promise<FitResult> {
  if (file.size <= AVATAR_MAX_BYTES) return { kind: "unchanged", file };

  let image: DecodedImage;
  try {
    image = await codec.decode(file);
  } catch {
    return { kind: "undecodable" };
  }

  try {
    if (image.width < 1 || image.height < 1) return { kind: "undecodable" };

    let type = "image/webp";
    for (const rung of AVATAR_RESIZE_LADDER) {
      const { width, height } = fitWithin(image.width, image.height, rung.box);
      let blob = await codec.encode(image, width, height, type, rung.quality);
      if (blob && !isAvatarContentType(blob.type)) {
        // `toBlob` silently substitutes its own format for a type the browser
        // cannot encode. Whatever came back is not uploadable, so fall to JPEG
        // and stay there rather than re-probing WebP on every rung.
        type = "image/jpeg";
        blob = await codec.encode(image, width, height, type, rung.quality);
      }
      if (!blob || !isAvatarContentType(blob.type)) continue;
      if (blob.size <= AVATAR_MAX_BYTES) {
        const name = `avatar.${EXTENSIONS[blob.type] ?? "img"}`;
        return {
          kind: "resized",
          file: new File([blob], name, { type: blob.type }),
        };
      }
    }
    return { kind: "too-large" };
  } finally {
    // An ImageBitmap holds its pixels until closed, on every path out.
    image.close();
  }
}
