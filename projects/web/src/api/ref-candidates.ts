import { useQuery } from "@tanstack/react-query";
import type { IssueListItem } from "@todou/shared";
import { useEffect, useRef } from "react";
import { issueRefQuery } from "@/api/issue-refs.ts";
import {
  issueCompletionQuery,
  issueCompletionSearchQuery,
  recentOpenIssuesQuery,
} from "@/api/issues.ts";
import { projectsQuery } from "@/api/queries.ts";
import {
  referenceConfigQuery,
  referenceDirectoryQuery,
} from "@/api/references.ts";
import {
  type ProjectRefOption,
  projectSpellings,
} from "@/lib/project-spellings.ts";
import {
  MIN_PROJECT_QUERY,
  pickerTriggerAt,
  projectTriggerAt,
  rankCandidates,
} from "@/lib/ref-completion.ts";

export type RefCandidates = {
  projects: ProjectRefOption[];
  open: IssueListItem[];
  closed: IssueListItem[];
  target: string;
  anchor: string;
  typedTarget: { slug: string; number: number } | null;
};

// Reserve one row for the picker’s manual-ref fallback.
const MAX_OPTIONS = 19;

export function useRefCandidates(
  slug: string,
  value: string,
  enabled: boolean,
  exclude: ReadonlyArray<{ slug: string; number: number }>,
): RefCandidates {
  const config = useQuery({ ...referenceConfigQuery(slug), enabled });
  const directory = useQuery({ ...referenceDirectoryQuery, enabled });
  const projects = useQuery({ ...projectsQuery, enabled });
  const ready =
    config.data !== undefined &&
    directory.data !== undefined &&
    projects.data !== undefined;
  const trigger = ready
    ? pickerTriggerAt(
        value,
        {
          slug,
          prefix: config.data.format.prefix,
          readableSlugs: projects.data.map((project) => project.slug),
          directory: directory.data,
          autolinks: config.data.autolinks,
        },
        typeof window === "undefined"
          ? "https://todou.example"
          : window.location.origin,
      )
    : null;
  const cards = trigger?.kind === "cards" ? trigger : null;
  const target = cards?.slug ?? slug;
  const query = cards?.query ?? "";
  const numeric = /^[0-9]+$/.test(query);

  const recent = useQuery({
    ...recentOpenIssuesQuery(target, 8),
    enabled: enabled && ready && cards !== null && query === "",
  });
  const completion = useQuery({
    ...issueCompletionQuery(target),
    enabled: enabled && ready && cards !== null && query !== "",
  });
  const exact = useQuery({
    ...issueRefQuery(target, numeric ? Number(query) : 0),
    enabled: enabled && ready && cards !== null && numeric,
  });
  const search = useQuery({
    ...issueCompletionSearchQuery(target, query),
    enabled:
      enabled && ready && cards !== null && !numeric && query.length >= 2,
  });

  const previous = useRef<RefCandidates | null>(null);
  const waiting =
    cards !== null &&
    (query === ""
      ? recent.isPending && recent.isFetching
      : (completion.isPending && completion.isFetching) ||
        (numeric
          ? exact.isPending && exact.isFetching
          : query.length >= 2 && search.isPending && search.isFetching));
  const typedTarget =
    cards !== null && numeric ? { slug: target, number: Number(query) } : null;

  const projectRows: ProjectRefOption[] = [];
  if (cards !== null && !cards.fromShape && query !== "") {
    const word = projectTriggerAt(value.trim());
    if (word !== null && word.typed.length >= MIN_PROJECT_QUERY) {
      const lower = word.typed.toLowerCase();
      for (const project of projectSpellings(projects.data, directory.data)) {
        const spelling = project.spellings.find(
          (candidate) =>
            candidate.toLowerCase().startsWith(lower) &&
            candidate.toLowerCase() !== lower,
        );
        if (spelling !== undefined) {
          projectRows.push({ ...project, spellings: [spelling] });
        }
      }
    }
  }

  let items: IssueListItem[];
  if (query === "") {
    items = [...(recent.data?.items ?? [])];
  } else {
    items = rankCandidates(completion.data?.items ?? [], query);
    const seen = new Set(items.map((item) => item.number));
    if (numeric) {
      const asked = Number(query);
      if (exact.data !== null && exact.data !== undefined && !seen.has(asked)) {
        items.unshift({ ...exact.data, number: asked });
      }
    } else {
      for (const item of query.length >= 2 ? (search.data?.items ?? []) : []) {
        if (!seen.has(item.number)) {
          seen.add(item.number);
          items.push(item);
        }
      }
    }
    if (!numeric) {
      items.sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at));
    }
  }

  const snapshot: RefCandidates = {
    projects: projectRows,
    open: items.filter((item) => item.status.category === "open"),
    closed: items.filter((item) => item.status.category === "closed"),
    target,
    anchor: cards?.anchor ?? "",
    typedTarget,
  };
  useEffect(() => {
    if (enabled && ready && cards !== null && !waiting) {
      previous.current = snapshot;
    }
  });
  if (!enabled || !ready || cards === null) {
    return {
      projects: [],
      open: [],
      closed: [],
      target: slug,
      anchor: "",
      typedTarget,
    };
  }
  // Retain the entire old list, including its spelling and project. Relabeling
  // old query data with the new target would let one keystroke add another card.
  const result =
    waiting && previous.current !== null ? previous.current : snapshot;
  const allowed = (item: IssueListItem) =>
    !exclude.some(
      (excluded) =>
        excluded.slug === result.target && excluded.number === item.number,
    );
  const projectOptions = result.projects.slice(0, MAX_OPTIONS);
  const budget = MAX_OPTIONS - projectOptions.length;
  const open = result.open.filter(allowed).slice(0, budget);
  const closed = result.closed.filter(allowed).slice(0, budget - open.length);
  return { ...result, projects: projectOptions, open, closed, typedTarget };
}
