import {
  dataTagSymbol,
  hashKey,
  type InfiniteData,
} from "@tanstack/react-query";
import type { TimelineItem, TimelinePage, TodouClient } from "@todou/shared";
import { describe, expect, expectTypeOf, it } from "vitest";
import {
  attachmentsQuery,
  attachmentTextQuery,
} from "../src/api/attachments.ts";
import { boardColumnQuery } from "../src/api/board.ts";
import { inboxQuery } from "../src/api/inbox.ts";
import {
  type IssueSearch,
  issueCountsQuery,
  issueGroupQuery,
  issueQuery,
  issuesQuery,
} from "../src/api/issues.ts";
import { issueListDescriptorOf } from "../src/api/issues-cache.ts";
import { issueMetadataQuery } from "../src/api/metadata.ts";
import { prefsQuery } from "../src/api/prefs.ts";
import {
  accessDenialsQuery,
  agentMembershipsQuery,
  agentsQuery,
  authModeQuery,
  cliAuthRequestQuery,
  labelsQuery,
  membersQuery,
  meQuery,
  projectQuery,
  projectsQuery,
  statusesQuery,
  versionQuery,
} from "../src/api/queries.ts";
import { questionsQuery } from "../src/api/questions.ts";
import {
  defineProjection,
  type ProjectionDescriptor,
  projectionId,
} from "../src/api/runtime/projections.ts";
import { runtimeProjection } from "../src/api/runtime/query-adapter.ts";
import {
  networkResource,
  policyFor,
  type ResourceDescriptor,
  type ResourcePolicyId,
  type ResourceQuery,
  resource,
  resourceId,
  validateResource,
} from "../src/api/runtime/resources.ts";
import {
  latestSpecPushQuery,
  specCommentsQuery,
  specFilesQuery,
  specQuery,
  specVersionStatsQuery,
} from "../src/api/spec.ts";
import {
  allCommentsQuery,
  type TimelinePageParam,
  timelineHeadOptions,
  timelineProjection,
  timelineTailOptions,
} from "../src/api/timeline.ts";
import { userQuery } from "../src/api/users.ts";

it("keeps disabled unresolved route parameters page-owned without weakening resource validation", () => {
  const placeholders = [
    projectQuery(""),
    statusesQuery(""),
    labelsQuery(""),
    membersQuery(""),
    issueQuery("", 0),
    issueQuery("alpha", 0),
    issuesQuery("", {}),
    issueGroupQuery("", 1, {}),
    issueCountsQuery("", {}),
    boardColumnQuery("", 1),
    attachmentsQuery("", 0),
    attachmentsQuery("alpha", 0),
    questionsQuery("", 0),
    specQuery("", 0),
    specFilesQuery("alpha", 7, 0),
  ];
  for (const options of placeholders) {
    expect(runtimeProjection(options)).toBeUndefined();
    expect(options.queryFn).toBeTypeOf("function");
  }
  expect(issueQuery("", 0).queryKey).toEqual(["issue", "", 0]);
  expect(specFilesQuery("alpha", 7, 0).queryKey).toEqual([
    "spec-files",
    "alpha",
    7,
    0,
  ]);
  expect(() => resource("project", "/projects/")).toThrow();
  expect(() =>
    resource("spec-files-version", "/projects/alpha/issues/7/spec/files", {
      version: 0,
    }),
  ).toThrow();
});

const SLUG = "alpha";
const NUMBER = 7;
const ROOT = `/projects/${SLUG}`;
const ISSUE = `${ROOT}/issues/${NUMBER}`;
type Options = { queryKey: readonly unknown[]; meta?: Record<string, unknown> };
type QueryData<T extends Options> = T["queryKey"] extends {
  [dataTagSymbol]: infer Data;
}
  ? Data
  : never;
type ApiData<M extends keyof TodouClient> = TodouClient[M] extends (
  ...args: never[]
) => infer Result
  ? Awaited<Result>
  : never;

