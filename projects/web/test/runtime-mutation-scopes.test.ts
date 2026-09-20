import { hashKey } from "@tanstack/react-query";
import { TodouError } from "@todou/shared";
import { describe, expect, it, vi } from "vitest";
import {
  invalidateRuntimeMutation,
  MUTATION_SCOPE_REGISTRY,
  type MutationScopeEvent,
  mutationScopes,
} from "../src/api/runtime/mutation-scopes.ts";
import type { ProjectionDescriptor } from "../src/api/runtime/projections.ts";
import { readMutationAffects } from "../src/api/runtime/read-scope.ts";
import {
  type InvalidationTarget,
  type ResourceDescriptor,
  resource,
} from "../src/api/runtime/resources.ts";
import { ResourceRuntime } from "../src/api/runtime/runtime.ts";

function event(
  path: string,
  method = "POST",
  extra: Partial<MutationScopeEvent> = {},
): MutationScopeEvent {
  return { path, method, phase: "success", context: {}, ...extra };
}
function projection(
  queryKey: readonly unknown[],
  policy: Parameters<typeof resource>[0],
  path: string,
): ProjectionDescriptor {
  return {
    version: 1,
    kind: "direct",
    queryKey,
    queryHash: hashKey(queryKey),
    resources: [resource(policy, path)],
  };
}

// One concrete invocation per transport write route. Source references in the
// registry identify every UI path, including calls without local invalidation.
const writes: Array<[string, string, string]> = [
  ["POST", "/auth/login", "auth"],
  ["POST", "/auth/logout", "auth"],
  ["POST", "/auth/cli/requests", "auth"],
  ["POST", "/auth/cli/requests/1/poll", "auth"],
  ["POST", "/auth/cli/requests/1/approve", "cli-decision"],
  ["POST", "/auth/cli/requests/1/deny", "cli-decision"],
  ["POST", "/me/tokens", "tokens"],
  ["DELETE", "/me/tokens/1", "tokens"],
  ["POST", "/agents/1/tokens", "tokens"],
  ["DELETE", "/agents/1/tokens/2", "tokens"],
  ["PATCH", "/me", "profile"],
  ["POST", "/me/avatar", "profile"],
  ["DELETE", "/me/avatar", "profile"],
  ["PATCH", "/me/prefs", "prefs"],
  ["PUT", "/me/read", "read-sweep"],
  ["POST", "/agents", "agents"],
  ["PATCH", "/agents/1", "agents"],
  ["DELETE", "/agents/1", "agents"],
  ["POST", "/agents/1/enable", "agents"],
  ["POST", "/agents/1/avatar", "agents"],
  ["DELETE", "/agents/1/avatar", "agents"],
  ["POST", "/projects", "project-create"],
  ["PATCH", "/projects/p", "project-settings"],
  ["DELETE", "/projects/p", "project-settings"],
  ["POST", "/projects/p/icon", "project-icon"],
  ["DELETE", "/projects/p/icon", "project-icon"],
  ["POST", "/projects/p/members", "membership-access"],
  ["PUT", "/projects/p/members/1", "membership-access"],
  ["DELETE", "/projects/p/members/1", "membership-access"],
  ["PUT", "/projects/p/access-denials/1", "membership-access"],
  ["DELETE", "/projects/p/access-denials/1", "membership-access"],
  ["POST", "/projects/p/statuses", "project-taxonomy"],
  ["PATCH", "/projects/p/statuses/1", "project-taxonomy"],
  ["DELETE", "/projects/p/statuses/1", "project-taxonomy"],
  ["POST", "/projects/p/labels", "project-taxonomy"],
  ["PATCH", "/projects/p/labels/1", "project-taxonomy"],
  ["DELETE", "/projects/p/labels/1", "project-taxonomy"],
  ["PUT", "/projects/p/references/format", "references"],
  ["POST", "/projects/p/references/autolinks", "references"],
  ["DELETE", "/projects/p/references/autolinks/1", "references"],
  ["PUT", "/projects/p/insights/settings", "insights-settings"],
  ["PUT", "/projects/p/mute", "mutes"],
  ["DELETE", "/projects/p/mute", "mutes"],
  ["PUT", "/projects/p/issues/1/mute", "mutes"],
  ["DELETE", "/projects/p/issues/1/mute", "mutes"],
  ["POST", "/projects/p/issues", "issue-create"],
  ["PATCH", "/projects/p/issues/1", "issue-edit"],
  ["DELETE", "/projects/p/issues/1", "issue-edit"],
  ["POST", "/projects/p/issues/1/restore", "issue-edit"],
  ["POST", "/projects/p/issues/1/move", "issue-move"],
  ["PUT", "/projects/p/issues/1/read", "read-one"],
  ["PATCH", "/projects/p/issues/1/metadata", "metadata"],
  ["POST", "/projects/p/issues/1/blocks", "blocks"],
  ["DELETE", "/projects/p/issues/1/blocks/2", "blocks"],
  ["POST", "/projects/p/issues/1/blocked-by", "blocks"],
  ["DELETE", "/projects/p/issues/1/blocked-by/2", "blocks"],
  ["POST", "/projects/p/issues/1/commands", "comments-commands-answers"],
  ["POST", "/projects/p/issues/1/comments", "comments-commands-answers"],
  ["PATCH", "/projects/p/issues/1/comments/2", "comments-commands-answers"],
  ["DELETE", "/projects/p/issues/1/comments/2", "comments-commands-answers"],
  ["POST", "/projects/p/issues/1/comments/hide", "comments-commands-answers"],
  [
    "POST",
    "/projects/p/issues/1/comments/2/answers",
    "comments-commands-answers",
  ],
  ["POST", "/projects/p/issues/1/spec/push", "spec"],
  ["POST", "/projects/p/issues/1/spec/withdraw", "spec"],
  ["POST", "/projects/p/issues/1/spec/reviews", "spec"],
  ["POST", "/projects/p/issues/1/spec/comments/resolve", "spec"],
  ["POST", "/projects/p/attachments", "attachments"],
  ["POST", "/projects/p/attachments/direct-uploads", "attachments"],
  [
    "POST",
    "/projects/p/attachments/direct-uploads/upload-id/complete",
    "attachments",
  ],
];

