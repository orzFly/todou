import { queryOptions } from "@tanstack/react-query";
import { UserIssueRole, UserIssueState } from "@todou/shared";
import { api } from "@/api/queries.ts";
import {
  beginRuntimeWrite,
  settleRuntimeWrite,
  writeRuntimeData,
} from "@/api/runtime/query-adapter.ts";
import {
  type ActivityDateSearch,
  activityDateSearchParams,
  parseActivityDateSearch,
} from "@/lib/activity-calendar-search.ts";

const userKey = (ref: string) => ["user", ref] as const;

/**
 * One account's public identity. 60s staleTime, the metadata cadence: the
 * login an avatar render from here follow a rename eventually, never
 * instantly, which is the same freshness a member chip gets.
 */
export const userQuery = (ref: string) =>
  queryOptions({
    queryKey: userKey(ref),
    queryFn: async ({ client, signal }) => {
      const user = await api.getUser(ref);
      // Nobody is waiting on the key this writes, so it has to honour this
      // fetch's own cancellation: `api.getUser` takes no signal, and a
      // response landing after a logout `clear()` would otherwise rebuild
      // the cache that logout had just emptied, marked fresh (T-414).
      if (signal.aborted) return user;
      // One row, two addresses. What an id read returns also answers the
      // login key the redirect is about to subscribe to (and the reverse),
      // or every id address costs two reads. A login may not be all digits
      // (`LoginInput`), so this comparison tells the two spellings apart.
      const alias = ref === user.login ? String(user.id) : user.login;
      const aliasKey = userKey(alias);
      const ownerToken = beginRuntimeWrite(
        client,
        { queryKey: aliasKey, exact: true },
        "alias",
      );
      try {
        writeRuntimeData(client, aliasKey, user, ownerToken);
      } finally {
        void settleRuntimeWrite(client, ownerToken).catch(() => {});
      }
      return user;
    },
    staleTime: 60_000,
  });

export type UserIssuesFilters = {
  ref: string;
  role: UserIssueRole;
  state: UserIssueState;
};

/**
 * The user page's search params (T-374), so the route and anything that
 * renders it read one definition. Defaults stay out of the URL: the address
 * somebody shares says only what they changed.
 */
export function userSearchSchema(search: Record<string, unknown>): {
  role?: UserIssueRole;
  state?: UserIssueState;
} & ActivityDateSearch {
  const role = UserIssueRole.safeParse(search.role);
  const state = UserIssueState.safeParse(search.state);
  return {
    ...(role.success && role.data !== "any" ? { role: role.data } : {}),
    ...(state.success && state.data !== "open" ? { state: state.data } : {}),
    ...parseActivityDateSearch(search),
  };
}

/** Public URL fields only; the route validator also returns notice metadata. */
export function userSearchParams(search: Record<string, unknown>) {
  return activityDateSearchParams(userSearchSchema(search));
}

/**
 * The first page of someone's cards (T-374). Later pages are fetched with
 * `queryClient.fetchQuery` and held in component state, the shape the
 * project issue list uses — the filters are in the key, so switching one
 * lands on its own cache entry rather than refetching over the old rows.
 */
export const userIssuesQuery = ({ ref, role, state }: UserIssuesFilters) =>
  queryOptions({
    queryKey: ["user-issues", ref, role, state],
    queryFn: () => api.listUserIssues(ref, { role, state }),
  });

/** One appended page, keyed by the cursor that asked for it. */
export const userIssuesPageQuery = (
  { ref, role, state }: UserIssuesFilters,
  after: string,
) =>
  queryOptions({
    queryKey: ["user-issues", ref, role, state, after],
    queryFn: () => api.listUserIssues(ref, { role, state, after }),
  });

export const userProjectsQuery = (ref: string) =>
  queryOptions({
    queryKey: ["user-projects", ref],
    queryFn: () => api.listUserProjects(ref),
  });
