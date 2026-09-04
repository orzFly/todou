import { queryOptions } from "@tanstack/react-query";
import type { CommentLocation, IssueListItem } from "@todou/shared";
import { MovedError } from "@todou/shared";
import { api } from "@/api/queries.ts";

/**
 * Batcher behind <IssueLink>: every ref rendered in the same tick lands in
 * one `numbers=…` list request instead of a request per #N. Each number
 * still gets its own query-cache entry, so repeats of a ref are served
 * from cache and a later batch only fetches the numbers it is missing.
 */

type Waiter = {
  resolve: (item: IssueListItem | null) => void;
  reject: (error: unknown) => void;
};

const pending = new Map<string, Map<number, Waiter[]>>();

/** The list endpoint caps limit at 100; larger batches must be chunked. */
const BATCH_LIMIT = 100;

function fetchIssueRef(
  slug: string,
  number: number,
): Promise<IssueListItem | null> {
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
  const settle = (fn: (waiter: Waiter, number: number) => void) => {
    for (const [number, waiters] of batch) {
      for (const waiter of waiters) fn(waiter, number);
    }
  };
  try {
    const byNumber = new Map<number, IssueListItem>();
    for (let i = 0; i < numbers.length; i += BATCH_LIMIT) {
      const chunk = numbers.slice(i, i + BATCH_LIMIT);
      const page = await api.listIssues(slug, {
        numbers: chunk,
        limit: chunk.length,
      });
      for (const item of page.items as IssueListItem[]) {
        byNumber.set(item.number, item);
      }
    }
    // A miss is not the end of it: the list excludes tombstones, so a ref
    // to a card that moved away looks exactly like a ref to a number nobody
    // used. Probing the issue route is what turns the first case into a
    // link to the new address instead of plain text (T-231).
    const misses = numbers.filter((n) => !byNumber.has(n));
    const relocated = await followMoved(slug, misses);
    settle((waiter, number) =>
      waiter.resolve(byNumber.get(number) ?? relocated.get(number) ?? null),
    );
  } catch (error) {
    // Rejecting rather than resolving null keeps "no such issue" apart from
    // "this project answered nothing": a cross-project <IssueLink> reads the
    // difference and degrades to plain text on either (T-150).
    settle((waiter) => waiter.reject(error));
  }
}

/**
 * The cards among `numbers` that moved, fetched from where they are now.
 *
 * Two rounds at most, both through the client's batcher: one to learn the
 * new addresses, one to read the cards there. Failures resolve to nothing —
 * a ref that cannot be resolved is plain text, which is what it was before.
 */
async function followMoved(
  slug: string,
  numbers: number[],
): Promise<Map<number, IssueListItem>> {
  const found = new Map<number, IssueListItem>();
  if (numbers.length === 0) return found;

  const addresses = await Promise.all(
    numbers.map(async (number) => {
      try {
        await api.getIssue(slug, number);
        return null;
      } catch (error) {
        return error instanceof MovedError
          ? { number, to: error.movedTo }
          : null;
      }
    }),
  );

  await Promise.all(
    addresses.map(async (address) => {
      if (address === null) return;
      try {
        const issue = await api.getIssue(address.to.slug, address.to.number);
        const { body: _body, ...item } = issue;
        found.set(address.number, item as IssueListItem);
      } catch {
        // Gone, or unreadable from here: plain text either way.
      }
    }),
  );
  return found;
}

export const issueRefQuery = (slug: string, number: number) =>
  queryOptions({
    queryKey: ["issue-ref", slug, number],
    queryFn: () => fetchIssueRef(slug, number),
    // Title/status drift a little behind reality; refs are decoration, not
    // the source of truth, so trade freshness for fewer refetch bursts.
    staleTime: 60_000,
  });

/**
 * Comment lookup for rich permalinks ("comment by @user"). Unbatched on
 * purpose: pasted comment permalinks are rare enough that a request per
 * distinct comment is fine, and the per-id cache still dedupes repeats.
 */
export const commentRefQuery = (
  slug: string,
  issueNumber: number,
  commentId: number,
) =>
  queryOptions({
    queryKey: ["comment-ref", slug, issueNumber, commentId],
    queryFn: async () => {
      try {
        return await api.getComment(slug, issueNumber, commentId);
      } catch (error) {
        // Deleted comments must not break the surrounding rich link.
        if ((error as { status?: number }).status === 404) return null;
        throw error;
      }
    },
    staleTime: 60_000,
  });

/**
 * Where a bare `#comment-M` points. Unbatched like commentRefQuery: the
 * form is rare enough that one request per distinct id is fine.
 */
export const commentLocationQuery = (slug: string, commentId: number) =>
  queryOptions({
    queryKey: ["comment-location", slug, commentId],
    queryFn: async (): Promise<CommentLocation | null> => {
      try {
        return await api.locateComment(slug, commentId);
      } catch (error) {
        // The comment route's redirect already carries the new issue and
        // comment id, so a moved permalink needs no second hop.
        if (error instanceof MovedError) {
          const { slug: to, number, comment_id } = error.movedTo;
          if (comment_id === undefined) return null;
          return api.getComment(to, number, comment_id).then((comment) => ({
            issue_number: number,
            issue_ref: `${to}#${number}`,
            comment,
          }));
        }
        // Deleted comment, unreadable project, or a server predating the
        // endpoint — all three render as plain text.
        if ((error as { status?: number }).status === 404) return null;
        throw error;
      }
    },
    staleTime: 60_000,
  });
