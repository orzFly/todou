import {
  useMutation,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query";
import { useParams } from "@tanstack/react-router";
import { formatRef, type Issue, type Member, type Status } from "@todou/shared";
import { CheckIcon, PencilIcon, Trash2Icon, XIcon } from "lucide-react";
import { useRef, useState } from "react";
import { toast } from "sonner";
import {
  issueQuery,
  useIssueStatusMutation,
  useRestoreIssueMutation,
} from "@/api/issues.ts";
import { useRefPlacement } from "@/api/prefs.ts";
import {
  api,
  labelsQuery,
  membersQuery,
  meQuery,
  statusesQuery,
} from "@/api/queries.ts";
import { useRefPrefix } from "@/api/references.ts";
import { AssigneePicker } from "@/components/issue/assignee-picker.tsx";
import {
  AttachmentList,
  AttachmentSidebarSection,
} from "@/components/issue/attachment-list.tsx";
import { BlocksSection } from "@/components/issue/blocks-section.tsx";
import {
  EntryActionsMenu,
  QUOTE_REHYPE_PLUGINS,
} from "@/components/issue/entry-actions-menu.tsx";
import { IssueReturnRow } from "@/components/issue/issue-return-row.tsx";
import { LabelChips } from "@/components/issue/label-chip.tsx";
import {
  LabelPicker,
  useCanCreateLabels,
  useCreateLabel,
} from "@/components/issue/label-picker.tsx";
import { MarkReadOnView } from "@/components/issue/mark-read-on-view.tsx";
import { MetadataSection } from "@/components/issue/metadata-section.tsx";
import { IssueMoreActions } from "@/components/issue/more-actions-menu.tsx";
import { MuteMenu } from "@/components/issue/mute-menu.tsx";
import { SidebarSection } from "@/components/issue/sidebar-section.tsx";
import {
  SpecEntryRow,
  SpecSidebarSection,
} from "@/components/issue/spec-entry.tsx";
import {
  StagedFileTray,
  StagedFileUploadButton,
  useStagedFiles,
} from "@/components/issue/staged-files.tsx";
import { StatusPill } from "@/components/issue/status-pill.tsx";
import {
  MarkdownEditor,
  type MarkdownEditorHandle,
} from "@/components/shared/markdown-editor.tsx";
import { MarkdownView } from "@/components/shared/markdown-view.tsx";
import { RevisionHistory } from "@/components/shared/revision-history.tsx";
import { displayNameOf, UserChip } from "@/components/shared/user-chip.tsx";
import {
  Composer,
  useCommentComposer,
  withAttachmentMarkers,
} from "@/components/timeline/composer.tsx";
import { QuoteReplyProvider } from "@/components/timeline/quote-reply.tsx";
import { RevealAllEye } from "@/components/timeline/reveal-all-eye.tsx";
import { RevealedRunsProvider } from "@/components/timeline/revealed-runs.tsx";
import { Timeline } from "@/components/timeline/timeline.tsx";
import { TimelineDivider } from "@/components/timeline/timeline-divider.tsx";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { useRefCompletion } from "@/lib/editor/ref-completion.ts";
import { useScrollInsets } from "@/lib/scroll-insets.ts";
import { useDirtySource } from "@/lib/unsaved-guard.ts";

export function IssueDetailPage() {
  const { slug, number: numberParam } = useParams({
    from: "/authed/projects/$slug/issues/$number",
  });
  const issueNumber = Number(numberParam);

  const me = useSuspenseQuery(meQuery);
  const issue = useSuspenseQuery(issueQuery(slug, issueNumber));
  const statuses = useSuspenseQuery(statusesQuery(slug));
  const labels = useSuspenseQuery(labelsQuery(slug));
  const members = useSuspenseQuery(membersQuery(slug));

  const composer = useCommentComposer(slug, issueNumber, me.data);
  // Wraps TitleBlock rather than living inside it, so the trigger for the
  // return row's title mirror is unaffected by the block swapping itself for
  // the rename form.
  const titleRef = useRef<HTMLDivElement>(null);
  // Reserve clearance for the title mirror and composer when jumping to a
  // timeline anchor, including before the mirror becomes visible (T-299).
  const rowRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLDivElement>(null);
  useScrollInsets({ top: [rowRef], bottom: [composerRef] });
  const membership = members.data.find((m) => m.user.id === me.data.id);
  const isAdmin = membership?.role === "admin";
  const viewer = {
    id: me.data.id,
    isAdmin,
    role: membership?.role ?? null,
  };
  // Only the author or an admin can even reach a deleted card, so anyone
  // seeing this banner may act on it (T-145).
  const trashed = issue.data.deleted_at !== null;
  // Built from the route params, never from `location`: a `#comment-<id>`
  // permalink changes the location, and opening the run it names is exactly
  // what the reveal state is for (T-327).
  const cardKey = `${slug}/${issueNumber}`;

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_240px]">
      {/* Nothing in the trash is ever unread, so there is no position to
        advance while looking at one — the endpoint would 404. */}
      {!trashed && <MarkReadOnView slug={slug} number={issueNumber} />}
      {/* Above both the row and the timeline: the row only mirrors the
        reveal entry the timeline's own section line carries (T-281). */}
      <RevealedRunsProvider card={cardKey}>
        {/* Inside, so one provider covers both the timeline the Quote reply
            entries live in and the Composer they write into. */}
        <QuoteReplyProvider>
          <div className="min-w-0">
            {/* The wide-screen return link sits in the main container's gutter;
                its title mirror overlays this column once the heading leaves. */}
            <IssueReturnRow
              slug={slug}
              issue={issue.data}
              watchTarget={titleRef}
              rowRef={rowRef}
              mirror={<RevealAllEye />}
            />
            <div className="space-y-4">
              {trashed && <TrashBanner slug={slug} issue={issue.data} />}
              <div ref={titleRef}>
                <TitleBlock slug={slug} issue={issue.data} readOnly={trashed} />
              </div>
              <BodyBlock slug={slug} issue={issue.data} readOnly={trashed} />
              <SpecEntryRow slug={slug} issueNumber={issueNumber} />
              {/* Keyed for the same reason as `Timeline` and `Composer`
                  below: `/issues/7 → /issues/8` is one route with a changed
                  param, so this instance is reused and its fold — "I am
                  reading the older files on card 7" — would greet the reader
                  on card 8 (T-317). The prefix is what keeps the value off
                  its sibling `Timeline`'s: one value cannot hold two places
                  in React's list, so keyed alike the outgoing section is
                  neither matched nor removed and its DOM node stays on the
                  page, one more per jump (T-402). */}
              <AttachmentList
                key={`attachments-${cardKey}`}
                slug={slug}
                issueNumber={issueNumber}
              />
              <TimelineDivider />
              <Timeline
                // The row keys inside `Timeline` carry no card, so a jump to
                // another card that shares a comment id would reuse the row's
                // instance and let its in-flight write follow the new props.
                // The slug is in the key because that reuse is what makes a
                // cross-project jump destructive rather than a 404. Same remedy
                // and same reason as the `Composer` below. Prefixed against
                // the sibling above, as that comment sets out.
                key={`timeline-${cardKey}`}
                slug={slug}
                issueNumber={issueNumber}
                pendingComments={composer.pending.filter((p) => !p.failed)}
                viewer={viewer}
              />
              {/* Floats at the viewport bottom while the timeline scrolls by,
              and settles into flow at the end of the page (GitHub-style). */}
              {!trashed && (
                <div
                  ref={composerRef}
                  className="sticky bottom-0 z-10 border-t bg-background pt-3 pb-4"
                >
                  <Composer
                    // `/issues/7 → /issues/8` is one route with a changed param,
                    // so the router keeps this subtree and nothing remounts. The
                    // key is what empties the box on arrival at the next card:
                    // the draft, the staged files and the editor's own document
                    // all go together, instead of a lit-up button over an empty
                    // box that submits nothing. Resetting from inside instead
                    // does not survive Strict Mode's double render of the
                    // transition (T-317).
                    key={issueNumber}
                    slug={slug}
                    issueNumber={issueNumber}
                    onSend={composer.send}
                    onSendWithCommands={composer.sendWithCommands}
                    failed={composer.pending.filter((p) => p.failed)}
                    onRetry={composer.retry}
                  />
                </div>
              )}
            </div>
          </div>
        </QuoteReplyProvider>
      </RevealedRunsProvider>
      <Sidebar
        slug={slug}
        issue={issue.data}
        statuses={statuses.data}
        allLabels={labels.data}
        members={members.data}
        canDelete={isAdmin || issue.data.author.id === me.data.id}
        trashed={trashed}
      />
    </div>
  );
}

