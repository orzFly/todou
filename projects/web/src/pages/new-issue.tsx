import {
  useQuery,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query";
import { useNavigate, useParams, useSearch } from "@tanstack/react-router";
import type {
  Issue,
  IssueCreateInput,
  IssueMuteMode,
  IssueUpdateInput,
  Status,
} from "@todou/shared";
import { PencilIcon } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { issueQuery } from "@/api/issues.ts";
import { invalidateAfterMute } from "@/api/mutes.ts";
import {
  api,
  labelsQuery,
  membersQuery,
  statusesQuery,
  useCan,
} from "@/api/queries.ts";
import { searchCommentRefQuery as commentRefQuery } from "@/api/search-refs.ts";
import { AssigneePicker } from "@/components/issue/assignee-picker.tsx";
import { LabelChips } from "@/components/issue/label-chip.tsx";
import {
  LabelPicker,
  useCanCreateLabels,
  useCreateLabel,
} from "@/components/issue/label-picker.tsx";
import { MuteControl } from "@/components/issue/mute-menu.tsx";
import { SidebarSection } from "@/components/issue/sidebar-section.tsx";
import {
  StagedBlockSections,
  useStagedBlocks,
} from "@/components/issue/staged-blocks.tsx";
import {
  StagedFileTray,
  StagedFileUploadButton,
  useStagedFiles,
} from "@/components/issue/staged-files.tsx";
import { PageSkeleton } from "@/components/page-skeleton.tsx";
import { CommandErrors } from "@/components/shared/command-errors.tsx";
import {
  MarkdownEditor,
  type MarkdownEditorHandle,
} from "@/components/shared/markdown-editor.tsx";
import { UserChip } from "@/components/shared/user-chip.tsx";
import {
  useCommandRegistry,
  withAttachmentMarkers,
} from "@/components/timeline/composer.tsx";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { mentionCompletionSource } from "@/lib/editor/mention-completion.ts";
import {
  completionWith,
  refCompletionSource,
} from "@/lib/editor/ref-completion.ts";
import {
  commandCompletionSource,
  commandDecoration,
} from "@/lib/editor/slash-commands.ts";
import { quotedReference } from "@/lib/quote-markdown.ts";
import {
  applyDraftCommands,
  newIssueSubmitLabel,
  parseCommandLines,
} from "@/lib/slash-commands.ts";
import { commentAnchor } from "@/lib/timeline-anchors.ts";
import { useDirtySource } from "@/lib/unsaved-guard.ts";
import { cn } from "@/lib/utils";

// Mirrors the server's choice when no status is sent with a new issue.
export function pickDefaultStatus(statuses: Status[]): Status | undefined {
  return statuses.find((s) => s.is_default) ?? statuses[0];
}

/**
 * The form, plus whatever it is opened to quote. Two layers because
 * `MarkdownEditor` reads `initialValue` once at mount and the quoted text
 * arrives from the network: the form may not mount before it is here.
 */
export function NewIssuePage() {
  const { slug } = useParams({ from: "/authed/projects/$slug/issues/new" });
  const search = useSearch({ from: "/authed/projects/$slug/issues/new" });
  const { quote_issue: quotedIssue, quote_comment: quotedComment } = search;
  const from = search.quote_project ?? slug;

  const comment = useQuery({
    ...commentRefQuery(from, quotedIssue ?? 0, quotedComment ?? 0),
    enabled: quotedIssue !== undefined && quotedComment !== undefined,
  });
  const issue = useQuery({
    ...issueQuery(from, quotedIssue ?? 0),
    enabled: quotedIssue !== undefined && quotedComment === undefined,
  });

  if (quotedIssue === undefined) return <NewIssueForm slug={slug} />;
  const source = quotedComment === undefined ? issue : comment;
  if (source.isLoading) return <PageSkeleton kind="sections" />;

  const quoted = source.data ?? null;
  const address = `${window.location.origin}/projects/${from}/issues/${quotedIssue}`;
  return (
    <NewIssueForm
      slug={slug}
      initialBody={
        quoted === null
          ? ""
          : quotedReference({
              body: quoted.body,
              authorLogin: quoted.author.login,
              permalink:
                quotedComment === undefined
                  ? address
                  : `${address}#${commentAnchor(quotedComment)}`,
            })
      }
      quoteMissing={quoted === null}
    />
  );
}

function NewIssueForm({
  slug,
  initialBody = "",
  quoteMissing = false,
}: {
  slug: string;
  initialBody?: string;
  /** The page was opened to quote something it could not read. */
  quoteMissing?: boolean;
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const statuses = useSuspenseQuery(statusesQuery(slug));
  const labels = useSuspenseQuery(labelsQuery(slug));
  const members = useSuspenseQuery(membersQuery(slug));
  const canCreateLabels = useCanCreateLabels(slug);
  const createLabel = useCreateLabel(slug);
  // Status, Labels and Assignees are `issue.triage`, which a reporter does
  // not hold: the server refuses them outright, so offering them would only
  // produce a 403 after the issue was already written.
  const canTriage = useCan(slug, "issue.triage");
  const canBlock = useCan(slug, "issue.block");
  // Notifications needs no capability at all, but it does not bring the
  // sidebar out on its own: a reporter files the card and lands on it, where
  // the same control is one click away, and an aside holding one row is not
  // worth restacking their page for.
  //
  // Both gates are `writer`, so today this is exactly `canTriage` — spelled
  // as the rule it is (the aside appears when it holds a section) rather than
  // as the one capability that currently decides it.
  const showSidebar = canTriage || canBlock;
  const registry = useCommandRegistry(slug, "new-issue");

  const [title, setTitle] = useState("");
  const editor = useRef<MarkdownEditorHandle>(null);
  // Seeded rather than left empty: the live command parsing reads `draft`,
  // and submitting re-reads the editor anyway, so this only governs what the
  // form shows before it is sent.
  const [draft, setDraft] = useState(initialBody);
  const [statusId, setStatusId] = useState("");
  const [labelIds, setLabelIds] = useState<number[]>([]);
  const [assigneeIds, setAssigneeIds] = useState<number[]>([]);
  // null is "notifying", the state a card carries with no mute row of its
  // own: creating with it selected sends nothing.
  const [mute, setMute] = useState<IssueMuteMode | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const staging = useStagedFiles();
  const blocks = useStagedBlocks();
  // Creation and each PATCH are checkpoints, not the end of the draft:
  // downstream failures leave every field editable on this same card.
  const createdRef = useRef<Issue | null>(null);
  const savedFieldsRef = useRef<IssueCreateInput | null>(null);
  const createdDefaultRef = useRef<Status | null>(null);
  const defaultStatus =
    createdDefaultRef.current ?? pickDefaultStatus(statuses.data);
  const defaultStatusId = defaultStatus?.id;

  // The whole unfinished draft is protected, including sidebar-only work.
  // Keep this protection until replay completes; successful navigation opts
  // out below. The editor and staged files retain their own dirty sources.
  useDirtySource(
    () =>
      title.trim() !== "" ||
      labelIds.length > 0 ||
      assigneeIds.length > 0 ||
      (statusId !== "" && Number(statusId) !== defaultStatusId) ||
      blocks.staged.length > 0 ||
      mute !== null,
  );

  // Same identity for the editor's lifetime: the compartment reconfigures on
  // a new extension list, which would close whatever panel was open. The
  // registry therefore arrives through a ref (T-161's rule, reused here).
  const registryRef = useRef(registry);
  registryRef.current = registry;
  const extensions = useMemo(
    () =>
      canTriage
        ? [
            completionWith([
              refCompletionSource(slug, queryClient),
              mentionCompletionSource(slug, queryClient),
              commandCompletionSource(() => registryRef.current),
            ]),
            commandDecoration(() => registryRef.current),
          ]
        : // Every command this page offers writes one of the three triage
          // fields, so without the capability none of them is installed and
          // a `/label` line stays the prose it looks like.
          [
            completionWith([
              refCompletionSource(slug, queryClient),
              mentionCompletionSource(slug, queryClient),
            ]),
          ],
    [slug, queryClient, canTriage],
  );

  const parsed = useMemo(
    () =>
      registry === null || !canTriage
        ? null
        : parseCommandLines(draft, registry),
    [draft, registry, canTriage],
  );
  const broken = parsed?.invalid ?? [];

  async function submit() {
    const trimmedTitle = title.trim();
    if (submitting || trimmedTitle === "") return;
    // Re-parsed from the document rather than from the onChange mirror: the
    // text at submit time is what gets executed.
    const raw = editor.current?.getValue() ?? "";
    const current =
      registry === null || !canTriage ? null : parseCommandLines(raw, registry);
    if (current !== null && current.invalid.length > 0) return;
    const body = current === null ? raw : current.body;
    const fields =
      current === null
        ? { statusId, labelIds, assigneeIds }
        : applyDraftCommands(
            { statusId, labelIds, assigneeIds },
            current.commands,
          );
    const input: IssueCreateInput = {
      title: trimmedTitle,
      body,
      // Empty triage sets ask for nothing on create. PATCH separately checks
      // the current capability: even an empty set is a triage write there.
      status_id:
        canTriage && fields.statusId !== ""
          ? Number(fields.statusId)
          : undefined,
      label_ids: canTriage ? fields.labelIds : [],
      assignee_ids: canTriage ? fields.assigneeIds : [],
    };
    setSubmitting(true);
    try {
      let issue = createdRef.current;
      if (!issue) {
        issue = await api.createIssue(slug, input);
        // If creation chose the default, keep the server's actual choice:
        // a stale statuses query must not immediately PATCH it back.
        if (input.status_id === undefined) {
          createdDefaultRef.current = issue.status ?? defaultStatus ?? null;
        }
        savedFieldsRef.current = {
          ...input,
          status_id: canTriage
            ? (input.status_id ?? issue.status?.id ?? defaultStatusId)
            : undefined,
        };
        createdRef.current = issue;
      }
      // Removing a /status command restores the form's default. PATCH
      // needs its concrete id: undefined would silently leave the old status.
      if (canTriage && input.status_id === undefined) {
        input.status_id = createdDefaultRef.current?.id ?? defaultStatusId;
      }
      if (staging.staged.length > 0) {
        const markers = await staging.uploadAll(slug, issue.number);
        // Assemble the final body before diffing it. A retry must not
        // overwrite uploaded markers with the editor's unadorned body.
        input.body = withAttachmentMarkers(body.trimEnd(), markers);
      }
      const saved = savedFieldsRef.current;
      if (saved !== null) {
        const patch: IssueUpdateInput = {};
        if (input.title !== saved.title) patch.title = input.title;
        if (input.body !== saved.body) patch.body = input.body;
        if (canTriage) {
          if (input.status_id !== saved.status_id) {
            patch.status_id = input.status_id;
          }
          if (
            input.label_ids.length !== saved.label_ids.length ||
            input.label_ids.some((id) => !saved.label_ids.includes(id))
          ) {
            patch.label_ids = input.label_ids;
          }
          if (
            input.assignee_ids.length !== saved.assignee_ids.length ||
            input.assignee_ids.some((id) => !saved.assignee_ids.includes(id))
          ) {
            patch.assignee_ids = input.assignee_ids;
          }
        }
        if (Object.keys(patch).length > 0) {
          await api.updateIssue(slug, issue.number, patch);
          // Only sent fields have reached the server. In particular, losing
          // triage permission must not advance those fields' checkpoints.
          savedFieldsRef.current = { ...saved, ...patch };
        }
      }
      // Everything below needs the card's number, so none of it can run
      // before the create above. Each step is resumable on its own — the
      // edges drop out of the tray as they land, and a mute is a PUT — so a
      // failure here leaves the button able to finish the job, which is the
      // whole reason it does not navigate away first.
      await blocks.createAll(slug, issue.number);
      if (mute !== null) {
        await api.muteIssue(slug, issue.number, { mode: mute });
        invalidateAfterMute(queryClient, "issue", slug);
      }
      queryClient.invalidateQueries({ queryKey: ["issues", slug] });
      staging.clear();
      blocks.clear();
      navigate({
        to: "/projects/$slug/issues/$number",
        params: { slug, number: String(issue.number) },
        // The work this navigation leaves behind is committed: the issue
        // exists, its attachments are uploaded, and `createdRef` reuses it.
        // The guard cannot know that — its predicates read the title and the
        // body, and the state that would clear them lands after this call —
        // so the page that did the committing says so itself and the
        // navigation goes through (T-317).
        ignoreBlocker: true,
      });
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      className={cn("grid gap-6", showSidebar && "lg:grid-cols-[1fr_240px]")}
      inert={submitting}
    >
      <form
        className="min-w-0 space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <h1 className="text-2xl font-semibold">New issue</h1>
        <div className="space-y-2">
          <Label htmlFor="new-issue-title">Title</Label>
          <Input
            id="new-issue-title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Dig up the potatoes"
            required
            autoFocus
          />
        </div>
        <div className="space-y-2">
          {/* A contenteditable is not a labelable element, so the caption
              stands on its own and the editor carries its own name. */}
          <Label>Description</Label>
          {quoteMissing && (
            <p className="text-sm text-muted-foreground">
              The text this was opened to quote could not be read — it may have
              been deleted, or be in a project you cannot see.
            </p>
          )}
          <MarkdownEditor
            ref={editor}
            initialValue={initialBody}
            ariaLabel="Description"
            placeholder={
              canTriage
                ? "Markdown supported. #N references other issues, / runs a command, < inserts a collapsible block; paste or drop files."
                : "Markdown supported. Reference other issues with #N, < inserts a collapsible block; paste or drop files."
            }
            className="min-h-56"
            extensions={extensions}
            readOnly={submitting}
            onChange={setDraft}
            onSubmit={() => void submit()}
            onPaste={staging.onPaste}
            onDrop={staging.onDrop}
            onDragOver={staging.onDragOver}
          />
          <CommandErrors broken={broken} />
          <StagedFileTray
            staged={staging.staged}
            onRemove={staging.remove}
            disabled={submitting}
          />
        </div>
        <div className="flex justify-end gap-2">
          <StagedFileUploadButton
            onFiles={staging.stage}
            disabled={submitting}
            label="Attach files"
            className="mr-auto"
          />
          <Button
            type="button"
            variant="ghost"
            onClick={() => {
              // Cancel is still a guarded departure. Keep every staged item
              // intact until the reader actually chooses to discard it.
              navigate({ to: "/projects/$slug", params: { slug }, search: {} });
            }}
          >
            Cancel
          </Button>
          <Button
            type="submit"
            disabled={submitting || title.trim() === "" || broken.length > 0}
          >
            {newIssueSubmitLabel({
              submitting,
              broken: broken.length,
              summaries: parsed?.summaries ?? [],
            })}
          </Button>
        </div>
      </form>

      {showSidebar && (
        // A grid item floors at min-content, so without `min-w-0` the Labels
        // chips never shrink; and unlike issue-detail's sidebar there is no
        // `lg:overflow-y-auto` here to clip them — they paint over the form.
        <aside className="min-w-0 space-y-3 text-sm">
          {canTriage && (
            <>
              <SidebarSection name="status" title="Status">
                {/* A select rather than the card page's pill-and-dropdown:
                    this is the one field with a value before anybody picks
                    one, and the placeholder is where that default is said. */}
                <Select value={statusId} onValueChange={setStatusId}>
                  <SelectTrigger className="w-full">
                    <SelectValue
                      placeholder={defaultStatus?.name ?? "Status"}
                    />
                  </SelectTrigger>
                  <SelectContent>
                    {statuses.data.map((s) => (
                      <SelectItem key={s.id} value={String(s.id)}>
                        <span
                          className="size-2 shrink-0 rounded-full"
                          style={{ backgroundColor: s.color }}
                          aria-hidden
                        />
                        {s.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </SidebarSection>

              <SidebarSection
                name="labels"
                title="Labels"
                action={
                  <LabelPicker
                    allLabels={labels.data}
                    selected={labels.data.filter((label) =>
                      labelIds.includes(label.id),
                    )}
                    onToggle={(label) =>
                      setLabelIds((prev) =>
                        prev.includes(label.id)
                          ? prev.filter((id) => id !== label.id)
                          : [...prev, label.id],
                      )
                    }
                    onCreate={canCreateLabels ? createLabel : undefined}
                    trigger={
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        aria-label="Edit labels"
                      >
                        <PencilIcon className="size-3.5" />
                      </Button>
                    }
                  />
                }
              >
                {labelIds.length > 0 && (
                  <div className="flex flex-wrap items-center gap-1.5">
                    <LabelChips
                      labels={labels.data.filter((label) =>
                        labelIds.includes(label.id),
                      )}
                      truncate
                    />
                  </div>
                )}
              </SidebarSection>

              <SidebarSection
                name="assignees"
                title="Assignees"
                action={
                  <AssigneePicker
                    members={members.data}
                    selectedIds={assigneeIds}
                    onToggle={(userId) =>
                      setAssigneeIds((prev) =>
                        prev.includes(userId)
                          ? prev.filter((id) => id !== userId)
                          : [...prev, userId],
                      )
                    }
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
                }
              >
                {assigneeIds.length > 0 && (
                  <div className="flex flex-wrap gap-2">
                    {members.data
                      .filter((member) => assigneeIds.includes(member.user.id))
                      .map((member) => (
                        // Unlinked, unlike the card page's chips: this echoes
                        // a pick made on a card that does not exist (T-391).
                        <UserChip
                          key={member.user.id}
                          user={member.user}
                          link={false}
                        />
                      ))}
                  </div>
                )}
              </SidebarSection>
            </>
          )}

          {canBlock && (
            <StagedBlockSections
              slug={slug}
              blocks={blocks}
              disabled={submitting}
            />
          )}

          <SidebarSection name="notifications" title="Notifications">
            <MuteControl slug={slug} mode={mute} onPick={setMute} />
          </SidebarSection>
        </aside>
      )}
    </div>
  );
}
