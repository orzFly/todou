import {
  QueryClient,
  queryOptions,
  useSuspenseQuery,
} from "@tanstack/react-query";
import {
  type CapabilityId,
  can,
  ORIGIN_HEADER,
  TodouClient,
} from "@todou/shared";
import { createRuntimeBridge } from "@/api/runtime/bridge.ts";
import { invalidateRuntimeMutation } from "@/api/runtime/mutation-scopes.ts";
import {
  installRuntimeQueryAdapter,
  pageResource as resource,
  runtimeQueryOptions,
} from "@/api/runtime/query-adapter.ts";
import {
  networkResource,
  type ResourceDescriptor,
} from "@/api/runtime/resources.ts";

/**
 * This tab, as far as the server is concerned (T-275). Minted once per
 * module evaluation, so every tab gets its own, and sent on every request;
 * the writes that emit a `me` event echo it back, which is how a tab
 * recognizes its own write and skips invalidating twice.
 *
 * randomUUID needs a secure context and is missing under happy-dom, so the
 * fallback is not decoration — the value only has to be unlikely to collide
 * with another tab of the same account.
 */
export const clientOrigin =
  typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

/**
 * Same-origin client; vite dev proxies /api to the todou server.
 * Batching is off under vitest (MODE=test): the suites stub fetch with
 * per-path fake servers that must keep seeing plain GETs.
 */
const directApi = new TodouClient({
  batch: import.meta.env.MODE !== "test",
  headers: { [ORIGIN_HEADER]: clientOrigin },
});

export const runtime = createRuntimeBridge({
  clientOrigin,
  bootstrapFallback: () => api.me(),
});

export const api = new TodouClient({
  batch: import.meta.env.MODE !== "test",
  headers: { [ORIGIN_HEADER]: clientOrigin },
  delegate: async ({ method, path, query, body, context }) => {
    await runtime.ready;
    // Public bootstrap/configuration requests do not require a private lease.
    const publicRead =
      path === "/me" || path === "/auth/mode" || path === "/version";
    if (runtime.mode !== "worker" || publicRead) {
      const fence = publicRead ? undefined : runtime.captureAuthFence();
      const data = await directApi
        .withContext(context)
        .request(method, path, { query, json: body });
      if (!publicRead) runtime.assertAuthFence(fence);
      return data;
    }
    const descriptor = context.resource as ResourceDescriptor | undefined;
    return runtime.read(descriptor ?? networkResource(path, query), {
      signal: context.signal,
      forceFresh: context.forceFresh,
      freshnessMs: context.freshnessMs,
    });
  },
  onMutation: (event) => invalidateRuntimeMutation(runtime, event),
});

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5_000,
      retry: (failureCount, error) => {
        // Auth/permission failures never resolve by retrying.
        const status = (error as { status?: number }).status;
        if (status !== undefined && status >= 400 && status < 500) return false;
        return failureCount < 2;
      },
    },
  },
});

installRuntimeQueryAdapter(queryClient, runtime);

/** The app and browser harness share the same mode-selection boundary. */
export async function initializeRuntime(): Promise<void> {
  await runtime.ready;
}

/**
 * Metadata queries carry a 60s staleTime: the SSE change feed invalidates
 * them per entity the moment they actually change (and reconnects run a
 * broad compensation), so remount-driven refetching buys nothing. Content
 * queries (issues, timeline, spec) stay on the 5s default.
 */
const METADATA_STALE_MS = 60_000;

export const meQuery = queryOptions({
  queryKey: ["me"],
  queryFn: async () => {
    await initializeRuntime();
    return runtime.bootstrap();
  },
  staleTime: METADATA_STALE_MS,
  retry: false,
});

// The mode is fixed for the server's lifetime; never refetch mid-session.
export const authModeQuery = queryOptions({
  queryKey: ["auth-mode"],
  queryFn: () => api.authMode(),
  staleTime: Number.POSITIVE_INFINITY,
});

// The server's version only moves on deploy; the focus refetch (react-query's
// default) is what lets the footer settle once both halves are restarted.
export const versionQuery = queryOptions({
  queryKey: ["server-version"],
  queryFn: () => api.version(),
  staleTime: 5 * 60_000,
});

