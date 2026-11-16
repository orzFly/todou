import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { type TarEntry, tarStream } from "../src/lib/tar.ts";

const bytes = (text: string) => new TextEncoder().encode(text);

function entry(name: string, body: Uint8Array, size = body.length): TarEntry {
  return {
    name,
    size,
    mtime: new Date("2026-11-16T00:00:00Z"),
    open: async () =>
      new ReadableStream({
        start(controller) {
          // Two chunks, so a body never arrives as one convenient piece.
          const half = Math.floor(body.length / 2);
          controller.enqueue(body.slice(0, half));
          controller.enqueue(body.slice(half));
          controller.close();
        },
      }),
  };
}

async function collect(stream: ReadableStream<Uint8Array>) {
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

const ascii = (block: Uint8Array, from: number, length: number) =>
  new TextDecoder().decode(block.subarray(from, from + length)).split("\0")[0];

/** Minimal ustar + pax reader — just enough to check what we wrote. */
function readTar(archive: Uint8Array) {
  const out: { name: string; body: string; mtime: number }[] = [];
  let at = 0;
  let pax: Record<string, string> = {};
  while (at < archive.length) {
    const header = archive.subarray(at, at + 512);
    if (header.every((b) => b === 0)) break;
    let sum = 0;
    for (let i = 0; i < 512; i++) {
      sum += i >= 148 && i < 156 ? 0x20 : header[i];
    }
    expect(Number.parseInt(ascii(header, 148, 8), 8)).toBe(sum);
    expect(ascii(header, 257, 6)).toBe("ustar");
    const size = Number.parseInt(ascii(header, 124, 12), 8);
    const body = archive.subarray(at + 512, at + 512 + size);
    const type = ascii(header, 156, 1);
    at += 512 + Math.ceil(size / 512) * 512;
    if (type === "x") {
      pax = {};
      let text = new TextDecoder().decode(body);
      while (text.length > 0) {
        const space = text.indexOf(" ");
        const length = Number(text.slice(0, space));
        // The length counts bytes, not UTF-16 units.
        const record = new TextDecoder().decode(
          new TextEncoder().encode(text).subarray(0, length),
        );
        expect(record.endsWith("\n")).toBe(true);
        const [key, ...value] = record.slice(space + 1, -1).split("=");
        pax[key] = value.join("=");
        text = text.slice(record.length);
      }
      continue;
    }
    out.push({
      name: pax.path ?? ascii(header, 0, 100),
      body: new TextDecoder().decode(body),
      mtime: Number.parseInt(ascii(header, 136, 12), 8),
    });
    pax = {};
  }
  return { entries: out, end: at };
}

describe("tarStream (T-699)", () => {
  it("writes ustar entries a reader gets back byte for byte", async () => {
    const archive = await collect(
      tarStream([
        entry("a.txt", bytes("hello")),
        entry("empty", bytes("")),
        entry("block.bin", new Uint8Array(512).fill(0x61)),
      ]),
    );
    const { entries, end } = readTar(archive);
    expect(entries.map((e) => [e.name, e.body.length])).toEqual([
      ["a.txt", 5],
      ["empty", 0],
      ["block.bin", 512],
    ]);
    expect(entries[0].body).toBe("hello");
    expect(entries[0].mtime).toBe(Date.parse("2026-11-16T00:00:00Z") / 1000);
    // Two zero blocks close the archive, and nothing follows them.
    expect(archive.length).toBe(end + 1024);
    expect(archive.length % 512).toBe(0);
  });

  it("carries names the header cannot hold in a pax record", async () => {
    const long = `${"x".repeat(150)}.json`;
    const cjk = "评测报告 v2.html";
    const { entries } = readTar(
      await collect(
        tarStream([entry(long, bytes("1")), entry(cjk, bytes("2"))]),
      ),
    );
    expect(entries.map((e) => e.name)).toEqual([long, cjk]);
  });

  it("sizes a pax record whose length gains a digit from its own count", async () => {
    // " path=" + name + "\n" is 98 bytes here, and 98 + 2 digits = 100,
    // which is three digits: the record is 101 bytes long, not 100.
    const name = `${"é".repeat(45)}a`;
    expect(bytes(` path=${name}\n`).length).toBe(98);
    const { entries } = readTar(
      await collect(tarStream([entry(name, bytes("z"))])),
    );
    expect(entries[0].name).toBe(name);
  });

  it("fails rather than shifting every later entry when a body's size is off", async () => {
    await expect(
      collect(tarStream([entry("short", bytes("abc"), 4)])),
    ).rejects.toThrow("short ended after 3 of 4 bytes");
    await expect(
      collect(tarStream([entry("long", bytes("abcde"), 4)])),
    ).rejects.toThrow("long is larger than its listed 4 bytes");
  });

  it("opens each body only when the archive reaches it, and none after a cancel", async () => {
    const opened: string[] = [];
    const tracked = (name: string): TarEntry => {
      const inner = entry(name, new Uint8Array(4096));
      return {
        ...inner,
        open: () => {
          opened.push(name);
          return inner.open();
        },
      };
    };
    const reader = tarStream([tracked("one"), tracked("two")]).getReader();
    expect(opened).toEqual([]);
    await reader.read(); // header of "one"
    await reader.read(); // first chunk of "one"
    expect(opened).toEqual(["one"]);
    await reader.cancel();
    expect(opened).toEqual(["one"]);
  });

  it("reports body bytes as they pass", async () => {
    const seen: number[] = [];
    await collect(
      tarStream([entry("a", bytes("abcd")), entry("b", bytes("ef"))], (n) =>
        seen.push(n),
      ),
    );
    expect(seen.at(-1)).toBe(6);
  });

  describe.skipIf(spawnSync("tar", ["--version"]).status !== 0)(
    "against the system tar",
    () => {
      const dir = mkdtempSync(join(tmpdir(), "todou-tar-"));
      afterAll(() => rmSync(dir, { recursive: true, force: true }));

      it("extracts every name and body intact", async () => {
        const files: [string, string][] = [
          ["plain.txt", "plain"],
          [`${"long-".repeat(30)}name.json`, "long"],
          ["结果 汇总.html", "<p>cjk</p>"],
        ];
        const archive = await collect(
          tarStream(files.map(([name, body]) => entry(name, bytes(body)))),
        );
        writeFileSync(join(dir, "out.tar"), archive);
        const run = spawnSync("tar", ["-xf", "out.tar"], { cwd: dir });
        expect(run.stderr.toString()).toBe("");
        expect(run.status).toBe(0);
        for (const [name, body] of files) {
          expect(readFileSync(join(dir, name), "utf8")).toBe(body);
        }
      });
    },
  );
});
