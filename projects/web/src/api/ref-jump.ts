import { type QueryClient, useQuery } from "@tanstack/react-query";
import {
  formatRef,
  type IssueListItem,
  type ReferenceConfig,
} from "@todou/shared";
import { useMemo } from "react";
import {
  commentLocationQuery,
  commentRefQuery,
  issueRefQuery,
} from "@/api/issue-refs.ts";
import { projectsQuery } from "@/api/queries.ts";
import {
  referenceConfigQuery,
  referenceDirectoryQuery,
} from "@/api/references.ts";
import { displayNameOf } from "@/components/shared/user-chip.tsx";
import { qualifiedRefSpelling } from "@/lib/issue-refs.ts";
import { type JumpCandidate, refJumpCandidates } from "@/lib/ref-jump.ts";

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
  | { kind: "external"; href: string; text: string; host: string };

/** `checkQualifiedPrefix`'s rule (T-214): what the project writes now, or ever wrote. */
function writesPrefix(config: ReferenceConfig, prefix: string): boolean {
  return (
    config.format.prefix === prefix ||
    config.format.history.some((change) => change.prefix === prefix)
  );
}

const isCard = (candidate: JumpCandidate): candidate is JumpCardCandidate =>
  candidate.kind !== "external";

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
    return refJumpCandidates(q, {
      slug,
      prefix: config.data.format.prefix,
      autolinks: config.data.autolinks,
      readableSlugs: projects.data.map((project) => project.slug),
      directory: directory.data,
      origin: window.location.origin,
    });
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

/**
 * The same ladder as a promise, for Enter. `fetchQuery` joins the request
 * already in flight rather than starting a second one, so pasting and
 * hitting Enter within the same beat lands on the same card as waiting for
 * the row to appear first — the destination must not depend on the network.
 */
export async function jumpIssuePromise(
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