export const projectsQuery = runtimeQueryOptions(
  queryOptions({
    queryKey: ["projects"],
    queryFn: () => api.listProjects(),
    staleTime: METADATA_STALE_MS,
  }),
  { kind: "direct", resources: [resource("projects", "/projects")] },
);

export const projectQuery = (slug: string) => {
  const options = queryOptions({
    queryKey: ["project", slug],
    queryFn: () => api.getProject(slug),
    staleTime: METADATA_STALE_MS,
  });
  // The shell declares this disabled query before a project route is selected.
  if (!slug) return options;
  return runtimeQueryOptions(options, {
    kind: "direct",
    resources: [resource("project", `/projects/${slug}`)],
  });
};

export const statusesQuery = (slug: string) =>
  runtimeQueryOptions(
    queryOptions({
      queryKey: ["statuses", slug],
      queryFn: () => api.listStatuses(slug),
      staleTime: METADATA_STALE_MS,
    }),
    {
      kind: "direct",
      resources: [resource("statuses", `/projects/${slug}/statuses`)],
    },
  );

export const labelsQuery = (slug: string) =>
  runtimeQueryOptions(
    queryOptions({
      queryKey: ["labels", slug],
      queryFn: () => api.listLabels(slug),
      staleTime: METADATA_STALE_MS,
    }),
    {
      kind: "direct",
      resources: [resource("labels", `/projects/${slug}/labels`)],
    },
  );

export const membersQuery = (slug: string) =>
  runtimeQueryOptions(
    queryOptions({
      queryKey: ["members", slug],
      queryFn: () => api.listMembers(slug),
      staleTime: METADATA_STALE_MS,
    }),
    {
      kind: "direct",
      resources: [resource("members", `/projects/${slug}/members`)],
    },
  );

// Agents told to stop asking for access here (T-280). Invalidated by the
// `member` branch of the change feed, which is the entity these writes
// announce themselves as.
export const accessDenialsQuery = (slug: string) =>
  queryOptions({
    queryKey: ["access-denials", slug],
    queryFn: () => api.listAccessDenials(slug),
    staleTime: METADATA_STALE_MS,
  });

/**
 * Whether the viewer holds a capability here, answered by the same catalog
 * the server gates on. Hiding is cosmetic — the server decides either way —
 * but an affordance that 403s on click is worse than no affordance.
 *
 * Reads `viewer_role` rather than the member list, so an instance admin
 * (admin everywhere, with no membership row) is not mistaken for a stranger.
 */
export function useCan(slug: string, cap: CapabilityId): boolean {
  const project = useSuspenseQuery(projectQuery(slug));
  return can(project.data.viewer_role ?? null, cap);
}

/**
 * Whether the viewer administers this project — the gate behind every
 * admin-only affordance the UI hides. Hiding is cosmetic: the server decides,
 * and an instance admin (who is an admin everywhere without a membership row)
 * reads false here and is still allowed through.
 */
export function useIsProjectAdmin(slug: string): boolean {
  const me = useSuspenseQuery(meQuery);
  const members = useSuspenseQuery(membersQuery(slug));
  return members.data.some(
    (m) => m.user.id === me.data.id && m.role === "admin",
  );
}

export const agentsQuery = queryOptions({
  queryKey: ["agents"],
  queryFn: () => api.listAgents(),
});

// One call covers every agent, so the Projects column shares a single cache
// entry across all the rows instead of a query per agent.
export const agentMembershipsQuery = queryOptions({
  queryKey: ["agent-memberships"],
  queryFn: () => api.listAgentMemberships(),
  staleTime: METADATA_STALE_MS,
});

// A pending CLI authorization expires in 15 minutes and disappears the
// moment it is answered, so nothing here is worth caching or retrying.
export const cliAuthRequestQuery = (code: string) =>
  queryOptions({
    queryKey: ["cli-auth-request", code],
    queryFn: () => api.getCliAuthRequestByCode(code),
    staleTime: 0,
    retry: false,
  });