describe("business mutation scope inventory", () => {
  it.each(writes)(
    "maps %s %s to %s on success, error and settle",
    (method, path, rule) => {
      for (const phase of ["success", "error", "settled"] as const) {
        expect(mutationScopes(event(path, method, { phase })).rule).toBe(rule);
      }
    },
  );

  it("keeps every registry rule backed by an invocation and source evidence", () => {
    expect(new Set(writes.map(([, , rule]) => rule))).toEqual(
      new Set(MUTATION_SCOPE_REGISTRY.map((rule) => rule.id)),
    );
    for (const rule of MUTATION_SCOPE_REGISTRY)
      expect(rule.evidence.length).toBeGreaterThan(0);
    const evidence = MUTATION_SCOPE_REGISTRY.flatMap((rule) => rule.evidence);
    expect(evidence).toContain("pages/grant-access.tsx");
    expect(evidence).toContain("pages/cli-auth.tsx");
    expect(evidence).toContain("pages/project-settings.tsx");
  });

  it("invalidates unknown writes but excludes reads, secrets and move previews", () => {
    expect(mutationScopes(event("/new-business-route")).targets).toEqual([
      { type: "user" },
    ]);
    for (const [path, method] of [
      ["/me/tokens", "POST"],
      ["/agents/1/tokens", "POST"],
      ["/auth/login", "POST"],
      ["/anything", "GET"],
    ]) {
      expect(mutationScopes(event(path, method)).targets).toEqual([]);
    }
    expect(
      mutationScopes(
        event("/projects/p/issues/1/move", "POST", { body: { dry_run: true } }),
      ).targets,
    ).toEqual([]);
  });

  it("targets both move addresses and only the mutable spec version", () => {
    const moved = mutationScopes(
      event("/projects/p/issues/1/move", "POST", {
        data: { moved_to: { slug: "q", number: 2 } },
      }),
    ).targets;
    expect(moved).toContainEqual({
      type: "key-prefix",
      queryKey: ["issue", "p", 1],
    });
    expect(moved).toContainEqual({
      type: "key-prefix",
      queryKey: ["issue", "q", 2],
    });
    const spec = mutationScopes(
      event("/projects/p/issues/1/spec/reviews"),
    ).targets;
    expect(spec).toContainEqual({
      type: "key-prefix",
      queryKey: ["spec-files", "p", 1, "current"],
    });
    expect(spec).not.toContainEqual({
      type: "key-prefix",
      queryKey: ["spec-files", "p", 1],
    });
  });

  it("passes only scopes to the worker and never replays a failed write", async () => {
    const control = vi.fn().mockRejectedValue(new Error("worker unavailable"));
    const runtime = {
      ready: Promise.resolve(),
      mode: "worker" as const,
      control,
    };
    await invalidateRuntimeMutation(
      runtime,
      event("/projects/p/members/1", "PUT", {
        phase: "error",
        body: { role: "admin", token: "todou_pat_fake" },
        context: { operationId: "write-1" },
      }),
    );
    expect(control).toHaveBeenCalledOnce();
    expect(control).toHaveBeenCalledWith(
      "INVALIDATE",
      expect.objectContaining({
        operationId: "write-1",
        source: "mutation",
        completion: "dirty-applied",
      }),
    );
    expect(JSON.stringify(control.mock.calls)).not.toContain("todou_pat_fake");
    await invalidateRuntimeMutation(runtime, event("/me/tokens"));
    expect(control).toHaveBeenCalledOnce();
  });
});

