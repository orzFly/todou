import { QueryClient, queryOptions } from "@tanstack/react-query";
import { TodouClient } from "@todou/shared";

/** Same-origin client; vite dev proxies /api to the todou server. */
export const api = new TodouClient();

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

export const meQuery = queryOptions({
  queryKey: ["me"],
  queryFn: () => api.me(),
  retry: false,
});

// The mode is fixed for the server's lifetime; never refetch mid-session.
export const authModeQuery = queryOptions({
  queryKey: ["auth-mode"],
  queryFn: () => api.authMode(),
  staleTime: Number.POSITIVE_INFINITY,
});

export const projectsQuery = queryOptions({
  queryKey: ["projects"],
  queryFn: () => api.listProjects(),
});

export const projectQuery = (slug: string) =>
  queryOptions({
    queryKey: ["project", slug],
    queryFn: () => api.getProject(slug),
  });

export const statusesQuery = (slug: string) =>
  queryOptions({
    queryKey: ["statuses", slug],
    queryFn: () => api.listStatuses(slug),
  });

export const labelsQuery = (slug: string) =>
  queryOptions({
    queryKey: ["labels", slug],
    queryFn: () => api.listLabels(slug),
  });

export const membersQuery = (slug: string) =>
  queryOptions({
    queryKey: ["members", slug],
    queryFn: () => api.listMembers(slug),
  });

export const agentsQuery = queryOptions({
  queryKey: ["agents"],
  queryFn: () => api.listAgents(),
});