/** A missing declaration must fail, rather than disappear from a filtered census. */
function registered(options: Options): ProjectionDescriptor {
  const projection = runtimeProjection(options);
  expect(
    projection,
    `missing runtime declaration: ${JSON.stringify(options.queryKey)}`,
  ).toBeDefined();
  if (projection === undefined) throw new Error("Missing runtime projection");
  expect(projection.queryKey).toEqual(options.queryKey);
  expect(projection.queryHash).toBe(hashKey(options.queryKey));
  expect(projection.version).toBe(1);
  expect(defineProjection(projection)).toBe(projection);
  expect(structuredClone(projection)).toEqual(projection);
  return projection;
}

type MinimumCase = {
  name: string;
  options: Options;
  key: readonly unknown[];
  kind: ProjectionDescriptor["kind"];
  policy: ResourcePolicyId;
  path: string;
  query?: ResourceQuery;
  freshness: number;
};

const simpleCases: MinimumCase[] = [
  {
    name: "projects",
    options: projectsQuery,
    key: ["projects"],
    kind: "direct",
    policy: "projects",
    path: "/projects",
    freshness: 60_000,
  },
  {
    name: "project",
    options: projectQuery(SLUG),
    key: ["project", SLUG],
    kind: "direct",
    policy: "project",
    path: ROOT,
    freshness: 60_000,
  },
  {
    name: "statuses",
    options: statusesQuery(SLUG),
    key: ["statuses", SLUG],
    kind: "direct",
    policy: "statuses",
    path: `${ROOT}/statuses`,
    freshness: 60_000,
  },
  {
    name: "labels",
    options: labelsQuery(SLUG),
    key: ["labels", SLUG],
    kind: "direct",
    policy: "labels",
    path: `${ROOT}/labels`,
    freshness: 60_000,
  },
  {
    name: "members",
    options: membersQuery(SLUG),
    key: ["members", SLUG],
    kind: "direct",
    policy: "members",
    path: `${ROOT}/members`,
    freshness: 60_000,
  },
  {
    name: "inbox",
    options: inboxQuery,
    key: ["inbox"],
    kind: "direct",
    policy: "inbox",
    path: "/me/inbox",
    freshness: 5_000,
  },
  {
    name: "prefs",
    options: prefsQuery,
    key: ["me-prefs"],
    kind: "direct",
    policy: "prefs",
    path: "/me/prefs",
    freshness: 60_000,
  },
  {
    name: "issue",
    options: issueQuery(SLUG, NUMBER),
    key: ["issue", SLUG, NUMBER],
    kind: "direct",
    policy: "issue",
    path: ISSUE,
    freshness: 5_000,
  },
  {
    name: "questions",
    options: questionsQuery(SLUG, NUMBER),
    key: ["questions", SLUG, NUMBER],
    kind: "direct",
    policy: "questions",
    path: `${ISSUE}/questions`,
    freshness: 5_000,
  },
  {
    name: "attachments",
    options: attachmentsQuery(SLUG, NUMBER),
    key: ["attachments", SLUG, NUMBER],
    kind: "direct",
    policy: "attachments",
    path: `${ROOT}/attachments`,
    query: { issue_number: NUMBER },
    freshness: 5_000,
  },
  {
    name: "spec overview",
    options: specQuery(SLUG, NUMBER),
    key: ["spec", SLUG, NUMBER],
    kind: "spec",
    policy: "spec",
    path: `${ISSUE}/spec`,
    freshness: 5_000,
  },
  {
    name: "current spec files",
    options: specFilesQuery(SLUG, NUMBER),
    key: ["spec-files", SLUG, NUMBER, "current"],
    kind: "spec-files",
    policy: "spec-files",
    path: `${ISSUE}/spec/files`,
    query: { version: undefined },
    freshness: 5_000,
  },
  {
    name: "fixed spec files",
    options: specFilesQuery(SLUG, NUMBER, 3),
    key: ["spec-files", SLUG, NUMBER, 3],
    kind: "spec-files",
    policy: "spec-files-version",
    path: `${ISSUE}/spec/files`,
    query: { version: 3 },
    freshness: Number.POSITIVE_INFINITY,
  },
];