describe("precise mark-read scopes", () => {
  const read = { slug: "p", number: 1 };
  const unread = { number: 1, unread: true, unread_comments: 2 };
  const attentionOnly = {
    ...unread,
    project: { slug: "p" },
    unread: false,
    unread_comments: 0,
    mentions_you: false,
    pending_spec_review: true,
    open_questions: 2,
  };

  it("does nothing for already-read, absent, counts, or attention-only rows", () => {
    expect(
      readMutationAffects(
        ["issues", "p", {}],
        { items: [{ ...unread, unread: false, unread_comments: 0 }] },
        read,
      ),
    ).toBe(false);
    expect(
      readMutationAffects(
        ["issues", "p", {}],
        { items: [{ ...unread, number: 2 }] },
        read,
      ),
    ).toBe(false);
    expect(
      readMutationAffects(["issues", "p", "counts"], { open: 3 }, read),
    ).toBe(false);
    expect(
      readMutationAffects(["issues", "p", "counts"], undefined, read),
    ).toBe(false);
    expect(
      readMutationAffects(["inbox"], { items: [attentionOnly] }, read),
    ).toBe(false);
    expect(
      readMutationAffects(
        ["inbox"],
        { items: [{ ...attentionOnly, pending_spec_review: false }] },
        read,
      ),
    ).toBe(false);
  });

  it("refreshes unread markers/mentions only inside the requested scope", () => {
    expect(
      readMutationAffects(
        ["issues", "p", { board: 4 }],
        { items: [unread] },
        read,
      ),
    ).toBe(true);
    expect(
      readMutationAffects(["issues", "q", {}], { items: [unread] }, read),
    ).toBe(false);
    expect(
      readMutationAffects(
        ["inbox"],
        { items: [{ ...attentionOnly, mentions_you: true }] },
        read,
      ),
    ).toBe(true);
    expect(
      readMutationAffects(
        ["inbox"],
        { items: [{ ...attentionOnly, project: { slug: "q" }, unread: true }] },
        read,
      ),
    ).toBe(false);
    expect(
      mutationScopes(event("/projects/p/issues/1/read", "PUT")).targets,
    ).toEqual([{ type: "read", ...read }]);
    expect(
      mutationScopes(
        event("/me/read", "PUT", { body: { projects: ["p", "q"] } }),
      ).targets,
    ).toEqual([
      { type: "read", slug: "p" },
      { type: "read", slug: "q" },
    ]);
  });

  it("repairs another page with no source-page query and leaves no-op projections fresh", async () => {
    const values: Record<string, unknown> = {
      "/projects/p/issues": { items: [unread] },
      "/projects/q/issues": { items: [unread] },
      "/me/inbox": { items: [attentionOnly] },
    };
    const network = vi.fn(
      async (descriptor: { path: string }) => values[descriptor.path],
    );
    const runtime = new ResourceRuntime({ network });
    const p = projection(["issues", "p", {}], "issues", "/projects/p/issues");
    const q = projection(["issues", "q", {}], "issues", "/projects/q/issues");
    const inbox = projection(["inbox"], "inbox", "/me/inbox");
    const bridge = {
      mode: "worker" as const,
      ready: Promise.resolve(),
      control: async (_type: string, payload: Record<string, unknown>) =>
        runtime.invalidate(payload.targets as InvalidationTarget[], {
          operationId: payload.operationId as string,
          refetchType: "none",
        }),
    };
    try {
      await Promise.all([
        runtime.readProjection(p),
        runtime.readProjection(q),
        runtime.readProjection(inbox),
      ]);
      values["/projects/p/issues"] = {
        items: [{ ...unread, unread: false, unread_comments: 0 }],
      };
      await invalidateRuntimeMutation(
        bridge,
        event("/projects/p/issues/1/read", "PUT"),
      );
      await Promise.all([
        runtime.readProjection(p),
        runtime.readProjection(q),
        runtime.readProjection(inbox),
      ]);
      expect(network.mock.calls.map(([descriptor]) => descriptor.path)).toEqual(
        [
          "/projects/p/issues",
          "/projects/q/issues",
          "/me/inbox",
          "/projects/p/issues",
        ],
      );
      await invalidateRuntimeMutation(
        bridge,
        event("/projects/p/issues/1/read", "PUT"),
      );
      await runtime.readProjection(p);
      expect(network).toHaveBeenCalledTimes(4);
    } finally {
      runtime.dispose();
    }
  });

  it("invalidates cross-page project data after grant-access without local queries", async () => {
    const network = vi.fn(async () => [{ user: { id: 1 }, role: "reader" }]);
    const runtime = new ResourceRuntime({ network });
    const members = projection(
      ["members", "p"],
      "members",
      "/projects/p/members",
    );
    try {
      await runtime.readProjection(members);
      const { targets } = mutationScopes(event("/projects/p/members/1", "PUT"));
      await runtime.invalidate(targets, { refetchType: "none" });
      await runtime.readProjection(members);
      expect(network).toHaveBeenCalledTimes(2);
    } finally {
      runtime.dispose();
    }
  });
});

