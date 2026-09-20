import type { MutationLifecycleEvent } from "@todou/shared";
import type { RuntimeBridge } from "./bridge.ts";
import { canonical, type InvalidationTarget } from "./resources.ts";

export { type ReadMutationScope, readMutationAffects } from "./read-scope.ts";

export type MutationScopeEvent = Omit<MutationLifecycleEvent, "phase"> & {
  phase: "success" | "error" | "settled";
};

type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue =>
  value !== null && typeof value === "object" ? (value as RecordValue) : {};
const prefix = (...queryKey: unknown[]): InvalidationTarget => ({
  type: "key-prefix",
  queryKey,
});
const user = (): InvalidationTarget[] => [{ type: "user" }];
const project = (slug: string): InvalidationTarget[] => [
  { type: "project", slug },
  prefix("projects"),
  prefix("user-projects"),
];
const issue = (slug: string, number: number): InvalidationTarget[] => [
  prefix("issue", slug, number),
  prefix("issues", slug),
  prefix("timeline", slug, number),
  prefix("inbox"),
  prefix("user-issues"),
  prefix("search", slug),
  prefix("search-facets", slug),
  prefix("activity", slug),
  prefix("cross-activity"),
];
const spec = (slug: string, number: number): InvalidationTarget[] => [
  ...issue(slug, number),
  prefix("spec", slug, number),
  prefix("spec-files", slug, number, "current"),
  prefix("spec-comments", slug, number),
];
/** Delete, restore and move change whether every mutable child is reachable.
 * The issue scope covers shared resources even without a local projection;
 * page-owned children retain their explicit prefixes. Fixed spec versions
 * remain excluded by the runtime's issue-scope policy.
 */
const issueLifecycle = (slug: string, number: number): InvalidationTarget[] => [
  { type: "issue", slug, number },
  ...spec(slug, number),
  prefix("questions", slug, number),
  prefix("attachments", slug, number),
  prefix("issue-metadata", slug, number),
];
const decode = (value: string) => decodeURIComponent(value);

type ScopeRule = {
  id: string;
  methods: readonly string[];
  path: RegExp;
  /** Source evidence stays executable: inventory tests match concrete requests. */
  evidence: readonly string[];
  excluded?: true;
  targets: (
    event: MutationScopeEvent,
    match: RegExpExecArray,
  ) => InvalidationTarget[];
};

/** Runs on success and uncertain failure, including partial multi-request UI
 * flows. A later settled notification uses the same operation id and is
 * idempotent. Only scopes cross the worker boundary; bodies/results never do.
 */
