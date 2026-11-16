import {
  OpenedPayload,
  type TimelineItem,
  type TodouClient,
} from "@todou/shared";
import type { RefSpelling } from "./resolve.ts";
import { type CardOf, type NameOf, referenceTarget } from "./timeline.ts";

/**
 * The titles and bodies a batch of activity entries needs before it can be
 * rendered (T-286). An `opened` event's payload carries no title or body and a reference's
 * names its referrer by number, so the two lines that are about *another
 * card* have to be resolved from the cards themselves — asynchronously, while
 * `renderActivityLine` is synchronous. Hence the shape: the drain resolves the
 * batch, the renderer reads a lookup table.
 *
 * Nothing here throws. Every one of these reads sits inside a drain that
 * `retryTransient` wraps, so a 404 on one trashed card that escaped would eat
 * into the retry budget and eventually take a standing watch down with it —
 * the same reasoning `ensurePrefixes` in commands/watch.ts already carries.
 */

/** One entry, where it sits, and how that project spells other projects. */
export type ActivityCardRef = RefSpelling & {
  item: TimelineItem;
  /** The slug and number of the card this entry is on. */
  project: string;
  number: number;
};

/** The lookup a batch with nothing resolved (or nothing to resolve) gets. */
export const NO_CARDS: CardOf = () => undefined;

/** What a batch's lines read once its drain has resolved them. */
export type ActivityLookups = { cardOf: CardOf; nameOf: NameOf };

export const NO_LOOKUPS: ActivityLookups = {
  cardOf: NO_CARDS,
  nameOf: () => undefined,
};

/** `numbers=…` is capped by the list endpoint's `limit`, which maxes at 100. */
const BATCH_LIMIT = 100;

type Card = { title: string; body: string | null };

/**
 * The cards one delivered batch renders with, and the display names of the
 * people its assignment payloads name only by login (T-697). Both resolve
 * nothing until `add` has run.
 */
export type ActivityCards = ActivityLookups & {
  /**
   * Resolves what these entries mention, on top of what the batch already
   * knows. One batch takes several drains whenever `--debounce` is
   * collecting a burst, so each drain adds rather than replaces.
   */
  add: (entries: ActivityCardRef[]) => Promise<void>;
  /**
   * Forgotten as soon as a batch has gone out, which is why a standing watch
   * resolving the same card twice is not a bug to fix with a cache: two
   * batches are a debounce window apart (15s by default), a title gets
   * renamed, and the web gives a resolved ref no more staleness than that.
   */
  reset: () => void;
};

export function activityCards(client: TodouClient): ActivityCards {
  let cards = new Map<string, Card>();
  let names = new Map<string, Map<string, string>>();
  return {
    cardOf: (slug, number) => cards.get(key(slug, number)),
    nameOf: (slug, login) => names.get(slug)?.get(login),
    add: async (entries) => {
      await Promise.all([
        collect(client, entries, cards),
        collectNames(client, entries, names),
      ]);
    },
    reset: () => {
      cards = new Map();
      names = new Map();
    },
  };
}

/** One batch resolved in one go, for the paths that deliver exactly once. */
export async function resolveActivityCards(
  client: TodouClient,
  entries: ActivityCardRef[],
): Promise<ActivityLookups> {
  const cards = activityCards(client);
  await cards.add(entries);
  return { cardOf: cards.cardOf, nameOf: cards.nameOf };
}

/**
 * `runWatchLoop`'s `afterItems`, with the batch's cards dropped once the
 * batch is delivered. Standing mode is the only mode with a next batch to
 * keep them from, and it is exactly the mode that sets this hook.
 */
export function clearCardsAfterBatch<T>(
  cards: ActivityCards,
  afterItems:
    | ((items: T[], cursor: string | undefined) => Promise<"continue" | "stop">)
    | undefined,
):
  | ((items: T[], cursor: string | undefined) => Promise<"continue" | "stop">)
  | undefined {
  if (afterItems === undefined) return undefined;
  return async (items, cursor) => {
    const outcome = await afterItems(items, cursor);
    cards.reset();
    return outcome;
  };
}

