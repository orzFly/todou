import { queryOptions } from "@tanstack/react-query";
import type {
  CommentLocation,
  IssueListItem,
  TimelineComment,
} from "@todou/shared";
import { MovedError } from "@todou/shared";
import { api } from "@/api/queries.ts";

/**
 * Batcher behind <IssueLink>: every ref rendered in the same tick lands in
 * one `numbers=…` list request instead of a request per #N. Each number
 * still gets its own query-cache entry, so repeats of a ref are served
 * from cache and a later batch only fetches the numbers it is missing.
 */

type Waiter = {
  resolve: (item: ResolvedIssueRef | null) => void;
  reject: (error: unknown) => void;
};

/**
 * A resolved reference, plus where the card lives now when that is not the
 * address the reference was written with (T-266). A stored link is anchored
 * on a permanent address, so following one after a move would cost a
 * redirect; knowing the current address lets the anchor point straight at it.
 */
export type ResolvedIssueRef = IssueListItem & {
  at?: { slug: string; number: number };
};

const pending = new Map<string, Map<number, Waiter[]>>();

/** The list endpoint caps limit at 100; larger batches must be chunked. */
const BATCH_LIMIT = 100;

function fetchIssueRef(
  slug: string,
  number: number,
): Promise<ResolvedIssueRef | null> {
  return new Promise((resolve, reject) => {
    let batch = pending.get(slug);
    if (!batch) {
      batch = new Map();
      pending.set(slug, batch);
      // A macrotask (not a microtask) so every IssueLink mounted in the
      // same render commit joins the batch before it flushes.
      setTimeout(() => flush(slug), 0);
    }
    const waiters = batch.get(number) ?? [];
    waiters.push({ resolve, reject });
    batch.set(number, waiters);
  });
}

async function flush(slug: string): Promise<void> {
  const batch = pending.get(slug);
  pending.delete(slug);
  if (!batch) return;

  const numbers = [...batch.keys()];
  const byNumber = new Map<number, ResolvedIssueRef>();
  const unresolved = new Set<number>();

  // A project list can be unreadable even though one old address in it is
  // allowed to disclose a redirect. Keep batching the normal path, but let
  // each failed chunk fall through to the same single-target route used for
  // list misses.
  for (let i = 0; i < numbers.length; i += BATCH_LIMIT) {
    const chunk = numbers.slice(i, i + BATCH_LIMIT);
    try {
      const page = await api.listIssues(slug, {
        numbers: chunk,
        limit: chunk.length,
      });
      for (const item of page.items as IssueListItem[]) {
        if (item.deleted_at == null) byNumber.set(item.number, item);
      }
      for (const number of chunk) {
        if (!byNumber.has(number)) unresolved.add(number);
      }
    } catch {
      for (const number of chunk) unresolved.add(number);
    }
  }

  const outcomes = new Map<
    number,
    | { status: "fulfilled"; value: ResolvedIssueRef | null }
    | { status: "rejected"; reason: unknown }
  >();
  await Promise.all(
    [...unresolved].map(async (number) => {
      try {
        outcomes.set(number, {
          status: "fulfilled",
          value: await fetchSingleTarget(slug, number),
        });
      } catch (reason) {
        outcomes.set(number, { status: "rejected", reason });
      }
    }),
  );

  for (const [number, waiters] of batch) {
    const item = byNumber.get(number);
    const outcome = outcomes.get(number);
    for (const waiter of waiters) {
      if (item !== undefined) {
        waiter.resolve(item);
      } else if (outcome?.status === "rejected") {
        waiter.reject(outcome.reason);
      } else {
        waiter.resolve(outcome?.value ?? null);
      }
    }
  }
}

const isUnreadableTarget = (error: unknown): boolean => {
  if (error === null || typeof error !== "object" || !("status" in error)) {
    return false;
  }
  const status = error.status;
  return status === 403 || status === 404 || status === 410;
};

const asListItem = (
  issue: IssueListItem & { body?: unknown },
  at?: { slug: string; number: number },
): ResolvedIssueRef | null => {
  if (issue.deleted_at != null) return null;
  const { body: _body, ...item } = issue;
  return {
    ...(item as IssueListItem),
    ...(at === undefined ? {} : { at }),
  };
};