describe("issue lifecycle mutation scopes", () => {
  it.each([
    ["DELETE", "/projects/p/issues/1"],
    ["POST", "/projects/p/issues/1/move"],
    ["POST", "/projects/p/issues/1/restore"],
  ])(
    "%s %s repairs another page's mutable children without refreshing fixed versions",
    async (method, path) => {
      let changed = false;
      const network = vi.fn(async (descriptor: ResourceDescriptor) => {
        if (changed && descriptor.policyId !== "spec-files-version") {
          throw new TodouError(404, "not_found", "Issue no longer available");
        }
        return { cached: true };
      });
      const runtime = new ResourceRuntime({ network });
      const spec = projection(
        ["spec", "p", 1],
        "spec",
        "/projects/p/issues/1/spec",
      );
      const questions = projection(
        ["questions", "p", 1],
        "questions",
        "/projects/p/issues/1/questions",
      );
      const current = projection(
        ["spec-files", "p", 1, "current"],
        "spec-files",
        "/projects/p/issues/1/spec/files",
      );
      const attachments: ProjectionDescriptor = {
        version: 1,
        kind: "direct",
        queryKey: ["attachments", "p", 1],
        queryHash: hashKey(["attachments", "p", 1]),
        resources: [
          resource("attachments", "/projects/p/attachments", {
            issue_number: 1,
          }),
        ],
      };
      const fixed: ProjectionDescriptor = {
        version: 1,
        kind: "direct",
        queryKey: ["spec-files", "p", 1, 3],
        queryHash: hashKey(["spec-files", "p", 1, 3]),
        resources: [
          resource("spec-files-version", "/projects/p/issues/1/spec/files", {
            version: 3,
          }),
        ],
      };
      const mutable = [spec, questions, current, attachments];
      const bridge = {
        mode: "worker" as const,
        ready: Promise.resolve(),
        control: async (_type: string, payload: Record<string, unknown>) =>
          runtime.invalidate(payload.targets as InvalidationTarget[], {
            refetchType: "none",
          }),
      };
      try {
        // Only the destination page seeded these reads; the writer has no cache.
        await Promise.all(
          [...mutable, fixed].map((entry) => runtime.readProjection(entry)),
        );
        changed = true;
        await invalidateRuntimeMutation(
          bridge,
          event(path, method, {
            data: { moved_to: { slug: "q", number: 2 } },
          }),
        );
        const results = await Promise.allSettled(
          mutable.map((entry) => runtime.readProjection(entry)),
        );
        expect(results.every((result) => result.status === "rejected")).toBe(
          true,
        );
        expect(network).toHaveBeenCalledTimes(9);
        expect(await runtime.readProjection(fixed)).toEqual({ cached: true });
        expect(network).toHaveBeenCalledTimes(9);
      } finally {
        runtime.dispose();
      }
    },
  );

  it("preserves ordinary update precision and includes both move addresses", () => {
    expect(
      mutationScopes(event("/projects/p/issues/1", "PATCH")).targets,
    ).not.toContainEqual({ type: "issue", slug: "p", number: 1 });
    const moved = mutationScopes(
      event("/projects/p/issues/1/move", "POST", {
        data: { moved_to: { slug: "q", number: 2 } },
      }),
    ).targets;
    expect(moved).toContainEqual({ type: "issue", slug: "p", number: 1 });
    expect(moved).toContainEqual({ type: "issue", slug: "q", number: 2 });
    expect(moved).toContainEqual({
      type: "key-prefix",
      queryKey: ["questions", "q", 2],
    });
    expect(moved).toContainEqual({
      type: "key-prefix",
      queryKey: ["attachments", "q", 2],
    });
    expect(
      mutationScopes(
        event("/projects/p/issues/1/move", "POST", {
          phase: "error",
          body: { to_project: "q" },
        }),
      ).targets,
    ).toContainEqual({ type: "project", slug: "q" });
  });
});
