import { queryOptions } from "@tanstack/react-query";
import type { IssueListItem } from "@todou/shared";
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
    // null = the ref points at no issue in this project; render plain text.
    settle((waiter, number) => waiter.resolve(byNumber.get(number) ?? null));
  } catch (error) {
    settle((waiter) => waiter.reject(error));
  }
}

export const issueRefQuery = (slug: string, number: number) =>
  queryOptions({
    queryKey: ["issue-ref", slug, number],
    queryFn: () => fetchIssueRef(slug, number),
    // Title/status drift a little behind reality; refs are decoration, not
    // the source of truth, so trade freshness for fewer refetch bursts.
    staleTime: 60_000,
  });