const search: IssueSearch = {
  q: "cache",
  category: "closed",
  status: "2,3",
  label: "4,5",
  assignee: 6,
  sort: "number",
  order: "asc",
  group: "none",
};
const listCases = [
  {
    name: "flat filtered list",
    options: issuesQuery(SLUG, search),
    key: ["issues", SLUG, search],
    kind: "list",
    policy: "issues",
    path: `${ROOT}/issues`,
    query: {
      q: "cache",
      category: "closed",
      status: [2, 3],
      label: [4, 5],
      assignee: 6,
      sort: "number",
      order: "asc",
    },
    issueList: {
      kind: "page",
      filter: {
        q: "cache",
        category: "closed",
        status: [2, 3],
        label: [4, 5],
        assignee: 6,
      },
    },
  },
  {
    name: "group pins status and preserves other filters",
    options: issueGroupQuery(SLUG, 8, search),
    key: [
      "issues",
      SLUG,
      { group: 8 },
      { q: "cache", label: "4,5", assignee: 6, sort: "number", order: "asc" },
    ],
    kind: "list",
    policy: "issues",
    path: `${ROOT}/issues`,
    query: {
      status: [8],
      q: "cache",
      label: [4, 5],
      assignee: 6,
      sort: "number",
      order: "asc",
    },
    issueList: {
      kind: "page",
      filter: { status: [8], q: "cache", label: [4, 5], assignee: 6 },
    },
  },
  {
    name: "counts span categories and omit ordering",
    options: issueCountsQuery(SLUG, search),
    key: [
      "issues",
      SLUG,
      "counts",
      { q: "cache", status: "2,3", label: "4,5", assignee: 6 },
    ],
    kind: "counts",
    policy: "issue-counts",
    path: `${ROOT}/issues/counts`,
    query: { q: "cache", status: [2, 3], label: [4, 5], assignee: 6 },
    issueList: {
      kind: "counts",
      filter: { q: "cache", status: [2, 3], label: [4, 5], assignee: 6 },
    },
  },
  {
    name: "board column keeps its 100-row updated window",
    options: boardColumnQuery(SLUG, 8),
    key: ["issues", SLUG, { board: 8 }],
    kind: "list",
    policy: "issues",
    path: `${ROOT}/issues`,
    query: { status: [8], limit: 100, sort: "updated", order: "desc" },
    issueList: { kind: "page", filter: { status: [8] } },
  },
  {
    name: "trash ignores live category and chip filters",
    options: issuesQuery(SLUG, { ...search, deleted: true }),
    key: ["issues", SLUG, { ...search, deleted: true }],
    kind: "list",
    policy: "issues",
    path: `${ROOT}/issues`,
    query: { q: "cache", deleted: true },
    issueList: { kind: "page", filter: { q: "cache", deleted: true } },
  },
];