export const MUTATION_SCOPE_REGISTRY: readonly ScopeRule[] = [
  {
    id: "tokens",
    methods: ["POST", "DELETE"],
    path: /^\/(?:me|agents\/[^/]+)\/tokens(?:\/[^/]+)?$/,
    evidence: [
      "pages/tokens-settings.tsx",
      "pages/agents-settings.tsx",
      "pages/cli-auth.tsx",
    ],
    excluded: true,
    targets: () => [],
  },
  {
    id: "cli-decision",
    methods: ["POST"],
    path: /^\/auth\/cli\/requests\/\d+\/(?:approve|deny)$/,
    evidence: ["pages/cli-auth.tsx"],
    targets: () => [prefix("cli-auth-request"), prefix("agents")],
  },
  {
    id: "auth",
    methods: ["POST", "PUT", "PATCH", "DELETE"],
    path: /^\/auth(?:\/|$)/,
    evidence: ["pages/login.tsx", "components/shell.tsx", "pages/cli-auth.tsx"],
    excluded: true,
    targets: () => [],
  },
  {
    id: "read-one",
    methods: ["PUT"],
    path: /^\/projects\/([^/]+)\/issues\/(\d+)\/read$/,
    evidence: ["api/reads.ts", "components/issue/mark-read-on-view.tsx"],
    targets: (_event, match) => [
      { type: "read", slug: decode(match[1]), number: Number(match[2]) },
    ],
  },
  {
    id: "read-sweep",
    methods: ["PUT"],
    path: /^\/me\/read$/,
    evidence: ["api/reads.ts"],
    targets: (event) => {
      const projects = record(event.body).projects;
      return Array.isArray(projects) &&
        projects.every((slug) => typeof slug === "string")
        ? projects.map((slug) => ({ type: "read", slug }))
        : [{ type: "read" }];
    },
  },
  {
    id: "prefs",
    methods: ["PATCH"],
    path: /^\/me\/prefs$/,
    evidence: ["api/prefs.ts"],
    targets: () => [prefix("me-prefs"), prefix("inbox")],
  },
  {
    id: "profile",
    methods: ["PATCH", "POST", "DELETE"],
    path: /^\/me(?:\/avatar)?$/,
    evidence: ["pages/profile-settings.tsx"],
    targets: user,
  },
  {
    id: "agents",
    methods: ["POST", "PATCH", "DELETE"],
    path: /^\/agents(?:\/\d+(?:\/(?:avatar|enable))?)?$/,
    evidence: ["pages/agents-settings.tsx", "pages/cli-auth.tsx"],
    targets: user,
  },
  {
    id: "project-create",
    methods: ["POST"],
    path: /^\/projects$/,
    evidence: ["pages/projects.tsx"],
    targets: () => [prefix("projects"), prefix("user-projects")],
  },
  {
    id: "project-settings",
    methods: ["PATCH", "DELETE"],
    path: /^\/projects\/([^/]+)$/,
    evidence: ["pages/project-settings.tsx"],
    targets: (event, match) => {
      const body = record(event.body);
      if ("slug" in body) return user();
      return [
        ...project(decode(match[1])),
        ...(Object.hasOwn(body, "block_clear_status_id")
          ? [prefix("issues"), prefix("issue")]
          : []),
      ];
    },
  },
  {
    id: "project-icon",
    methods: ["POST", "DELETE"],
    path: /^\/projects\/([^/]+)\/icon$/,
    evidence: ["pages/project-settings.tsx"],
    targets: (_event, match) => [
      ...project(decode(match[1])),
      prefix("agent-memberships"),
    ],
  },
  {
    id: "membership-access",
    methods: ["POST", "PUT", "DELETE"],
    path: /^\/projects\/([^/]+)\/(?:members|access-denials)(?:\/\d+)?$/,
    evidence: [
      "pages/project-settings.tsx",
      "pages/grant-access.tsx",
      "components/shared/agent-projects-dialog.tsx",
    ],
    targets: (_event, match) => [
      ...project(decode(match[1])),
      prefix("agent-memberships"),
      prefix("members", decode(match[1])),
      prefix("access-denials", decode(match[1])),
      prefix("inbox"),
    ],
  },
  {
    id: "project-taxonomy",
    methods: ["POST", "PATCH", "DELETE"],
    path: /^\/projects\/([^/]+)\/(?:statuses|labels)(?:\/\d+)?$/,
    evidence: [
      "pages/project-settings.tsx",
      "components/issue/label-picker.tsx",
    ],
    targets: (_event, match) => project(decode(match[1])),
  },
  {
    id: "references",
    methods: ["PUT", "POST", "DELETE"],
    path: /^\/projects\/([^/]+)\/references\/(?:format|autolinks(?:\/\d+)?)$/,
    evidence: ["pages/project-settings.tsx"],
    targets: (_event, match) => [
      prefix("reference-config", decode(match[1])),
      prefix("reference-directory"),
    ],
  },
  {
    id: "insights-settings",
    methods: ["PUT"],
    path: /^\/projects\/([^/]+)\/insights\/settings$/,
    evidence: ["api/insights.ts", "components/insights/insights-settings.tsx"],
    targets: (_event, match) => [
      prefix("insights-settings", decode(match[1])),
      prefix("insights-burn", decode(match[1])),
    ],
  },
  {
    id: "mutes",
    methods: ["PUT", "DELETE"],
    path: /^\/projects\/([^/]+)(?:\/issues\/(\d+))?\/mute$/,
    evidence: ["api/mutes.ts", "pages/new-issue.tsx"],
    targets: (_event, match) => [
      prefix("mutes"),
      prefix("inbox"),
      match[2] ? prefix("issues", decode(match[1])) : prefix("issues"),
    ],
  },
  {
    id: "issue-create",
    methods: ["POST"],
    path: /^\/projects\/([^/]+)\/issues$/,
    evidence: ["pages/new-issue.tsx"],
    targets: (event, match) => {
      const number = record(event.data).number;
      return typeof number === "number"
        ? issue(decode(match[1]), number)
        : [...project(decode(match[1])), prefix("inbox")];
    },
  },
  {
    id: "issue-move",
    methods: ["POST"],
    path: /^\/projects\/([^/]+)\/issues\/(\d+)\/move$/,
    evidence: ["api/issues.ts"],
    targets: (event, match) => {
      const moved = record(record(event.data).moved_to);
      return [
        ...issueLifecycle(decode(match[1]), Number(match[2])),
        ...(typeof moved.slug === "string" && typeof moved.number === "number"
          ? issueLifecycle(moved.slug, moved.number)
          : typeof record(event.body).to_project === "string"
            ? project(record(event.body).to_project as string)
            : user()),
        prefix("search-issue-ref"),
        prefix("search-comment-ref"),
        prefix("search-comment-location"),
      ];
    },
  },
  {
    id: "issue-edit",
    methods: ["PATCH", "DELETE", "POST"],
    path: /^\/projects\/([^/]+)\/issues\/(\d+)(?:\/restore)?$/,
    evidence: [
      "api/issues.ts",
      "api/board.ts",
      "pages/issue-detail.tsx",
      "pages/new-issue.tsx",
    ],
    targets: (event, match) => [
      ...(event.method.toUpperCase() === "DELETE" ||
      event.path.endsWith("/restore")
        ? issueLifecycle(decode(match[1]), Number(match[2]))
        : issue(decode(match[1]), Number(match[2]))),
      prefix("search-issue-ref"),
      prefix("search-comment-ref"),
      prefix("search-comment-location"),
    ],
  },
  {
    id: "blocks",
    methods: ["POST", "DELETE"],
    path: /^\/projects\/([^/]+)\/issues\/(\d+)\/(?:blocks|blocked-by)(?:\/\d+)?$/,
    evidence: ["api/issues.ts", "components/issue/staged-blocks.tsx"],
    targets: (_event, match) => [
      ...issue(decode(match[1]), Number(match[2])),
      prefix("issues"),
      prefix("issue"),
    ],
  },
  {
    id: "metadata",
    methods: ["PATCH"],
    path: /^\/projects\/([^/]+)\/issues\/(\d+)\/metadata$/,
    evidence: ["api/metadata.ts"],
    targets: (_event, match) => [
      prefix("issue-metadata", decode(match[1]), Number(match[2])),
    ],
  },
  {
    id: "comments-commands-answers",
    methods: ["POST", "PATCH", "DELETE"],
    path: /^\/projects\/([^/]+)\/issues\/(\d+)\/(?:commands|comments(?:\/(?:hide|\d+(?:\/answers)?))?)$/,
    evidence: [
      "components/timeline/composer.tsx",
      "components/timeline/comment-item.tsx",
      "components/timeline/questions-card.tsx",
    ],
    targets: (_event, match) => [
      ...issue(decode(match[1]), Number(match[2])),
      prefix("questions", decode(match[1]), Number(match[2])),
      prefix("search-issue-ref"),
      prefix("search-comment-ref"),
      prefix("search-comment-location"),
    ],
  },
  {
    id: "spec",
    methods: ["POST"],
    path: /^\/projects\/([^/]+)\/issues\/(\d+)\/spec\/(?:push|withdraw|reviews|comments\/resolve)$/,
    evidence: [
      "api/spec.ts",
      "components/spec/review-submit.tsx",
      "components/spec/spec-review-session-provider.tsx",
      "components/timeline/spec-comment-card.tsx",
      "pages/spec-view.tsx",
    ],
    targets: (_event, match) => spec(decode(match[1]), Number(match[2])),
  },
  {
    id: "attachments",
    methods: ["POST", "DELETE"],
    path: /^\/projects\/([^/]+)\/attachments(?:\/(?:direct-uploads(?:\/[^/]+\/complete)?|[^/]+))?$/,
    evidence: [
      "components/issue/staged-files.tsx",
      "projects/shared/src/client.ts",
    ],
    targets: (_event, match) => [prefix("attachments", decode(match[1]))],
  },
];