/**
 * What a trashed card wears instead of its edit affordances. The restore
 * button sits in the banner rather than the sidebar because it is the one
 * thing to do on this page, and the banner is what explains why.
 */
function TrashBanner({ slug, issue }: { slug: string; issue: Issue }) {
  const restore = useRestoreIssueMutation();
  const by = issue.deleted_by ? displayNameOf(issue.deleted_by) : "someone";
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm">
      <Trash2Icon className="size-4 shrink-0 text-destructive" />
      <span>
        In the trash — deleted by {by}
        {issue.deleted_at && (
          <span title={issue.deleted_at}>
            {" "}
            on {new Date(issue.deleted_at).toLocaleString()}
          </span>
        )}
        .
      </span>
      <Button
        size="sm"
        variant="outline"
        className="ml-auto"
        disabled={restore.isPending}
        onClick={() => restore.mutate({ slug, issueNumber: issue.number })}
      >
        Restore
      </Button>
    </div>
  );
}

export function TitleBlock({
  slug,
  issue,
  readOnly = false,
}: {
  slug: string;
  issue: Issue;
  readOnly?: boolean;
}) {
  const refPrefix = useRefPrefix(slug);
  const refLeads = useRefPlacement("detail") === "before";
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(issue.title);
  const queryClient = useQueryClient();
  const rename = useMutation({
    // The card is sealed in when the form is submitted, not read back off the
    // closure: this is one route with a changed param, so the page keeps
    // running across `/issues/7 → /issues/8` and every settle-time callback
    // would otherwise run against the new card.
    mutationFn: (target: { slug: string; number: number; title: string }) =>
      api.updateIssue(target.slug, target.number, { title: target.title }),
    onSuccess: (_updated, target) => {
      queryClient.invalidateQueries({
        queryKey: ["issue", target.slug, target.number],
      });
      queryClient.invalidateQueries({ queryKey: ["issues", target.slug] });
      queryClient.invalidateQueries({
        queryKey: ["timeline", target.slug, target.number],
      });
      setEditing(false);
    },
    onError: (error) => toast.error(error.message),
  });

  // A rename is the one page write with no editor behind it, so nothing else
  // reports it: without this the guard asks nothing before leaving a title
  // that has not landed.
  useDirtySource(() => rename.isPending);

  if (editing) {
    return (
      <form
        className="flex items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          rename.mutate({ slug, number: issue.number, title });
        }}
      >
        <Input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          className="text-lg font-semibold"
        />
        <Button type="submit" size="icon-sm" aria-label="save title">
          <CheckIcon className="size-4" />
        </Button>
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          aria-label="cancel"
          onClick={() => {
            setTitle(issue.title);
            setEditing(false);
          }}
        >
          <XIcon className="size-4" />
        </Button>
      </form>
    );
  }
  return (
    <div className="flex items-start justify-between gap-2">
      {/* `wrap-break-word` is not enough here: `min-width: auto` still sizes
          this flex item to its longest word, so a title carrying one long
          unbroken token stretches the box past the viewport and the whole page
          scrolls sideways. `anywhere` is the variant that also folds the
          soft-wrap opportunities into the min-content width. */}
      <h1 className="text-2xl font-semibold wrap-anywhere">
        {refLeads ? (
          <>
            <span className="font-normal text-muted-foreground">
              {formatRef(refPrefix, issue.number)}
            </span>{" "}
            {issue.title}
          </>
        ) : (
          <>
            {issue.title}{" "}
            <span className="font-normal text-muted-foreground">
              {formatRef(refPrefix, issue.number)}
            </span>
          </>
        )}
      </h1>
      {!readOnly && (
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label="edit title"
          onClick={() => setEditing(true)}
        >
          <PencilIcon className="size-4" />
        </Button>
      )}
    </div>
  );
}

