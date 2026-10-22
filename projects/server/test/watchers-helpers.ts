import { setTimeout as delay } from "node:timers/promises";
import { AGENT_CONTEXT_HEADER } from "@todou/shared";
import { expect } from "vitest";
import type { TestApp } from "./helpers.ts";

type Frame = { event: string; data: string };

/** A raw SSE connection, read frame by frame. */
export async function openFeed(
  t: TestApp,
  path: string,
  headers: Record<string, string>,
) {
  const controller = new AbortController();
  const res = await t.app.request(path, { headers, signal: controller.signal });
  expect(res.status).toBe(200);
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const frames: Frame[] = [];
  const pull = async () => {
    const { value, done } = await reader.read();
    if (done) throw new Error("stream ended");
    buffer += decoder.decode(value, { stream: true });
    let cut = buffer.indexOf("\n\n");
    while (cut !== -1) {
      const raw = buffer.slice(0, cut);
      buffer = buffer.slice(cut + 2);
      let event = "message";
      const data: string[] = [];
      for (const line of raw.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) data.push(line.slice(5).trim());
      }
      frames.push({ event, data: data.join("\n") });
      cut = buffer.indexOf("\n\n");
    }
  };
  const feed = {
    /** The next change frame, of any entity, skipping pings. */
    async nextChange(): Promise<Record<string, unknown>> {
      for (;;) {
        const frame = frames.shift();
        if (frame === undefined) {
          await pull();
          continue;
        }
        if (frame.event === "change") return JSON.parse(frame.data);
      }
    },
    abort: () => {
      // Cancelling the body is what ends an in-process stream; the signal
      // alone does not reach it.
      controller.abort();
      void reader.cancel().catch(() => {});
    },
  };
  for (;;) {
    await pull();
    if (frames.some((f) => f.event === "hello")) break;
  }
  frames.splice(0, frames.findIndex((f) => f.event === "hello") + 1);
  return feed;
}

export async function until(check: () => Promise<boolean>): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (await check()) return;
    await delay(10);
  }
  throw new Error("condition never held");
}

export const agent = (session: string) => ({
  [AGENT_CONTEXT_HEADER]: JSON.stringify({
    agent: "claude-code",
    session_id: session,
  }),
});
