import {
  QueryClient,
  QueryClientProvider,
  useQuery,
} from "@tanstack/react-query";
import type {
  Issue,
  IssueListItem,
  Project,
  ReferenceConfig,
  ReferenceDirectory,
} from "@todou/shared";
import { type ReactNode, useState } from "react";
import { issueRefQuery } from "@/api/issue-refs.ts";
import { prefsQuery } from "@/api/prefs.ts";
import { projectsQuery } from "@/api/queries.ts";
import {
  referenceConfigQuery,
  referenceDirectoryQuery,
} from "@/api/references.ts";
import { IssueRow, useIssueListGrid } from "@/components/issue/issue-row.tsx";
import { IssueLink } from "@/components/shared/issue-link.tsx";
import { MarkdownView } from "@/components/shared/markdown-view.tsx";
import { BoardCardContent } from "@/pages/board.tsx";
import { TitleBlock } from "@/pages/issue-detail.tsx";

const SLUG = "design";

const CONFIG: ReferenceConfig = {
  format: { prefix: "DES", history: [] },
  autolinks: [],
};

function previewIssue(
  number: number,
  title: string,
  category: "open" | "closed",
  extra: Partial<IssueListItem> = {},
): IssueListItem {
  return {
    id: number,
    number,
    title,
    status: {
      id: category === "open" ? 1 : 2,
      name: category === "open" ? "In Progress" : "Done",
      category,
      color: category === "open" ? "#1a7f37" : "#8250df",
      position: category === "open" ? 1 : 2,
      is_default: false,
    },
    author: ALICE,
    assignees: [],
    labels: [],
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    body_edited_at: null,
    open_questions: 0,
    spec_version: null,
    spec_review_status: null,
    spec_unresolved_comments: 0,
    deleted_at: null,
    deleted_by: null,
    unread: false,
    unread_comments: 0,
    muted: null,
    blocked_by: [],
    blocks: [],
    moves: [],
    ...extra,
  };
}

const ALICE = {
  id: 1,
  login: "alice",
  display_name: "Alice Liddell",
  kind: "human",
  avatar_url: null,
  owner: null,
} satisfies IssueListItem["author"];

const SIGN_IN = previewIssue(
  12,
  "Sign-in forgets the page you came from",
  "open",
  {
    assignees: [ALICE],
    labels: [{ id: 1, name: "bug", color: "#d73a4a" }],
  },
);
const EXPORT = previewIssue(
  31,
  "Exported CSV drops every row after the first one with an empty description",
  "closed",
);
const SHORT = previewIssue(9, "Dark mode for the board", "open");

const BODY = [
  `Blocked on [DES-12](/projects/${SLUG}/issues/12), which also broke`,
  `[DES-31](/projects/${SLUG}/issues/31). Retest once`,
  `[DES-12](/projects/${SLUG}/issues/12) lands.`,
].join(" ");

/**
 * Every query the samples below read, answered up front. The samples are the
 * real components, so a key left out here would go to the server asking for a
 * card that does not exist.
 */
function createPreviewClient(): QueryClient {
  const client = new QueryClient({
    defaultOptions: {
      queries: { enabled: false, staleTime: Infinity, gcTime: Infinity },
    },
  });
  client.setQueryData(referenceConfigQuery(SLUG).queryKey, CONFIG);
  client.setQueryData<ReferenceDirectory | null>(
    referenceDirectoryQuery.queryKey,
    null,
  );
  client.setQueryData<Project[]>(projectsQuery.queryKey, []);
  for (const issue of [SIGN_IN, EXPORT, SHORT]) {
    client.setQueryData(issueRefQuery(SLUG, issue.number).queryKey, issue);
  }
  return client;
}

/**
 * Samples drawn by the components every other surface uses, against made-up
 * cards held in a cache of their own: seeding them into the app's cache would
 * put them behind a real project's slug, and the next invalidation would
 * fetch them. Hidden from assistive tech, inert so nothing in them can be
 * hovered or followed.
 */
function PreviewSandbox({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  const prefs = useQuery(prefsQuery).data;
  const [client] = useState(createPreviewClient);
  // Copied during render rather than in an effect, so the samples draw the
  // value a switch was just flipped to in the same frame as the switch.
  if (
    prefs !== undefined &&
    client.getQueryData(prefsQuery.queryKey) !== prefs
  ) {
    client.setQueryData(prefsQuery.queryKey, prefs);
  }
  return (
    <QueryClientProvider client={client}>
      <div
        aria-hidden="true"
        inert
        data-appearance-preview=""
        className={className}
      >
        {children}
      </div>
    </QueryClientProvider>
  );
}

function ListSample() {
  const grid = useIssueListGrid({ readMarker: false });
  return (
    <ul className={`${grid} rounded-md border bg-background`}>
      {[SHORT, SIGN_IN].map((issue) => (
        <IssueRow
          key={issue.id}
          slug={SLUG}
          issue={issue}
          readMarker={false}
          badges={false}
          blocked={false}
          returnAnchor={false}
        />
      ))}
    </ul>
  );
}

export function ListPreview() {
  return (
    <PreviewSandbox>
      <ListSample />
    </PreviewSandbox>
  );
}

export function BoardPreview() {
  return (
    <PreviewSandbox>
      <div className="w-64 rounded-md border bg-background p-2.5 shadow-xs">
        <BoardCardContent slug={SLUG} issue={SIGN_IN} />
      </div>
    </PreviewSandbox>
  );
}

const DETAIL: Issue = { ...SHORT, body: "" };

export function DetailPreview() {
  return (
    <PreviewSandbox>
      <TitleBlock slug={SLUG} issue={DETAIL} readOnly />
    </PreviewSandbox>
  );
}

export function ReferencePreview() {
  return (
    <PreviewSandbox className="text-sm">
      <IssueLink slug={SLUG} number={SIGN_IN.number} pageSlug={SLUG} />
    </PreviewSandbox>
  );
}

export function BodyReferencesPreview() {
  return (
    <PreviewSandbox>
      <MarkdownView slug={SLUG}>{BODY}</MarkdownView>
    </PreviewSandbox>
  );
}