async function collect(
  client: TodouClient,
  entries: ActivityCardRef[],
  cards: Map<string, Card>,
): Promise<void> {
  /** Cards whose body is wanted too, so they cannot come off a list page. */
  const whole = new Map<string, { project: string; number: number }>();
  /** Titles only, by project — one `numbers=…` request per project. */
  const titles = new Map<string, Set<number>>();

  for (const entry of entries) {
    const { item } = entry;
    if (item.type !== "event") continue;
    if (item.event_type === "opened") {
      whole.set(key(entry.project, entry.number), {
        project: entry.project,
        number: entry.number,
      });
      continue;
    }
    if (
      item.event_type !== "referenced" &&
      item.event_type !== "cross_referenced"
    ) {
      continue;
    }
    const target = referenceTarget(item.payload, entry);
    // A project id the directory cannot name, or a payload shape this build
    // does not know: the line degrades to the ref alone, so nothing to fetch.
    if (target === null || target.slug === null) continue;
    const group = titles.get(target.slug) ?? new Set<number>();
    group.add(target.number);
    titles.set(target.slug, group);
  }

  const reads: Array<Promise<void>> = [];
  for (const { project, number } of whole.values()) {
    reads.push(
      client
        .getIssue(project, number)
        .then((issue) => {
          cards.set(key(project, number), {
            title: issue.title,
            body: issue.body,
          });
        })
        .catch(() => {}),
    );
  }
  for (const [slug, group] of titles) {
    // A card already being read whole is not worth a slot in a list request:
    // that read carries its title as well.
    const numbers = [...group].filter((n) => !whole.has(key(slug, n)));
    reads.push(
      listTitles(client, slug, numbers).then((found) => {
        for (const [number, title] of found) {
          // A list row has no body (IssueListItem omits it), and only the
          // `opened` line wants one.
          cards.set(key(slug, number), { title, body: null });
        }
      }),
    );
  }
  // No pool: the worst 60-second window this tracker has — the default
  // `--follow` debounce, so the realistic ceiling after batching — is one
  // list request and ten single reads. A drain catching up from a month-old
  // cursor sends more, but that drain has already sent one activity request
  // per page, serially, so this is not a new order of magnitude.
  await Promise.all(reads);
}

/**
 * Display names for the logins an assignment payload carries: one members
 * read per project that has such an entry. Someone who has since left the
 * project, or a read that fails, keeps the bare login the line always had.
 */
async function collectNames(
  client: TodouClient,
  entries: ActivityCardRef[],
  names: Map<string, Map<string, string>>,
): Promise<void> {
  const projects = new Set<string>();
  for (const { item, project } of entries) {
    if (item.type !== "event" || names.has(project)) continue;
    const named =
      item.event_type === "assigned" ||
      item.event_type === "unassigned" ||
      (item.event_type === "opened" &&
        (OpenedPayload.safeParse(item.payload).data?.assignees.length ?? 0) >
          0);
    if (named) projects.add(project);
  }
  await Promise.all(
    [...projects].map((project) =>
      client
        .listMembers(project)
        .then((members) => {
          const found = new Map<string, string>();
          for (const { user } of members) {
            const name = user.display_name?.trim();
            if (name) found.set(user.login, name);
          }
          names.set(project, found);
        })
        .catch(() => {}),
    ),
  );
}

/**
 * Titles of one project's cards, a `numbers=…` request per hundred. A card
 * the reader cannot see, or a request that fails, is simply absent.
 */
export async function listTitles(
  client: TodouClient,
  slug: string,
  numbers: readonly number[],
): Promise<Map<number, string>> {
  const found = new Map<number, string>();
  const reads: Array<Promise<void>> = [];
  for (let i = 0; i < numbers.length; i += BATCH_LIMIT) {
    const chunk = numbers.slice(i, i + BATCH_LIMIT);
    reads.push(
      client
        .listIssues(slug, { numbers: chunk, limit: chunk.length })
        .then((page) => {
          for (const row of page.items) found.set(row.number, row.title);
        })
        .catch(() => {}),
    );
  }
  await Promise.all(reads);
  return found;
}

function key(slug: string, number: number): string {
  return `${slug}#${number}`;
}