/**
 * Resolve one permanent address. Numeric project refs and unreadable project
 * lists deliberately come through here: the issue route may disclose a move
 * to an authorized destination even when the source itself cannot be listed.
 */
async function fetchSingleTarget(
  slug: string,
  number: number,
): Promise<ResolvedIssueRef | null> {
  try {
    return asListItem(await api.getIssue(slug, number));
  } catch (error) {
    if (!(error instanceof MovedError)) {
      if (isUnreadableTarget(error)) return null;
      throw error;
    }

    const to = error.movedTo;
    try {
      return asListItem(await api.getIssue(to.slug, to.number), {
        slug: to.slug,
        number: to.number,
      });
    } catch (targetError) {
      if (isUnreadableTarget(targetError)) return null;
      throw targetError;
    }
  }
}

// Display references resolve once per client session (T-462). Static data
// survives invalidation; infinite gcTime also preserves it across page visits.
// Live search confirmation uses independent keys in search-refs.ts.
export const issueRefQuery = (slug: string, number: number) =>
  queryOptions<ResolvedIssueRef | null>({
    queryKey: ["issue-ref", slug, number],
    queryFn: () => fetchIssueRef(slug, number),
    staleTime: "static",
    gcTime: Infinity,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });

export type ResolvedCommentRef = TimelineComment & {
  at: { slug: string; number: number; commentId: number };
};

const withCommentTarget = (
  comment: TimelineComment,
  slug: string,
  number: number,
  commentId: number,
): ResolvedCommentRef => ({
  ...comment,
  at: { slug, number, commentId },
});

/**
 * Comment lookup for rich permalinks (full comment ref and author). The response
 * carries its final full address so a comment can only confirm the issue
 * metadata for the parent it actually belongs to.
 */
export const commentRefQuery = (
  slug: string,
  issueNumber: number,
  commentId: number,
) =>
  queryOptions<ResolvedCommentRef | null>({
    queryKey: ["comment-ref", slug, issueNumber, commentId],
    queryFn: async (): Promise<ResolvedCommentRef | null> => {
      try {
        const comment = await api.getComment(slug, issueNumber, commentId);
        return withCommentTarget(comment, slug, issueNumber, commentId);
      } catch (error) {
        if (error instanceof MovedError) {
          const { slug: to, number, comment_id } = error.movedTo;
          if (comment_id === undefined) return null;
          try {
            const comment = await api.getComment(to, number, comment_id);
            return withCommentTarget(comment, to, number, comment_id);
          } catch (targetError) {
            if (isUnreadableTarget(targetError)) return null;
            throw targetError;
          }
        }
        // Deleted or unreadable comments must not break the surrounding link.
        if (isUnreadableTarget(error)) return null;
        throw error;
      }
    },
    staleTime: "static",
    gcTime: Infinity,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });

/**
 * A located comment, plus the project it turned out to be in. `issue_number`
 * is only meaningful next to its project, and a redirect can change which
 * project that is — pairing the number with the one that was asked would
 * name a different card (T-231).
 */
export type LocatedComment = CommentLocation & { slug?: string };

export const commentLocationQuery = (slug: string, commentId: number) =>
  queryOptions<LocatedComment | null>({
    queryKey: ["comment-location", slug, commentId],
    queryFn: async (): Promise<LocatedComment | null> => {
      try {
        return await api.locateComment(slug, commentId);
      } catch (error) {
        // The comment route's redirect already carries the new issue and
        // comment id, so a moved permalink needs no second hop.
        if (error instanceof MovedError) {
          const { slug: to, number, comment_id } = error.movedTo;
          if (comment_id === undefined) return null;
          try {
            const comment = await api.getComment(to, number, comment_id);
            return {
              slug: to,
              issue_number: number,
              issue_ref: `${to}#${number}`,
              comment,
            };
          } catch (targetError) {
            if (isUnreadableTarget(targetError)) return null;
            throw targetError;
          }
        }
        // Deleted comment, unreadable project, or a server predating the
        // endpoint — all three render as plain text.
        if (isUnreadableTarget(error)) return null;
        throw error;
      }
    },
    staleTime: "static",
    gcTime: Infinity,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
