import { useQuery } from "@tanstack/react-query";
import { type IssueMove, ownerAt } from "@todou/shared";
import { createContext, type ReactNode, useContext, useMemo } from "react";
import { projectsQuery } from "@/api/queries.ts";

/**
 * `undefined` = the current project (the ordinary case), a slug = the
 * project that owned the card when the text was written, `null` = a project
 * this reader cannot see, so nothing about its numbering can be assumed.
 */
type OriginAt = (at: string | undefined) => string | null | undefined;

const IssueOriginContext = createContext<OriginAt>(() => undefined);

/**
 * Makes every piece of markdown under it resolve its bare `#N` refs under
 * whoever owned the card when that text was written (T-231).
 *
 * A provider rather than a prop on each renderer: the card's text reaches
 * the page through a dozen components — body, comments, questions, spec
 * files, attachment previews — and every one of them would otherwise have
 * to forward the same two values, with a missed one silently resolving a
 * reference against the wrong project's numbering.
 */
export function IssueOriginProvider({
  moves,
  currentProjectId,
  children,
}: {
  moves: IssueMove[];
  currentProjectId: number | undefined;
  children: ReactNode;
}) {
  const projects = useQuery({
    ...projectsQuery,
    // Nothing to translate for a card that has never moved.
    enabled: moves.length > 0,
  });

  const value = useMemo<OriginAt>(() => {
    if (moves.length === 0 || currentProjectId === undefined) {
      return () => undefined;
    }
    const slugById = new Map(
      (projects.data ?? []).map((project) => [project.id, project.slug]),
    );
    return (at) => {
      if (at === undefined) return undefined;
      const owner = ownerAt(moves, currentProjectId, at);
      if (owner === null) return null;
      if (owner === currentProjectId) return undefined;
      // Readable project ids are the ones this list carries, so a miss is a
      // project the reader has no access to.
      return slugById.get(owner) ?? null;
    };
  }, [moves, currentProjectId, projects.data]);

  return (
    <IssueOriginContext.Provider value={value}>
      {children}
    </IssueOriginContext.Provider>
  );
}

/** The project a piece of content dated `at` should be read under. */
export function useOriginSlugAt(
  at: string | undefined,
): string | null | undefined {
  return useContext(IssueOriginContext)(at);
}
