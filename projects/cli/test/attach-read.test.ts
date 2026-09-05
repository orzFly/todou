import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { fakeFetch, loggedInEnv, type Route, runCli } from "./harness.ts";

const me = {
  id: 2,
  login: "claude",
  display_name: "Claude",
  kind: "machine",
  owner: null,
};

// ASCII: runCli reads its captured stdout back as utf8, so a payload with
// high bytes would be compared against a re-encoded copy of itself.
const PAYLOAD = "PNG-ish bytes, 32 of them, ok!!\n";

function file(over: Record<string, unknown> = {}) {
  return {
    id: 42,
    filename: "shot.png",
    content_type: "image/png",
    size: PAYLOAD.length,
    url: "/api/projects/demo/attachments/42/download/shot.png",
    uploader: me,
    created_at: "2026-08-29T10:00:00.000Z",
    ...over,
  };
}

const NOTES = file({
  id: 43,
  filename: "notes.md",
  content_type: "text/markdown",
  size: 2048,
  url: "/api/projects/demo/attachments/43/download/notes.md",
});

/** The list endpoint plus a download for every id it advertises. */
function routes(list: Array<Record<string, unknown>>): Route[] {
  return [
    ["GET", "/api/projects/demo/attachments", list],
    ...list.map(
      (a): Route => [
        "GET",
        `/api/projects/demo/attachments/${a.id}/download`,
        new Response(PAYLOAD, {
          headers: { "content-type": String(a.content_type) },
        }),
      ],
    ),
  ];
}

const env = loggedInEnv("demo");

describe("attach list", () => {
  it("prints id, name, human size and url", async () => {
    const { fetchImpl } = fakeFetch(routes([file(), NOTES]));
    const result = await runCli(["attach", "list", "16"], { fetchImpl, env });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(
      "#42  shot.png  32 B    /api/projects/demo/attachments/42/download/shot.png\n" +
        "#43  notes.md  2.0 KB  /api/projects/demo/attachments/43/download/notes.md\n",
    );
  });

  it("queries the issue it was given", async () => {
    const { fetchImpl, calls } = fakeFetch(routes([file()]));
    await runCli(["attach", "list", "demo/16"], { fetchImpl, env });
    expect(calls[0]?.url).toBe(
      "http://stub.test/api/projects/demo/attachments?issue_number=16",
    );
  });

  it("prints the raw array under --json", async () => {
    const { fetchImpl } = fakeFetch(routes([file(), NOTES]));
    const result = await runCli(["attach", "list", "16", "--json"], {
      fetchImpl,
      env,
    });
    expect(JSON.parse(result.stdout)).toEqual([file(), NOTES]);
  });

  it("says so when an issue has none", async () => {
    const { fetchImpl } = fakeFetch(routes([]));
    const human = await runCli(["attach", "list", "16"], { fetchImpl, env });
    expect(human.stdout).toBe("no attachments\n");
    const json = await runCli(["attach", "list", "16", "--json"], {
      fetchImpl,
      env,
    });
    expect(JSON.parse(json.stdout)).toEqual([]);
  });
});

