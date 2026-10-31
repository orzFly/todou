import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { detectAgentContext } from "../../src/harness/index.ts";

const home = mkdtempSync(join(tmpdir(), "todou-dsh-home-"));
afterAll(() => rmSync(home, { recursive: true, force: true }));

const SID = "session-11111111-2222-3333-4444-555555555555";

function cacheWithModel(model: string): unknown {
  return {
    version: 7,
    record: {
      rows: {
        modelSelection: {
          val: {
            lastUsed: {
              provider: "deepseek-official",
              model,
              reasoningEffort: "high",
            },
          },
        },
      },
    },
  };
}

function writeProjectionCache(root: string, records: Record<string, unknown>) {
  const dir = join(root, "storages", "session_projcache", "sessions");
  mkdirSync(dir, { recursive: true });
  for (const [sessionId, record] of Object.entries(records)) {
    writeFileSync(join(dir, `${sessionId}.json`), JSON.stringify(record));
  }
}

describe("dsh", () => {
  it("returns null outside DSH", () => {
    expect(detectAgentContext({}, home)).toBeNull();
  });

  it("degrades to agent and session when no cache is readable", () => {
    expect(detectAgentContext({ DSH_SESSION_ID: SID }, home)).toEqual({
      agent: "dsh",
      session_id: SID,
    });
  });

  it("reads the current model from the session projection cache", () => {
    writeProjectionCache(join(home, ".dsh"), {
      [SID]: cacheWithModel("deepseek-flash"),
    });
    expect(detectAgentContext({ DSH_SESSION_ID: SID }, home)).toEqual({
      agent: "dsh",
      session_id: SID,
      model: "deepseek-flash",
    });
  });

  it("honours DSH_HOME", () => {
    const dshHome = mkdtempSync(join(tmpdir(), "todou-dsh-alt-"));
    try {
      writeProjectionCache(dshHome, { [SID]: cacheWithModel("deepseek-pro") });
      expect(
        detectAgentContext({ DSH_SESSION_ID: SID, DSH_HOME: dshHome }, home),
      ).toEqual({
        agent: "dsh",
        session_id: SID,
        model: "deepseek-pro",
      });
    } finally {
      rmSync(dshHome, { recursive: true, force: true });
    }
  });

  it("never follows a path-shaped session id", () => {
    expect(detectAgentContext({ DSH_SESSION_ID: "../../evil" }, home)).toEqual({
      agent: "dsh",
      session_id: "../../evil",
    });
  });

  it("survives a malformed cache", () => {
    const dir = join(home, ".dsh", "storages", "session_projcache", "sessions");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${SID}.json`), "{not json");
    expect(detectAgentContext({ DSH_SESSION_ID: SID }, home)?.model).toBe(
      undefined,
    );
  });
});
