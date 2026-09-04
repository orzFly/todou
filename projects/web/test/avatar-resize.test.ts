import { AVATAR_MAX_BYTES } from "@todou/shared";
import { describe, expect, it } from "vitest";
import {
  AVATAR_RESIZE_LADDER,
  type AvatarCodec,
  fitAvatar,
  fitWithin,
} from "../src/lib/avatar-resize.ts";

/**
 * happy-dom's `toBlob` always yields a 0-byte Blob and its `createImageBitmap`
 * never decodes, so a real canvas here would make every case pass for the
 * wrong reason. The stand-in below derives a byte count from the request
 * instead, which puts the rung the ladder lands on under arithmetic rather
 * than guesswork.
 */
type EncodeCall = {
  width: number;
  height: number;
  type: string;
  quality: number;
};

function sizedBlob(size: number, type: string): Blob {
  const blob = new Blob([], { type });
  Object.defineProperty(blob, "size", { value: size });
  return blob;
}

function fakeCodec(
  options: {
    width?: number;
    height?: number;
    bytesPerPixel?: number;
    webpUnsupported?: boolean;
    decodeError?: boolean;
  } = {},
) {
  const {
    width = 4000,
    height = 4000,
    bytesPerPixel = 1,
    webpUnsupported = false,
    decodeError = false,
  } = options;
  const stats = { decodes: 0, closes: 0, encodes: [] as EncodeCall[] };
  const codec: AvatarCodec = {
    async decode() {
      stats.decodes++;
      if (decodeError) throw new Error("not an image");
      return {
        width,
        height,
        source: {} as CanvasImageSource,
        close: () => {
          stats.closes++;
        },
      };
    },
    async encode(_image, w, h, type, quality) {
      stats.encodes.push({ width: w, height: h, type, quality });
      const encoded =
        webpUnsupported && type === "image/webp" ? "image/bmp" : type;
      return sizedBlob(Math.round(w * h * quality * bytesPerPixel), encoded);
    },
  };
  return { codec, stats };
}

function fileOfSize(size: number, type = "image/png"): File {
  const file = new File([], "photo.png", { type });
  Object.defineProperty(file, "size", { value: size });
  return file;
}

const oversized = () => fileOfSize(AVATAR_MAX_BYTES + 1);

describe("fitWithin", () => {
  it("fits a landscape image by its width", () => {
    expect(fitWithin(1000, 500, 512)).toEqual({ width: 512, height: 256 });
  });

  it("fits a portrait image by its height", () => {
    expect(fitWithin(500, 1000, 512)).toEqual({ width: 256, height: 512 });
  });

  it("fills the box exactly for a square", () => {
    expect(fitWithin(800, 800, 512)).toEqual({ width: 512, height: 512 });
  });

  it("never upscales an image already inside the box", () => {
    expect(fitWithin(300, 200, 512)).toEqual({ width: 300, height: 200 });
  });

  it("keeps a degenerate aspect ratio at one pixel rather than zero", () => {
    // A zero-height canvas throws, so this is the case that must not round down.
    expect(fitWithin(10000, 3, 512)).toEqual({ width: 512, height: 1 });
  });
});

describe("AVATAR_RESIZE_LADDER", () => {
  it("drops quality before it drops size", () => {
    expect([...AVATAR_RESIZE_LADDER]).toEqual([
      { box: 512, quality: 0.85 },
      { box: 512, quality: 0.7 },
      { box: 512, quality: 0.55 },
      { box: 384, quality: 0.7 },
      { box: 256, quality: 0.7 },
    ]);
  });
});

describe("fitAvatar", () => {
  it("hands back a file within the cap untouched", async () => {
    const { codec, stats } = fakeCodec();
    const file = fileOfSize(AVATAR_MAX_BYTES, "image/gif");

    const result = await fitAvatar(file, codec);

    expect(result.kind).toBe("unchanged");
    if (result.kind !== "unchanged") throw new Error("unreachable");
    // Same object, not a copy: no re-encode means animation and transparency
    // survive, which is the whole point of the untouched path.
    expect(result.file).toBe(file);
    expect(stats.decodes).toBe(0);
    expect(stats.encodes).toEqual([]);
  });

  it("encodes once when the first rung already fits", async () => {
    const { codec, stats } = fakeCodec({ bytesPerPixel: 1 });

    const result = await fitAvatar(oversized(), codec);

    expect(result.kind).toBe("resized");
    if (result.kind !== "resized") throw new Error("unreachable");
    expect(result.file.type).toBe("image/webp");
    expect(result.file.name).toBe("avatar.webp");
    expect(stats.encodes).toHaveLength(1);
    expect(stats.encodes[0]).toEqual({
      width: 512,
      height: 512,
      type: "image/webp",
      quality: 0.85,
    });
    expect(stats.closes).toBe(1);
  });

  it("falls through to the fourth rung when the 512 px ones stay too big", async () => {
    const { codec, stats } = fakeCodec({ bytesPerPixel: 16 });

    const result = await fitAvatar(oversized(), codec);

    expect(result.kind).toBe("resized");
    expect(stats.encodes).toHaveLength(4);
    expect(stats.encodes[3]).toEqual({
      width: 384,
      height: 384,
      type: "image/webp",
      quality: 0.7,
    });
  });

  it("reports too-large when every rung is still over the cap", async () => {
    const { codec, stats } = fakeCodec({ bytesPerPixel: 64 });

    const result = await fitAvatar(oversized(), codec);

    expect(result.kind).toBe("too-large");
    expect(stats.encodes).toHaveLength(AVATAR_RESIZE_LADDER.length);
    // The bitmap must be released on the failure path too.
    expect(stats.closes).toBe(1);
  });

  it("retries as JPEG when the browser hands back a type we cannot upload", async () => {
    const { codec, stats } = fakeCodec({
      bytesPerPixel: 1,
      webpUnsupported: true,
    });

    const result = await fitAvatar(oversized(), codec);

    expect(result.kind).toBe("resized");
    if (result.kind !== "resized") throw new Error("unreachable");
    expect(result.file.type).toBe("image/jpeg");
    expect(result.file.name).toBe("avatar.jpg");
    expect(stats.encodes.map((call) => call.type)).toEqual([
      "image/webp",
      "image/jpeg",
    ]);
  });

  it("probes WebP once, then stays on JPEG for the remaining rungs", async () => {
    const { codec, stats } = fakeCodec({
      bytesPerPixel: 16,
      webpUnsupported: true,
    });

    const result = await fitAvatar(oversized(), codec);

    expect(result.kind).toBe("resized");
    expect(stats.encodes.filter((c) => c.type === "image/webp")).toHaveLength(
      1,
    );
    expect(stats.encodes[0]?.type).toBe("image/webp");
    expect(stats.encodes.slice(1).every((c) => c.type === "image/jpeg")).toBe(
      true,
    );
  });

  it("reports undecodable instead of throwing when decoding fails", async () => {
    const { codec, stats } = fakeCodec({ decodeError: true });

    const result = await fitAvatar(oversized(), codec);

    expect(result.kind).toBe("undecodable");
    expect(stats.encodes).toEqual([]);
    expect(stats.closes).toBe(0);
  });

  it("reports undecodable when the decoder returns no pixels", async () => {
    const { codec, stats } = fakeCodec({ width: 0, height: 0 });

    const result = await fitAvatar(oversized(), codec);

    expect(result.kind).toBe("undecodable");
    expect(stats.encodes).toEqual([]);
    expect(stats.closes).toBe(1);
  });
});