describe("attach download", () => {
  const root = mkdtempSync(join(tmpdir(), "todou-attach-read-"));
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  let seq = 0;
  /** A fresh cwd per case, so "the file is already there" stays a choice. */
  const cwd = () => {
    seq += 1;
    const dir = join(root, `case-${seq}`);
    mkdirSync(dir);
    return dir;
  };

  it("writes the server's filename into the working directory", async () => {
    const dir = cwd();
    const { fetchImpl } = fakeFetch(routes([file()]));
    const result = await runCli(["attach", "download", "16", "42"], {
      fetchImpl,
      env,
      cwd: dir,
    });
    expect(result.exitCode).toBe(0);
    const target = join(dir, "shot.png");
    expect(readFileSync(target, "utf8")).toBe(PAYLOAD);
    expect(result.stdout).toBe(`shot.png (32 B) → ${target}\n`);
  });

  it("reuses the session's authorization on the download itself", async () => {
    const { fetchImpl, calls } = fakeFetch(routes([file()]));
    await runCli(["attach", "download", "16", "42"], {
      fetchImpl,
      env,
      cwd: cwd(),
    });
    const download = calls.at(-1);
    expect(download?.url).toBe(
      "http://stub.test/api/projects/demo/attachments/42/download",
    );
    const headers = download?.init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer todou_pat_test");
  });

  it("reports saved_to under --json", async () => {
    const dir = cwd();
    const { fetchImpl } = fakeFetch(routes([file()]));
    const result = await runCli(["attach", "download", "16", "42", "--json"], {
      fetchImpl,
      env,
      cwd: dir,
    });
    expect(JSON.parse(result.stdout)).toEqual({
      ...file(),
      saved_to: join(dir, "shot.png"),
    });
  });

  it("refuses to overwrite a name it chose itself", async () => {
    const dir = cwd();
    writeFileSync(join(dir, "shot.png"), "mine");
    const { fetchImpl } = fakeFetch(routes([file()]));
    const result = await runCli(["attach", "download", "16", "42"], {
      fetchImpl,
      env,
      cwd: dir,
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("already exists");
    expect(result.stderr).toContain("-o <path>");
    expect(readFileSync(join(dir, "shot.png"), "utf8")).toBe("mine");
  });

  it("writes into an existing directory given to -o", async () => {
    const dir = cwd();
    const into = join(dir, "downloads");
    mkdirSync(into);
    const { fetchImpl } = fakeFetch(routes([file()]));
    const result = await runCli(
      ["attach", "download", "16", "shot.png", "-o", "downloads"],
      { fetchImpl, env, cwd: dir },
    );
    expect(result.exitCode).toBe(0);
    expect(readFileSync(join(into, "shot.png"), "utf8")).toBe(PAYLOAD);
  });

  it("overwrites a file path the user named", async () => {
    const dir = cwd();
    const target = join(dir, "picked.bin");
    writeFileSync(target, "stale");
    const { fetchImpl } = fakeFetch(routes([file()]));
    const result = await runCli(
      ["attach", "download", "16", "42", "-o", "picked.bin"],
      { fetchImpl, env, cwd: dir },
    );
    expect(result.exitCode).toBe(0);
    expect(readFileSync(target, "utf8")).toBe(PAYLOAD);
  });

  it("streams to stdout under -o -, with the summary on stderr", async () => {
    const dir = cwd();
    const { fetchImpl } = fakeFetch(routes([file()]));
    const result = await runCli(["attach", "download", "16", "42", "-o", "-"], {
      fetchImpl,
      env,
      cwd: dir,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(PAYLOAD);
    expect(result.stderr).toBe("shot.png (32 B)\n");
    expect(existsSync(join(dir, "shot.png"))).toBe(false);
  });

  it("refuses -o - together with --json", async () => {
    const { fetchImpl } = fakeFetch(routes([file()]));
    const result = await runCli(
      ["attach", "download", "16", "42", "-o", "-", "--json"],
      { fetchImpl, env, cwd: cwd() },
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("both want stdout");
  });

  it("falls back to the filename when no id matches the digits", async () => {
    const dir = cwd();
    const digits = file({ id: 7, filename: "42", content_type: "text/plain" });
    const { fetchImpl, calls } = fakeFetch(routes([digits]));
    const result = await runCli(["attach", "download", "16", "42"], {
      fetchImpl,
      env,
      cwd: dir,
    });
    expect(result.exitCode).toBe(0);
    expect(calls.at(-1)?.url).toBe(
      "http://stub.test/api/projects/demo/attachments/7/download",
    );
    expect(readFileSync(join(dir, "42"), "utf8")).toBe(PAYLOAD);
  });

  it("finds a name typed in the wrong case (T-269)", async () => {
    const dir = cwd();
    const { fetchImpl, calls } = fakeFetch(routes([file(), NOTES]));
    const result = await runCli(["attach", "download", "16", "SHOT.PNG"], {
      fetchImpl,
      env,
      cwd: dir,
    });
    expect(result.exitCode).toBe(0);
    expect(calls.at(-1)?.url).toBe(
      "http://stub.test/api/projects/demo/attachments/42/download",
    );
    // Saved under the stored spelling, not the one that was typed.
    expect(readFileSync(join(dir, "shot.png"), "utf8")).toBe(PAYLOAD);
  });

  it("refuses to guess between two attachments of one name", async () => {
    const twins = [file(), file({ id: 99, size: 11 })];
    const { fetchImpl } = fakeFetch(routes(twins));
    const result = await runCli(["attach", "download", "16", "shot.png"], {
      fetchImpl,
      env,
      cwd: cwd(),
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('2 attachments are named "shot.png"');
    expect(result.stderr).toContain("#42");
    expect(result.stderr).toContain("#99");
    expect(result.stderr).toContain("by id");
  });

  it("lists what is there when the name matches nothing", async () => {
    const { fetchImpl } = fakeFetch(routes([file(), NOTES]));
    const result = await runCli(["attach", "download", "16", "gone.png"], {
      fetchImpl,
      env,
      cwd: cwd(),
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('no attachment "gone.png"');
    expect(result.stderr).toContain("#42 shot.png");
    expect(result.stderr).toContain("#43 notes.md");
  });

  it("says the issue is empty rather than listing nothing", async () => {
    const { fetchImpl } = fakeFetch(routes([]));
    const result = await runCli(["attach", "download", "16", "shot.png"], {
      fetchImpl,
      env,
      cwd: cwd(),
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("no attachments");
  });
});

describe("attach routing", () => {
  const dir = mkdtempSync(join(tmpdir(), "todou-attach-route-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  /** Upload against an fs-backend server: probe 409, then multipart. */
  function uploadRoutes(seen: string[]): Route[] {
    return [
      [
        "POST",
        "/api/projects/demo/attachments/direct-uploads",
        {
          __status: 409,
          body: { error: { code: "direct_upload_unavailable" } },
        },
      ],
      [
        "POST",
        "/api/projects/demo/attachments",
        (init: RequestInit) => {
          const upload = (init.body as FormData).get("file") as File;
          seen.push(upload.name);
          return file({ filename: upload.name, url: "/attachments/x" });
        },
      ],
    ];
  }

  it("does not read `list` as a file to upload", async () => {
    const { fetchImpl, calls } = fakeFetch(routes([file()]));
    const result = await runCli(["attach", "list", "16"], { fetchImpl, env });
    expect(result.exitCode).toBe(0);
    expect(calls.every((c) => c.init.method !== "POST")).toBe(true);
  });

  it("uploads under `attach add` and under the bare form alike", async () => {
    const source = join(dir, "note.txt");
    writeFileSync(source, "x");
    const seen: string[] = [];
    const { fetchImpl } = fakeFetch(uploadRoutes(seen));
    for (const argv of [
      ["attach", "add", "16", source],
      ["attach", "16", source],
    ]) {
      const result = await runCli(argv, { fetchImpl, env });
      expect(result.exitCode).toBe(0);
    }
    expect(seen).toEqual(["note.txt", "note.txt"]);
  });
});
