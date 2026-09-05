import { type QueryClient, useQuery } from "@tanstack/react-query";
import {
  formatRef,
  type IssueListItem,
  type ReferenceConfig,
  type ReferenceDirectory,
} from "@todou/shared";
import { useMemo } from "react";
import {
  commentLocationQuery,
  commentRefQuery,
  issueRefQuery,
} from "@/api/issue-refs.ts";
import { recentOpenIssuesQuery } from "@/api/issues.ts";
import { projectsQuery } from "@/api/queries.ts";
import {
  referenceConfigQuery,
  referenceDirectoryQuery,
} from "@/api/references.ts";
import { displayNameOf } from "@/components/shared/user-chip.tsx";
import { qualifiedRefSpelling } from "@/lib/issue-refs.ts";
import {
  couldBeRef,
  couldNameProject,
  foldRefSpelling,
  type JumpCandidate,
  type JumpContext,
  refJumpCandidates,
} from "@/lib/ref-jump.ts";

/**
 * The other half of T-215: `refJumpCandidates` says which card a query
 * names, this says whether that card is there and how to spell it. Every
 * lookup is one <IssueLink> already makes, so a query the reader has
 * already seen resolved costs nothing.
 *
 * One deliberate difference from <IssueLink>: a failed lookup drops the
 * row even within this project. A ref in prose keeps its link through a
 * blip because hiding it would change what the sentence says; a jump offer
 * is optional, so it disappears and Enter searches as it always did.
 */

/** Where a card candidate points, once every lookup it needs has landed. */
export type JumpTarget = { slug: string; number: number; commentId?: number };

/** A candidate that names a card, as opposed to an external link. */
export type JumpCardCandidate = Extract<
  JumpCandidate,
  { kind: "issue" | "comment" }
>;

export type JumpRow =
  /** A card is named and still being looked up; nothing to show yet but a placeholder. */
  | { kind: "issue"; state: "pending"; candidate: JumpCardCandidate }
  | {
      kind: "issue";
      state: "ready";
      slug: string;
      number: number;
      commentId?: number;
      spelled: string;
      item: IssueListItem;
      commentBy: string | null;
      crossProject: boolean;
    }
  /**
   * A project's home page, for a query that names the project and stops
   * there (T-263). No state: the name comes from a list the box has already
   * read, so this row is either there at once or not at all.
   */
  | { kind: "project"; slug: string; spelled: string; name: string }
  | { kind: "external"; href: string; text: string; host: string };

/** `checkQualifiedPrefix`'s rule (T-214): what the project writes now, or ever wrote. */
function writesPrefix(config: ReferenceConfig, prefix: string): boolean {
  return (
    config.format.prefix === prefix ||
    config.format.history.some((change) => change.prefix === prefix)
  );
}

const isCard = (candidate: JumpCandidate): candidate is JumpCardCandidate =>
  candidate.kind === "issue" || candidate.kind === "comment";

function jumpContext(
  slug: string,
  config: ReferenceConfig,
  directory: ReferenceDirectory | null,
  projects: readonly { slug: string }[],
): JumpContext {
  return {
    slug,
    prefix: config.format.prefix,
    autolinks: config.autolinks,
    readableSlugs: projects.map((project) => project.slug),
    directory,
    origin: window.location.origin,
  };
}