describe("minimum runtime query registry", () => {
  it.each(simpleCases)(
    "registers $name with its original key and cache policy",
    ({ options, key, kind, policy, path, query, freshness }) => {
      const projection = registered(options);
      expect(options.queryKey).toEqual(key);
      expect(projection.kind).toBe(kind);
      expect(projection.resources).toEqual([
        {
          apiMount: "/api",
          representation: "json",
          policyVersion: 1,
          policyId: policy,
          path,
          query,
        },
      ]);
      expect(
        policyFor(projection.resources[0] as ResourceDescriptor),
      ).toMatchObject({
        cacheable: true,
        freshnessMs: freshness,
        retryOwner: "runtime",
      });
    },
  );

  it.each(listCases)(
    "registers $name without losing the invalidation descriptor",
    ({ options, key, kind, policy, path, query, issueList }) => {
      const projection = registered(options);
      expect(options.queryKey).toEqual(key);
      expect(projection.kind).toBe(kind);
      expect(projection.resources).toEqual([
        {
          apiMount: "/api",
          representation: "json",
          policyVersion: 1,
          policyId: policy,
          path,
          query,
        },
      ]);
      expect(issueListDescriptorOf(options.meta)).toEqual(issueList);
      expect(projection.meta?.issueList).toEqual(issueList);
      expect(
        policyFor(projection.resources[0] as ResourceDescriptor).freshnessMs,
      ).toBe(5_000);
    },
  );

  it("registers distinct timeline recipes with full initial read and window identity", () => {
    const tail = timelineTailOptions(SLUG, NUMBER);
    const head = timelineHeadOptions(SLUG, NUMBER, false);
    const all = allCommentsQuery(SLUG, NUMBER);
    expect(head.enabled).toBe(false);
    expect(timelineHeadOptions(SLUG, NUMBER, true).enabled).toBe(true);
    const recipes = [
      {
        options: tail,
        suffix: "tail",
        kind: "timeline-tail",
        query: { include_hidden: true, limit: 50, last: 1 },
        initial: { dir: "init" },
      },
      {
        options: head,
        suffix: "head",
        kind: "timeline-head",
        query: { include_hidden: true, limit: 50 },
        initial: { dir: "init-head" },
      },
      {
        options: all,
        suffix: "all",
        kind: "timeline-all",
        query: { types: "comment,question_answered", limit: 100 },
        initial: undefined,
      },
    ];
    for (const { options, suffix, kind, query, initial } of recipes) {
      const projection = registered(options);
      expect(options.queryKey).toEqual(["timeline", SLUG, NUMBER, suffix]);
      expect(projection.kind).toBe(kind);
      expect(projection.resources).toEqual([
        {
          apiMount: "/api",
          representation: "json",
          policyVersion: 1,
          policyId: "timeline",
          path: `${ISSUE}/timeline`,
          query,
        },
      ]);
      if (initial) {
        expect(projection.windowDescriptor).toMatchObject({
          initialPageParam: initial,
          pageParams: [initial],
          depth: 1,
        });
      } else expect(projection.windowDescriptor).toBeUndefined();
    }
    const projections = recipes.map(({ options }) => registered(options));
    expect(new Set(projections.map(projectionId)).size).toBe(3);
    expect(
      new Set(
        projections.flatMap((projection) =>
          projection.resources.map((item) => resourceId(item)),
        ),
      ).size,
    ).toBe(3);
  });

  it("preserves original tagged response types across registration", () => {
    const project = projectQuery(SLUG);
    const statuses = statusesQuery(SLUG);
    const labels = labelsQuery(SLUG);
    const members = membersQuery(SLUG);
    const issue = issueQuery(SLUG, NUMBER);
    const issues = issuesQuery(SLUG, {});
    const group = issueGroupQuery(SLUG, 1, {});
    const board = boardColumnQuery(SLUG, 1);
    const counts = issueCountsQuery(SLUG, {});
    const questions = questionsQuery(SLUG, NUMBER);
    const attachments = attachmentsQuery(SLUG, NUMBER);
    const spec = specQuery(SLUG, NUMBER);
    const files = specFilesQuery(SLUG, NUMBER);
    const tail = timelineTailOptions(SLUG, NUMBER);
    const head = timelineHeadOptions(SLUG, NUMBER, false);
    const comments = allCommentsQuery(SLUG, NUMBER);
    expectTypeOf<QueryData<typeof projectsQuery>>().toEqualTypeOf<
      ApiData<"listProjects">
    >();
    expectTypeOf<QueryData<typeof project>>().toEqualTypeOf<
      ApiData<"getProject">
    >();
    expectTypeOf<QueryData<typeof statuses>>().toEqualTypeOf<
      ApiData<"listStatuses">
    >();
    expectTypeOf<QueryData<typeof labels>>().toEqualTypeOf<
      ApiData<"listLabels">
    >();
    expectTypeOf<QueryData<typeof members>>().toEqualTypeOf<
      ApiData<"listMembers">
    >();
    expectTypeOf<QueryData<typeof inboxQuery>>().toEqualTypeOf<
      ApiData<"getInbox">
    >();
    expectTypeOf<QueryData<typeof prefsQuery>>().toEqualTypeOf<
      ApiData<"getMyPrefs">
    >();
    expectTypeOf<QueryData<typeof issue>>().toEqualTypeOf<
      ApiData<"getIssue">
    >();
    expectTypeOf<QueryData<typeof issues>>().toEqualTypeOf<
      ApiData<"listIssues">
    >();
    expectTypeOf<QueryData<typeof group>>().toEqualTypeOf<
      ApiData<"listIssues">
    >();
    expectTypeOf<QueryData<typeof board>>().toEqualTypeOf<
      ApiData<"listIssues">
    >();
    expectTypeOf<QueryData<typeof counts>>().toEqualTypeOf<
      ApiData<"getIssueCounts">
    >();
    expectTypeOf<QueryData<typeof questions>>().toEqualTypeOf<
      ApiData<"getIssueQuestions">
    >();
    expectTypeOf<QueryData<typeof attachments>>().toEqualTypeOf<
      ApiData<"listAttachments">
    >();
    expectTypeOf<
      QueryData<typeof spec>
    >().toEqualTypeOf<ApiData<"getSpec"> | null>();
    expectTypeOf<QueryData<typeof files>>().toEqualTypeOf<
      ApiData<"getSpecFiles">
    >();
    expectTypeOf<QueryData<typeof tail>>().toEqualTypeOf<
      InfiniteData<TimelinePage>
    >();
    expectTypeOf<QueryData<typeof head>>().toEqualTypeOf<
      InfiniteData<TimelinePage>
    >();
    expectTypeOf<QueryData<typeof comments>>().toEqualTypeOf<TimelineItem[]>();
  });

  it("keeps filters, status columns, sort order, projects and issues separate", () => {
    const variants = [
      issuesQuery(SLUG, {}),
      issuesQuery(SLUG, { category: "closed" }),
      issuesQuery(SLUG, { category: "all" }),
      issuesQuery(SLUG, { q: "cache" }),
      issuesQuery(SLUG, { status: "2" }),
      issuesQuery(SLUG, { label: "4" }),
      issuesQuery(SLUG, { assignee: 6 }),
      issuesQuery(SLUG, { sort: "number" }),
      issuesQuery(SLUG, { order: "asc" }),
      issuesQuery(SLUG, { deleted: true }),
      issuesQuery("beta", {}),
      issueGroupQuery(SLUG, 1, {}),
      issueGroupQuery(SLUG, 2, {}),
      issueCountsQuery(SLUG, {}),
      boardColumnQuery(SLUG, 1),
      boardColumnQuery(SLUG, 2),
      issueQuery(SLUG, NUMBER),
      issueQuery(SLUG, NUMBER + 1),
      attachmentsQuery(SLUG, NUMBER),
      attachmentsQuery(SLUG, NUMBER + 1),
    ].map(registered);
    expect(
      new Set(variants.map((projection) => projection.queryHash)).size,
    ).toBe(variants.length);
    expect(new Set(variants.map(projectionId)).size).toBe(variants.length);
    expect(
      new Set(
        variants.map((projection) =>
          resourceId(projection.resources[0] as ResourceDescriptor),
        ),
      ).size,
    ).toBe(variants.length);
  });

  it("keeps mutable current files separate from every immutable version", () => {
    const projections = [
      specFilesQuery(SLUG, NUMBER),
      specFilesQuery(SLUG, NUMBER, 1),
      specFilesQuery(SLUG, NUMBER, 2),
    ].map(registered);
    expect(new Set(projections.map(projectionId)).size).toBe(3);
    expect(
      new Set(
        projections.map((projection) =>
          resourceId(projection.resources[0] as ResourceDescriptor),
        ),
      ).size,
    ).toBe(3);
    expect(specFilesQuery(SLUG, NUMBER).staleTime).toBe(5_000);
    expect(specFilesQuery(SLUG, NUMBER, 1).staleTime).toBe(
      Number.POSITIVE_INFINITY,
    );
  });

  it("does not merge timeline windows with different loaded depths or cursors", () => {
    const params: TimelinePageParam[][] = [
      [{ dir: "init" }],
      [{ dir: "init" }, { dir: "after", cursor: "newer-a" }],
      [{ dir: "init" }, { dir: "after", cursor: "newer-b" }],
      [{ dir: "before", cursor: "older" }, { dir: "init" }],
    ];
    const projections = params.map((window) =>
      timelineProjection(SLUG, NUMBER, "tail", window),
    );
    expect(
      new Set(projections.map((projection) => projection.queryHash)).size,
    ).toBe(1);
    expect(new Set(projections.map(projectionId)).size).toBe(params.length);
  });

  it("keeps identity, raw downloads and undeclared complex builders page-owned", () => {
    const excluded: Options[] = [
      meQuery,
      authModeQuery,
      versionQuery,
      cliAuthRequestQuery("example-code"),
      accessDenialsQuery(SLUG),
      agentsQuery,
      agentMembershipsQuery,
      issueMetadataQuery(SLUG, NUMBER),
      attachmentTextQuery("/api/attachments/example"),
      userQuery("user"),
      latestSpecPushQuery(SLUG, NUMBER),
      specCommentsQuery(SLUG, NUMBER),
      specVersionStatsQuery(SLUG, NUMBER, {
        version: 2,
        message: null,
        added: [],
        changed: ["design.md"],
        removed: [],
      }),
    ];
    for (const options of excluded)
      expect(runtimeProjection(options)).toBeUndefined();
    expect(meQuery.retry).toBe(false);
    expect(cliAuthRequestQuery("example-code").retry).toBe(false);
    expect(attachmentTextQuery("/api/attachments/example").staleTime).toBe(
      Number.POSITIVE_INFINITY,
    );
    expect(
      policyFor(networkResource(`${ISSUE}/metadata`, { namespace: "agent" })),
    ).toMatchObject({ cacheable: false, freshnessMs: 0, retryOwner: "page" });
  });
});