/** Exported so tests can mount just the body editor; the page needs seven queries seeded. */
export function BodyBlock({
  slug,
  issue,
  readOnly = false,
}: {
  slug: string;
  issue: Issue;
  readOnly?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const editor = useRef<MarkdownEditorHandle>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const refCompletion = useRefCompletion(slug);
  const [uploading, setUploading] = useState(false);
  const staging = useStagedFiles();
  const queryClient = useQueryClient();
  const save = useMutation({
    mutationFn: (vars: { slug: string; issueNumber: number; body: string }) =>
      api.updateIssue(vars.slug, vars.issueNumber, { body: vars.body }),
    onSuccess: (_updated, vars) => {
      queryClient.invalidateQueries({
        queryKey: ["issue", vars.slug, vars.issueNumber],
      });
      setEditing(false);
      staging.clear();
    },
    onError: (error) => toast.error(error.message),
  });

  async function handleSave() {
    if (uploading) return;
    // Read before the first `await`, for the same reason the composer does:
    // the upload is a real request, and by the time it answers the page may be
    // showing another card — whose body this PATCH would then overwrite with
    // this card's draft.
    const target = { slug, issueNumber: issue.number };
    const body = (editor.current?.getValue() ?? issue.body).trimEnd();
    let full = body;
    if (staging.staged.length > 0) {
      setUploading(true);
      try {
        const markers = await staging.uploadAll(
          target.slug,
          target.issueNumber,
        );
        full = withAttachmentMarkers(body, markers);
      } catch (error) {
        toast.error(`Could not upload files: ${(error as Error).message}`);
        return;
      } finally {
        setUploading(false);
      }
    }
    save.mutate({ ...target, body: full });
  }

  return (
    <div className="rounded-lg border">
      <div className="flex items-baseline gap-2 border-b bg-muted/40 px-3 py-1.5 text-sm">
        <UserChip user={issue.author} />
        <span
          className="shrink-0 text-xs whitespace-nowrap text-muted-foreground"
          title={issue.created_at}
        >
          {new Date(issue.created_at).toLocaleString()}
        </span>
        {issue.body_edited_at && (
          <RevisionHistory
            label="description"
            editedAt={issue.body_edited_at}
            filename="description.md"
            queryKey={["revisions", slug, issue.number, "issue_body"]}
            fetchRevisions={() => api.getIssueRevisions(slug, issue.number)}
          />
        )}
        <div className="ml-auto flex shrink-0 self-center items-center gap-0.5">
          {!readOnly && (
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label="edit body"
              onClick={() => {
                // The editor mounts fresh off issue.body, so entering edit mode
                // always starts from what is on screen.
                staging.clear();
                setEditing(!editing);
              }}
            >
              <PencilIcon className="size-3.5" />
            </Button>
          )}
          <EntryActionsMenu
            slug={slug}
            issueNumber={issue.number}
            body={issue.body}
            bodyRef={bodyRef}
            label="description actions"
          />
        </div>
      </div>
      <div className="px-3 py-2">
        {editing ? (
          <div className="space-y-2">
            <MarkdownEditor
              ref={editor}
              initialValue={issue.body}
              ariaLabel="Issue description"
              className="min-h-44"
              placeholder="Describe the issue… (paste or drop files)"
              extensions={refCompletion}
              onSubmit={() => void handleSave()}
              onPaste={staging.onPaste}
              onDrop={staging.onDrop}
              onDragOver={staging.onDragOver}
            />
            <StagedFileTray
              staged={staging.staged}
              onRemove={staging.remove}
              disabled={uploading}
            />
            <div className="flex justify-end gap-2">
              <StagedFileUploadButton
                onFiles={staging.stage}
                disabled={uploading}
                label="Attach files"
                className="mr-auto"
              />
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  staging.clear();
                  setEditing(false);
                }}
              >
                Cancel
              </Button>
              <Button
                size="sm"
                disabled={uploading}
                onClick={() => void handleSave()}
              >
                {uploading ? "Uploading…" : "Save"}
              </Button>
            </div>
          </div>
        ) : issue.body.trim() === "" ? (
          <p className="text-sm text-muted-foreground italic">
            No description.
          </p>
        ) : (
          <div ref={bodyRef}>
            <MarkdownView
              slug={slug}
              issueNumber={issue.number}
              rehypePlugins={QUOTE_REHYPE_PLUGINS}
            >
              {issue.body}
            </MarkdownView>
          </div>
        )}
      </div>
    </div>
  );
}