export function useJumpRows(slug: string, q: string): JumpRow[] {
  // The box is mounted on every project page. Until someone types in it
  // there is no question to answer, so it asks nothing.
  const asked = q.trim() !== "";
  const config = useQuery({ ...referenceConfigQuery(slug), enabled: asked });
  const directory = useQuery({ ...referenceDirectoryQuery, enabled: asked });
  const projects = useQuery({ ...projectsQuery, enabled: asked });

  const prefix = config.data?.format.prefix ?? null;
  const candidates = useMemo(() => {
    if (
      config.data === undefined ||
      directory.data === undefined ||
      projects.data === undefined
    ) {
      // Reading a query against half its context would resolve foreign
      // spellings as this project's own for one render.
      return [];
    }
    return refJumpCandidates(
      q,
      jumpContext(slug, config.data, directory.data, projects.data),
    );
  }, [q, slug, config.data, directory.data, projects.data]);

  const card = candidates.find(isCard);
  const writtenPrefix = card?.kind === "issue" ? card.writtenPrefix : undefined;

  // A bare `#comment-M` names no card, so which one carries it is the
  // first question rather than the last.
  const located = useQuery({
    ...commentLocationQuery(
      slug,
      card?.kind === "comment" ? card.commentId : 0,
    ),
    enabled: card?.kind === "comment",
  });

  const target: JumpTarget | null =
    card === undefined
      ? null
      : card.kind === "issue"
        ? {
            slug: card.slug,
            number: card.number,
            ...(card.commentId === undefined
              ? {}
              : { commentId: card.commentId }),
          }
        : located.data
          ? {
              slug: card.slug,
              number: located.data.issue_number,
              commentId: card.commentId,
            }
          : null;

  const targetConfig = useQuery({
    ...referenceConfigQuery(target?.slug ?? slug),
    enabled: target !== null,
  });
  const prefixOk =
    writtenPrefix === undefined ||
    (targetConfig.data !== undefined &&
      writesPrefix(targetConfig.data, writtenPrefix));

  const issue = useQuery({
    ...issueRefQuery(target?.slug ?? slug, target?.number ?? 0),
    enabled: target !== null && prefixOk,
  });
  const note = useQuery({
    ...commentRefQuery(
      target?.slug ?? slug,
      target?.number ?? 0,
      target?.commentId ?? 0,
    ),
    enabled: target !== null && prefixOk && target.commentId !== undefined,
  });

  // One pending state for the whole chain: a row that appeared, then grew
  // a title, then a comment note would rearrange the list under the
  // reader's Enter.
  const pending =
    card !== undefined &&
    ((card.kind === "comment" && located.isPending) ||
      (target !== null &&
        (targetConfig.isPending ||
          (prefixOk &&
            (issue.isPending ||
              (target.commentId !== undefined && note.isPending))))));

  const spelled =
    target === null
      ? ""
      : target.slug === slug
        ? formatRef(prefix, target.number)
        : qualifiedRefSpelling(
            target.slug,
            targetConfig.data?.format.prefix ?? null,
            target.number,
          );

  const rows: JumpRow[] = [];
  if (card !== undefined) {
    if (pending) {
      rows.push({ kind: "issue", state: "pending", candidate: card });
    } else if (target !== null && prefixOk && issue.data != null) {
      rows.push({
        kind: "issue",
        state: "ready",
        slug: target.slug,
        number: target.number,
        ...(target.commentId === undefined
          ? {}
          : { commentId: target.commentId }),
        spelled,
        item: issue.data,
        commentBy: note.data ? displayNameOf(note.data.author) : null,
        crossProject: target.slug !== slug,
      });
    }
  }
  for (const candidate of candidates) {
    if (candidate.kind === "project") {
      rows.push({
        kind: "project",
        slug: candidate.slug,
        // What the reader typed, in the spelling the project actually has:
        // `MIRROR/` is offered back as `mirror/`.
        spelled: foldRefSpelling(q.trim()),
        name:
          projects.data?.find((project) => project.slug === candidate.slug)
            ?.name ?? candidate.slug,
      });
    }
    if (candidate.kind === "external") {
      rows.push({
        kind: "external",
        href: candidate.href,
        text: candidate.text,
        // The template is checked for http(s) when it is written, so this
        // cannot throw (AutolinkUrlTemplate).
        host: new URL(candidate.href).host,
      });
    }
  }
  return rows;
}

/** How many of a project's cards the box shows beneath its home row. */
export const PROJECT_PEEK = 5;

/** One card of the peek, spelled so it can be typed back into the box. */
export type ProjectPeekRow = {
  kind: "project-issue";
  slug: string;
  number: number;
  spelled: string;
  item: IssueListItem;
};

/**
 * What a project named without a number is working on (T-263). Naming a
 * project is a weaker intention than naming a card — the reader may be on
 * their way to one and not remember its number — so the home row comes with
 * the few cards that moved most recently.
 *
 * Open only, and never a placeholder: these are an offer beside the one the
 * reader actually made, and a skeleton for them would push the home row
 * around while they are reading it. They appear when they arrive.
 *
 * Takes the home row rather than its slug, because the cards are spelled by
 * carrying that row's spelling on rather than by looking a format up.
 */