describe("explicit resource policy registration", () => {
  it("rejects unknown policies at both the type and runtime boundaries", () => {
    // @ts-expect-error No unknown policy may request completed-value caching.
    const policy: ResourcePolicyId = "unregistered";
    const invalid = {
      ...resource("issues", `${ROOT}/issues`),
      policyId: policy,
    };
    expect(() => validateResource(invalid)).toThrow(TypeError);
    expect(() => policyFor(invalid)).toThrow(TypeError);
    expect(() => resourceId(invalid)).toThrow(TypeError);
    expect(() =>
      defineProjection({
        kind: "direct",
        version: 1,
        queryKey: ["unknown"],
        queryHash: "unknown",
        resources: [invalid],
      }),
    ).toThrow(TypeError);
    expect(() => resource(policy, `${ROOT}/issues`)).toThrow(TypeError);
  });

  it("rejects incompatible paths and mutable resources disguised as immutable", () => {
    expect(() => resource("projects", "/me")).toThrow(TypeError);
    expect(() => resource("spec-files-version", `${ISSUE}/spec/files`)).toThrow(
      TypeError,
    );
    expect(() =>
      resource("spec-files-version", `${ISSUE}/spec/files`, { version: 0 }),
    ).toThrow(TypeError);
    expect(() =>
      resource("spec-files-version", `${ISSUE}/spec/files`, {
        version: "current",
      }),
    ).toThrow(TypeError);
    expect(() =>
      resource("spec-files", `${ISSUE}/spec/files`, { version: 1 }),
    ).toThrow(TypeError);
    expect(() => resource("attachments", `${ROOT}/attachments`)).toThrow(
      TypeError,
    );
  });

  it("keeps policy, mount, namespace, cursor and limit in resource identity", () => {
    const variants = [
      resource("issues", `${ROOT}/issues`),
      resource("issues", `${ROOT}/issues`, { cursor: "page-a" }),
      resource("issues", `${ROOT}/issues`, { cursor: "page-b" }),
      resource("issues", `${ROOT}/issues`, { limit: 20 }),
      resource("issues", `${ROOT}/issues`, { limit: 100 }),
      resource("issues", `${ROOT}/issues`, undefined, "/other-api"),
      networkResource(`${ROOT}/issues`),
      resource("no-store", `${ROOT}/issues`),
      networkResource(`${ISSUE}/metadata`, { namespace: "agent" }),
      networkResource(`${ISSUE}/metadata`, { namespace: "other" }),
    ];
    expect(new Set(variants.map((item) => resourceId(item))).size).toBe(
      variants.length,
    );
    expect(resourceId(variants[0] as ResourceDescriptor, 1)).not.toBe(
      resourceId(variants[0] as ResourceDescriptor, 2),
    );
    expect(policyFor(networkResource(`${ROOT}/issues`)).cacheable).toBe(false);
    expect(policyFor(resource("no-store", `${ROOT}/issues`)).cacheable).toBe(
      false,
    );
  });
});