export function mutationScopes(event: MutationScopeEvent): {
  rule: string;
  targets: InvalidationTarget[];
  excluded: boolean;
} {
  const method = event.method.toUpperCase();
  if (["GET", "HEAD", "OPTIONS"].includes(method))
    return { rule: "read", targets: [], excluded: true };
  if (event.path.endsWith("/move") && record(event.body).dry_run === true) {
    return { rule: "move-preview", targets: [], excluded: true };
  }
  for (const rule of MUTATION_SCOPE_REGISTRY) {
    const match = rule.path.exec(event.path);
    if (!match || !rule.methods.includes(method)) continue;
    try {
      const targets = rule.targets(event, match);
      return {
        rule: rule.id,
        targets: [
          ...new Map(
            targets.map((target) => [canonical(target), target]),
          ).values(),
        ],
        excluded: rule.excluded ?? false,
      };
    } catch {
      break;
    }
  }
  // A newly added or malformed business route cannot leave existing shared
  // values fresh indefinitely just because this page owns no matching query.
  return { rule: "unknown", targets: user(), excluded: false };
}

export async function invalidateRuntimeMutation(
  runtime: Pick<RuntimeBridge, "ready" | "mode" | "control">,
  event: MutationScopeEvent,
): Promise<void> {
  const { targets } = mutationScopes(event);
  if (!targets.length) return;
  await runtime.ready;
  if (runtime.mode !== "worker") return;
  const operationId =
    event.context.operationId ??
    `mutation:${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}:${Math.random()}`}`;
  // No write is ever delegated or replayed here. Failure only means the
  // read-side repair could not finish; it cannot replace the HTTP outcome.
  await runtime
    .control("INVALIDATE", {
      operationId,
      source: "mutation",
      targets,
      refetchType: "active",
      completion: "dirty-applied",
    })
    .catch(() => {});
}