export function useProjectPeek(
  named: { slug: string; spelled: string } | null,
): ProjectPeekRow[] {
  const target = named?.slug ?? null;
  // The home row's own spelling, which is the query folded to the case the
  // project actually has.
  const typed = named?.spelled ?? "";
  const issues = useQuery({
    ...recentOpenIssuesQuery(target ?? "", PROJECT_PEEK),
    enabled: target !== null,
  });
  const items = issues.data?.items;
  return useMemo(() => {
    if (target === null || items === undefined) return [];
    return items.slice(0, PROJECT_PEEK).map(
      (item): ProjectPeekRow => ({
        kind: "project-issue",
        slug: target,
        number: item.number,
        // The reader's own spelling continued: `accel/` gives `accel/1` and
        // `ACC-` gives `ACC-1`, which is the next thing they were going to
        // type and no longer repeats the home row sitting directly above.
        //
        // Safe in every shape that reaches here, because a home row only
        // exists for four of them: the three slug-qualified ones name their
        // project in the grammar itself, and the bare `P-` came out of the
        // same uncontested claim `resolveClaim` reads back. So none of these
        // can be read as a card of the project being searched — which is why
        // the qualified spelling was chosen in the first place.
        spelled: `${typed}${item.number}`,
        item,
      }),
    );
  }, [target, typed, items]);
}

async function cardPromise(
  client: QueryClient,
  candidate: JumpCardCandidate,
): Promise<JumpTarget | null> {
  try {
    const located =
      candidate.kind === "issue"
        ? null
        : await client.fetchQuery(
            commentLocationQuery(candidate.slug, candidate.commentId),
          );
    const number =
      candidate.kind === "issue" ? candidate.number : located?.issue_number;
    if (number === undefined) return null;

    const writtenPrefix =
      candidate.kind === "issue" ? candidate.writtenPrefix : undefined;
    if (writtenPrefix !== undefined) {
      const config = await client.fetchQuery(
        referenceConfigQuery(candidate.slug),
      );
      if (!writesPrefix(config, writtenPrefix)) return null;
    }

    const item = await client.fetchQuery(issueRefQuery(candidate.slug, number));
    if (item === null) return null;
    return {
      slug: candidate.slug,
      number,
      ...(candidate.commentId === undefined
        ? {}
        : { commentId: candidate.commentId }),
    };
  } catch {
    // Unreadable project, deleted comment, network — all "no such card",
    // which is the same answer the row gives.
    return null;
  }
}

/** Where Enter goes; null = nowhere in particular, so search for the text. */
export type JumpDestination =
  | { kind: "issue"; target: JumpTarget }
  | { kind: "project"; slug: string }
  | { kind: "external"; href: string };

/**
 * The whole ladder as a promise, run from the query string rather than from
 * the rows — because the rows can be empty for two different reasons and
 * Enter must not confuse them. The box asks nothing until it is typed in,
 * so on the very first keystroke "not resolved yet" looks exactly like "not
 * a reference", and reading it as the latter would send a pasted ref to the
 * results page whenever the reader is faster than the network.
 *
 * `fetchQuery` joins a request already in flight rather than starting a
 * second one, so the answer is the same one the row is about to show.
 */
export async function jumpDestinationPromise(
  client: QueryClient,
  slug: string,
  q: string,
): Promise<JumpDestination | null> {
  // Two gates, because the shapes are two: a card ends in digits, a project
  // named on its own ends in the separator that would have preceded them.
  if (!couldBeRef(q) && !couldNameProject(q)) return null;
  const [config, directory, projects] = await Promise.all([
    client.fetchQuery(referenceConfigQuery(slug)).catch(() => null),
    client.fetchQuery(referenceDirectoryQuery).catch(() => null),
    client.fetchQuery(projectsQuery).catch(() => null),
  ]);
  if (config === null || projects === null) return null;

  const candidates = refJumpCandidates(
    q,
    // A directory that cannot be read is one that resolves nothing, which
    // is the renderer's degradation too.
    jumpContext(slug, config, directory, projects),
  );
  // A project needs no lookup at all: the candidate only exists because the
  // directory already resolved it, so Enter does not wait on a round trip.
  const project = candidates.find((candidate) => candidate.kind === "project");
  if (project?.kind === "project")
    return { kind: "project", slug: project.slug };

  const card = candidates.find(isCard);
  if (card !== undefined) {
    const target = await cardPromise(client, card);
    if (target !== null) return { kind: "issue", target };
  }
  // No card, so this is the destination the default highlight would have
  // picked without one.
  const external = candidates.find(
    (candidate) => candidate.kind === "external",
  );
  return external === undefined || external.kind !== "external"
    ? null
    : { kind: "external", href: external.href };
}
