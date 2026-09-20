import type { TimelinePage } from "@todou/shared";
import {
  canonical,
  type ResourceDescriptor,
  resource,
  validateResource,
} from "./resources.ts";
import {
  drainTimelineComments,
  rebuildTimelineWindow,
  type TimelinePageParam,
  type TimelineWindow,
  timelineAllQuery,
  timelinePageQuery,
  timelineWindow,
} from "./timeline.ts";

export {
  latestNextCursor,
  nextTimelinePageParam as nextTimelinePage,
  previousTimelinePageParam as previousTimelinePage,
  READS as TIMELINE_READS,
  TIMELINE_PAGE_LIMIT,
  type TimelinePageParam,
  type TimelineWindow,
} from "./timeline.ts";

export type ProjectionKind =
  | "direct"
  | "list"
  | "counts"
  | "spec"
  | "spec-files"
  | "timeline-tail"
  | "timeline-head"
  | "timeline-all";
export interface ProjectionDescriptor {
  kind: ProjectionKind;
  version: 1;
  queryKey: readonly unknown[];
  queryHash: string;
  params?: Record<string, unknown>;
  resources: ResourceDescriptor[];
  meta?: { issueList?: unknown };
  windowDescriptor?: TimelineWindow;
}
export type ProjectionRead = <T = unknown>(
  descriptor: ResourceDescriptor,
) => Promise<T>;
const KINDS: Record<ProjectionKind, true> = {
  direct: true,
  list: true,
  counts: true,
  spec: true,
  "spec-files": true,
  "timeline-tail": true,
  "timeline-head": true,
  "timeline-all": true,
};

export function defineProjection<T extends ProjectionDescriptor>(
  descriptor: T,
): T {
  if (
    !descriptor ||
    !Object.hasOwn(KINDS, descriptor.kind) ||
    descriptor.version !== 1 ||
    !Array.isArray(descriptor.queryKey) ||
    typeof descriptor.queryHash !== "string" ||
    descriptor.queryHash.length === 0 ||
    !Array.isArray(descriptor.resources) ||
    descriptor.resources.length !== 1
  )
    throw new TypeError("Invalid projection descriptor");
  for (const item of descriptor.resources) validateResource(item);
  if (
    descriptor.kind.startsWith("timeline-") &&
    descriptor.resources[0]?.policyId !== "timeline"
  )
    throw new TypeError("Timeline recipe requires a timeline resource");
  if (
    descriptor.kind === "spec" &&
    descriptor.resources[0]?.policyId !== "spec"
  )
    throw new TypeError("Spec recipe requires a spec resource");
  if (
    descriptor.kind === "spec-files" &&
    !["spec-files", "spec-files-version"].includes(
      descriptor.resources[0]?.policyId ?? "",
    )
  )
    throw new TypeError("Spec files recipe requires a files resource");
  if (descriptor.windowDescriptor !== undefined) {
    const params = descriptor.windowDescriptor.pageParams;
    if (!Array.isArray(params) || params.length === 0 || params.length > 2000)
      throw new TypeError("Invalid timeline window");
    if (
      descriptor.windowDescriptor.depth !== undefined &&
      (!Number.isSafeInteger(descriptor.windowDescriptor.depth) ||
        descriptor.windowDescriptor.depth < 1 ||
        descriptor.windowDescriptor.depth > 2000)
    )
      throw new TypeError("Invalid timeline depth");
    for (const param of params) {
      if (
        !param ||
        !["init", "init-head", "before", "after"].includes(param.dir) ||
        ((param.dir === "before" || param.dir === "after") &&
          (typeof param.cursor !== "string" || !param.cursor))
      )
        throw new TypeError("Invalid timeline page parameter");
    }
  }
  if (canonical(descriptor).length > 262_144)
    throw new TypeError("Projection descriptor too large");
  return descriptor;
}
export function projectionId(descriptor: ProjectionDescriptor): string {
  defineProjection(descriptor);
  return canonical([
    descriptor.queryHash,
    descriptor.kind,
    descriptor.version,
    descriptor.resources,
    descriptor.params,
    descriptor.windowDescriptor,
  ]);
}
export function timelineResource(
  slug: string,
  issueNumber: number,
  pageParam: TimelinePageParam,
  kind: "tail" | "head" = "tail",
  apiMount = "/api",
): ResourceDescriptor {
  const { last, ...query } = timelinePageQuery(pageParam, kind);
  return resource(
    "timeline",
    `/projects/${slug}/issues/${issueNumber}/timeline`,
    { ...query, ...(last ? { last: 1 } : {}) },
    apiMount,
  );
}
export function timelineAllResource(
  slug: string,
  issueNumber: number,
  after?: string,
  apiMount = "/api",
): ResourceDescriptor {
  return resource(
    "timeline",
    `/projects/${slug}/issues/${issueNumber}/timeline`,
    timelineAllQuery(after),
    apiMount,
  );
}
export function timelinePageResource(
  base: ResourceDescriptor,
  param: TimelinePageParam,
  kind: "timeline-tail" | "timeline-head",
): ResourceDescriptor {
  const {
    before: _before,
    after: _after,
    last: _last,
    ...query
  } = base.query ?? {};
  const { last, ...pageQuery } = timelinePageQuery(
    param,
    kind === "timeline-tail" ? "tail" : "head",
  );
  return resource(
    "timeline",
    base.path,
    { ...query, ...pageQuery, ...(last ? { last: 1 } : {}) },
    base.apiMount,
  );
}

/** Recipes consume authorized resources only; no page callbacks or optimistic seeds. */
export async function executeProjection(
  descriptor: ProjectionDescriptor,
  read: ProjectionRead,
): Promise<unknown> {
  defineProjection(descriptor);
  const base = descriptor.resources[0];
  if (!base) throw new TypeError("Projection needs a resource");
  if (descriptor.kind === "timeline-all") {
    return drainTimelineComments((after) =>
      read<TimelinePage>(
        resource("timeline", base.path, timelineAllQuery(after), base.apiMount),
      ),
    );
  }
  if (
    descriptor.kind === "timeline-tail" ||
    descriptor.kind === "timeline-head"
  ) {
    const kind = descriptor.kind;
    return rebuildTimelineWindow(
      descriptor.windowDescriptor ??
        timelineWindow(kind === "timeline-tail" ? "tail" : "head"),
      (param) => read<TimelinePage>(timelinePageResource(base, param, kind)),
    );
  }
  try {
    return await read(base);
  } catch (error) {
    const failure = error as { status?: number; kind?: string; name?: string };
    if (
      descriptor.kind === "spec" &&
      failure.status === 404 &&
      failure.name !== "MovedError" &&
      failure.name !== "GoneError" &&
      failure.kind !== "moved" &&
      failure.kind !== "gone"
    )
      return null;
    if (
      descriptor.kind === "spec-files" &&
      failure.status !== 404 &&
      failure.name !== "MovedError" &&
      failure.name !== "GoneError" &&
      failure.kind !== "moved" &&
      failure.kind !== "gone" &&
      (failure.name === "TodouError" ||
        failure.name === "TodouNetworkError" ||
        failure.kind === "todou" ||
        failure.kind === "network")
    ) {
      const wrapped = new Error(
        error instanceof Error ? error.message : "Could not load spec",
        { cause: error },
      );
      wrapped.name = "SpecReadError";
      Object.assign(wrapped, { status: failure.status, kind: failure.kind });
      throw wrapped;
    }
    throw error;
  }
}