export function Sidebar({
  slug,
  issue,
  statuses,
  allLabels,
  members,
  canDelete,
  trashed,
}: {
  slug: string;
  issue: Issue;
  statuses: Status[];
  allLabels: Array<{ id: number; name: string; color: string }>;
  members: Member[];
  canDelete: boolean;
  trashed: boolean;
}) {
  const queryClient = useQueryClient();
  const statusMutation = useIssueStatusMutation();
  const canCreateLabels = useCanCreateLabels(slug);
  const createLabel = useCreateLabel(slug);
  const patch = useMutation({
    // The card rides in the variables so the request and the settle-time
    // invalidation read it from there rather than from this closure, which
    // `/issues/7 → /issues/8` moves out from under them.
    mutationFn: (vars: {
      slug: string;
      issueNumber: number;
      label_ids?: number[];
      assignee_ids?: number[];
    }) =>
      api.updateIssue(vars.slug, vars.issueNumber, {
        ...(vars.label_ids === undefined ? {} : { label_ids: vars.label_ids }),
        ...(vars.assignee_ids === undefined
          ? {}
          : { assignee_ids: vars.assignee_ids }),
      }),
    onSettled: (_data, _error, vars) => {
      queryClient.invalidateQueries({
        queryKey: ["issue", vars.slug, vars.issueNumber],
      });
      queryClient.invalidateQueries({ queryKey: ["issues", vars.slug] });
      queryClient.invalidateQueries({
        queryKey: ["timeline", vars.slug, vars.issueNumber],
      });
    },
    onError: (error) => toast.error(error.message),
  });

  // A label toggle is a write with no editor behind it, so nothing else
  // reports it to the guard.
  useDirtySource(() => patch.isPending);

  const patchTarget = { slug, issueNumber: issue.number };

  return (
    // Sticky on large screens (T-63): the sidebar keeps Status and the
    // Latest spec section in view while the timeline scrolls; when taller
    // than the viewport it scrolls internally.
    <aside className="min-w-0 space-y-3 text-sm lg:sticky lg:top-20 lg:max-h-[calc(100vh-6rem)] lg:self-start lg:overflow-y-auto">
      <SidebarSection name="status" title="Status">
        {trashed ? (
          <StatusPill status={issue.status} />
        ) : (
          <DropdownMenu>
            <DropdownMenuTrigger className="cursor-pointer">
              <StatusPill status={issue.status} />
            </DropdownMenuTrigger>
            <DropdownMenuContent>
              {statuses.map((s) => (
                <DropdownMenuItem
                  key={s.id}
                  onSelect={() =>
                    statusMutation.mutate({
                      slug,
                      issueNumber: issue.number,
                      status: s,
                    })
                  }
                >
                  <span className="w-4">
                    {s.id === issue.status.id && (
                      <CheckIcon className="size-4" />
                    )}
                  </span>
                  <StatusPill status={s} className="border-0 px-0" />
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </SidebarSection>

      <SidebarSection
        name="labels"
        title="Labels"
        action={
          !trashed && (
            <LabelPicker
              allLabels={allLabels}
              selected={issue.labels}
              onToggle={(label) => {
                const current = issue.labels.map((l) => l.id);
                patch.mutate({
                  ...patchTarget,
                  label_ids: current.includes(label.id)
                    ? current.filter((id) => id !== label.id)
                    : [...current, label.id],
                });
              }}
              onCreate={canCreateLabels ? createLabel : undefined}
              trigger={
                <Button variant="ghost" size="icon-xs" aria-label="Edit labels">
                  <PencilIcon className="size-3.5" />
                </Button>
              }
            />
          )
        }
      >
        {issue.labels.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5">
            <LabelChips labels={issue.labels} truncate />
          </div>
        )}
      </SidebarSection>

      <SidebarSection
        name="assignees"
        title="Assignees"
        action={
          !trashed && (
            <AssigneePicker
              members={members}
              selectedIds={issue.assignees.map((a) => a.id)}
              onToggle={(userId) => {
                const current = issue.assignees.map((a) => a.id);
                patch.mutate({
                  ...patchTarget,
                  assignee_ids: current.includes(userId)
                    ? current.filter((id) => id !== userId)
                    : [...current, userId],
                });
              }}
              trigger={
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label="Edit assignees"
                >
                  <PencilIcon className="size-3.5" />
                </Button>
              }
            />
          )
        }
      >
        {issue.assignees.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {issue.assignees.map((user) => (
              <UserChip key={user.id} user={user} />
            ))}
          </div>
        )}
      </SidebarSection>

      <BlocksSection slug={slug} issue={issue} trashed={trashed} />

      <MuteMenu slug={slug} issueNumber={issue.number} />

      <SpecSidebarSection slug={slug} issueNumber={issue.number} />

      <AttachmentSidebarSection slug={slug} issueNumber={issue.number} />

      <MetadataSection slug={slug} issueNumber={issue.number} />

      {canDelete && !trashed && <IssueMoreActions slug={slug} issue={issue} />}
    </aside>
  );
}
