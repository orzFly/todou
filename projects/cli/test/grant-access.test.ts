import { describe, expect, it } from "vitest";
import { fakeFetch, loggedInEnv, type Route, runCli } from "./harness.ts";

/**
 * The hint and link a failed command adds when the failure is "no access"
 * (T-280), and — the point of the card — the bytes it must NOT vary by.
 */

const HINT = { suppressed: false, login: "bot-one", user_id: 41 };
const VERSION = { version: "0.4.0", public_origin: "https://todou.example" };
const LINK =
  "  https://todou.example/grant-access?target=homelab&login=bot-one&uid=41";

/** What the server sends for a project that is not this caller's to read. */
const projectNotFound = {
  __status: 404,
  body: { error: { code: "not_found", message: "project not found" } },
};

const hintRoutes: Route[] = [
  ["GET", "/api/me/access-hint", HINT],
  ["GET", "/api/version", VERSION],
];

function statusList(routes: Route[]) {
  const { fetchImpl, calls } = fakeFetch(routes);
  return runCli(["status", "list", "-p", "homelab"], {
    fetchImpl,
    env: loggedInEnv(),
  }).then((result) => ({ ...result, calls }));
}

describe("the access hint on a project that cannot be read", () => {
  it("offers a link, in wording that does not claim the project exists", async () => {
    const result = await statusList([
      ["GET", "/api/projects/homelab/statuses", projectNotFound],
      ...hintRoutes,
    ]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe(
      "error: not_found — project not found\n" +
        '"homelab" may not exist, or may not be readable by bot-one\n' +
        "if such a project does exist, you can try asking an admin for access:\n" +
        `${LINK}\n`,
    );
  });

  it("writes the same bytes whether or not the project exists", async () => {
    // The invariant the whole design rests on. Both servers answer the way
    // the real one does — `getProjectByRef` and `requireProject` throw the
    // same message — and the second offers a route the CLI must never reach
    // for: consulting it is how a hint would become an existence probe.
    const missing = await statusList([
      ["GET", "/api/projects/homelab/statuses", projectNotFound],
      ...hintRoutes,
    ]);
    const unreadable = await statusList([
      ["GET", "/api/projects/homelab/statuses", projectNotFound],
      ["GET", "/api/projects/homelab", { __status: 404, body: null }],
      ...hintRoutes,
    ]);
    expect(unreadable.stderr).toBe(missing.stderr);
    expect(unreadable.calls.map((c) => new URL(c.url).pathname)).toEqual([
      "/api/projects/homelab/statuses",
      "/api/me/access-hint",
      "/api/version",
    ]);
  });

  it("prints nothing extra once this account has been denied", async () => {
    const result = await statusList([
      ["GET", "/api/projects/homelab/statuses", projectNotFound],
      ["GET", "/api/me/access-hint", { ...HINT, suppressed: true }],
      ["GET", "/api/version", VERSION],
    ]);
    // Exactly what the command printed before this card existed.
    expect(result.stderr).toBe("error: not_found — project not found\n");
  });

  it("prints nothing extra when the hint cannot be had", async () => {
    const result = await statusList([
      ["GET", "/api/projects/homelab/statuses", projectNotFound],
      ["GET", "/api/me/access-hint", { __status: 500, body: null }],
      ["GET", "/api/version", VERSION],
    ]);
    expect(result.stderr).toBe("error: not_found — project not found\n");
    expect(result.exitCode).toBe(1);
  });

  it("falls back to the API base when the server declares no public one", async () => {
    const result = await statusList([
      ["GET", "/api/projects/homelab/statuses", projectNotFound],
      ["GET", "/api/me/access-hint", HINT],
      ["GET", "/api/version", { version: "0.4.0" }],
    ]);
    expect(result.stderr).toContain(
      "  http://stub.test/grant-access?target=homelab&login=bot-one&uid=41\n",
    );
  });

  it("leaves a missing issue alone, asking nothing", async () => {
    const { fetchImpl, calls } = fakeFetch([
      [
        "GET",
        "/api/projects/homelab/issues/9",
        {
          __status: 404,
          body: { error: { code: "not_found", message: "issue not found" } },
        },
      ],
      ["GET", "/api/projects/homelab/references/config", { __status: 404 }],
      ["GET", "/api/projects", []],
    ]);
    const result = await runCli(["issue", "view", "9", "-p", "homelab"], {
      fetchImpl,
      env: loggedInEnv(),
    });
    // Same status and code one path segment deeper; the message is what
    // keeps the offer off it.
    expect(result.stderr).toBe("error: not_found — issue not found\n");
    expect(calls.map((c) => new URL(c.url).pathname)).not.toContain(
      "/api/me/access-hint",
    );
  });
});

describe("the access hint on a role that is too low", () => {
  it("names the project outright, because it reads fine", async () => {
    const { fetchImpl } = fakeFetch([
      [
        "POST",
        "/api/projects/homelab/issues",
        {
          __status: 403,
          body: {
            error: {
              code: "forbidden",
              message: "requires writer role (issue.create)",
            },
          },
        },
      ],
      ...hintRoutes,
    ]);
    const result = await runCli(
      [
        "issue",
        "create",
        "-p",
        "homelab",
        "--title",
        "found a bug",
        "--body",
        "it fell over",
      ],
      { fetchImpl, env: loggedInEnv() },
    );
    expect(result.stderr).toBe(
      "error: forbidden — requires writer role (issue.create)\n" +
        'ask an admin to raise bot-one\'s role in "homelab":\n' +
        `${LINK}\n`,
    );
  });
});

describe("the access hint on a prefix nothing in reach holds", () => {
  const config = {
    format: { prefix: "T", history: [] },
    autolinks: [],
  };
  const directory = {
    entries: [
      { prefix: "T", slug: "main", from: "2026-01-01T00:00:00Z", to: null },
      {
        prefix: "FOOBAR",
        slug: "mica",
        from: "2026-01-01T00:00:00Z",
        to: null,
      },
    ],
    contested: [],
  };

  function viewRef(ref: string, extra: Route[] = []) {
    const { fetchImpl, calls } = fakeFetch([
      ["GET", "/api/projects/main/references/config", config],
      ["GET", "/api/me/reference-directory", directory],
      ["GET", "/api/me/refs/resolve", { __status: 404, body: null }],
      ...extra,
    ]);
    return runCli(["issue", "view", ref, "-p", "main"], {
      fetchImpl,
      env: loggedInEnv(),
    }).then((result) => ({ ...result, calls }));
  }

  it("offers a link when nothing local looks like a typo", async () => {
    const result = await viewRef("CH-158", [
      ["GET", "/api/me/access-hint", HINT],
      ["GET", "/api/version", VERSION],
    ]);
    expect(result.stderr).toContain(
      '"CH-158" may not exist, or may not be readable by bot-one\n',
    );
    expect(result.stderr).toContain(
      "  https://todou.example/grant-access?target=CH-158&login=bot-one&uid=41\n",
    );
  });

  it("stays silent when a prefix in reach is one keystroke away", async () => {
    const result = await viewRef("FOOBA-1");
    expect(result.stderr).toContain("did you mean 'FOOBAR-1'?");
    expect(result.stderr).not.toContain("grant-access");
    expect(result.calls.map((c) => new URL(c.url).pathname)).not.toContain(
      "/api/me/access-hint",
    );
  });
});
