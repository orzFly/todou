import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useNavigate, useParams } from "@tanstack/react-router";
import type { Issue, Status } from "@todou/shared";
import { CheckIcon } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import {
  api,
  labelsQuery,
  membersQuery,
  statusesQuery,
  useCan,
} from "@/api/queries.ts";
import { LabelChips } from "@/components/issue/label-chip.tsx";
import {
  LabelPicker,
  useCanCreateLabels,
  useCreateLabel,
} from "@/components/issue/label-picker.tsx";
import {
  StagedFileTray,
  StagedFileUploadButton,
  useStagedFiles,
} from "@/components/issue/staged-files.tsx";
import { CommandErrors } from "@/components/shared/command-errors.tsx";
import {
  MarkdownEditor,
  type MarkdownEditorHandle,
} from "@/components/shared/markdown-editor.tsx";
import { displayNameOf, UserChip } from "@/components/shared/user-chip.tsx";
import {
  useCommandRegistry,
  withAttachmentMarkers,
} from "@/components/timeline/composer.tsx";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  completionWith,
  refCompletionSource,
} from "@/lib/editor/ref-completion.ts";
import {
  commandCompletionSource,
  commandDecoration,
} from "@/lib/editor/slash-commands.ts";
import {
  applyDraftCommands,
  newIssueSubmitLabel,
  parseCommandLines,
} from "@/lib/slash-commands.ts";
import { cn } from "@/lib/utils";

// Mirrors the server's choice when no status is sent with a new issue.
export function pickDefaultStatus(statuses: Status[]): Status | undefined {
  return statuses.find((s) => s.is_default) ?? statuses[0];
}

export function NewIssuePage() {
  const { slug } = useParams({ from: "/authed/projects/$slug/issues/new" });
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const statuses = useSuspenseQuery(statusesQuery(slug));
  const labels = useSuspenseQuery(labelsQuery(slug));
  const members = useSuspenseQuery(membersQuery(slug));
  const canCreateLabels = useCanCreateLabels(slug);
  const createLabel = useCreateLabel(slug);
  // The three sidebar fields are `issue.triage`, which a reporter does not
  // hold: the server refuses them outright, so offering them would only
  // produce a 403 after the issue was already written.
  const canTriage = useCan(slug, "issue.triage");
  const registry = useCommandRegistry(slug, "new-issue");

  const [title, setTitle] = useState("");
  const editor = useRef<MarkdownEditorHandle>(null);
  const [draft, setDraft] = useState("");
  const [statusId, setStatusId] = useState("");
  const [labelIds, setLabelIds] = useState<number[]>([]);
  const [assigneeIds, setAssigneeIds] = useState<number[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const staging = useStagedFiles();
  // A retry after a failed attachment upload must not create the issue
  // twice — the created issue survives the failed attempt here.
  const createdRef = useRef<Issue | null>(null);

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
              commandCompletionSource(() => registryRef.current),
            ]),
            commandDecoration(() => registryRef.current),
          ]
        : // Every command this page offers writes one of the three triage
          // fields, so without the capability none of them is installed and
          // a `/label` line stays the prose it looks like.
          [completionWith([refCompletionSource(slug, queryClient)])],
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
    setSubmitting(true);
    try {
      let issue = createdRef.current;
      if (!issue) {
        issue = await api.createIssue(slug, {
          title: trimmedTitle,
          body,
          // Guarded rather than merely unset: the controls behind these are
          // unmounted without `issue.triage`, and an empty set is what the
          // server reads as "asked for nothing" — sending one is not a
          // request it has to refuse.
          status_id:
            canTriage && fields.statusId !== ""
              ? Number(fields.statusId)
              : undefined,
          label_ids: canTriage ? fields.labelIds : [],
          assignee_ids: canTriage ? fields.assigneeIds : [],
        });
        createdRef.current = issue;
      }
      if (staging.staged.length > 0) {
        const markers = await staging.uploadAll(slug, issue.number);
        const full = withAttachmentMarkers(body.trimEnd(), markers);
        if (full !== issue.body) {
          await api.updateIssue(slug, issue.number, { body: full });
        }
      }
      queryClient.invalidateQueries({ queryKey: ["issues", slug] });
      staging.clear();
      navigate({
        to: "/projects/$slug/issues/$number",
        params: { slug, number: String(issue.number) },
      });
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className={cn("grid gap-6", canTriage && "lg:grid-cols-[1fr_240px]")}>
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
          <MarkdownEditor
            ref={editor}
            ariaLabel="Description"
            placeholder={
              canTriage
                ? "Markdown supported. #N references other issues, / runs a command; paste or drop files."
                : "Markdown supported. Reference other issues with #N; paste or drop files."
            }
            className="min-h-56"
            extensions={extensions}
            onChange={setDraft}
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
              staging.clear();
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

      {canTriage && (
        // A grid item floors at min-content, so without `min-w-0` the Labels
        // chips never shrink; and unlike issue-detail's sidebar there is no
        // `lg:overflow-y-auto` here to clip them — they paint over the form.
        <aside className="min-w-0 space-y-5 text-sm">
          <section className="space-y-2">
            <h3 className="text-xs font-medium text-muted-foreground uppercase">
              Status
            </h3>
            <Select value={statusId} onValueChange={setStatusId}>
              <SelectTrigger className="w-full">
                <SelectValue
                  placeholder={
                    pickDefaultStatus(statuses.data)?.name ?? "Status"
                  }
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
          </section>

          <section className="space-y-2">
            <h3 className="text-xs font-medium text-muted-foreground uppercase">
              Labels
            </h3>
            <div className="flex flex-wrap items-center gap-1.5">
              <LabelChips
                labels={labels.data.filter((label) =>
                  labelIds.includes(label.id),
                )}
                truncate
              />
            </div>
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
                <Button variant="outline" size="sm">
                  Edit labels
                </Button>
              }
            />
          </section>

          <section className="space-y-2">
            <h3 className="text-xs font-medium text-muted-foreground uppercase">
              Assignees
            </h3>
            <div className="flex flex-wrap gap-2">
              {members.data
                .filter((member) => assigneeIds.includes(member.user.id))
                .map((member) => (
                  <UserChip key={member.user.id} user={member.user} />
                ))}
            </div>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm">
                  Edit assignees
                </Button>
              </DropdownMenuTrigger>
              {/* Name plus login needs more room than the trigger's width,
                which is what the menu defaults to. */}
              <DropdownMenuContent className="w-auto">
                {members.data.map((member) => (
                  <DropdownMenuItem
                    key={member.user.id}
                    onSelect={(e) => {
                      e.preventDefault();
                      setAssigneeIds((prev) =>
                        prev.includes(member.user.id)
                          ? prev.filter((id) => id !== member.user.id)
                          : [...prev, member.user.id],
                      );
                    }}
                  >
                    <span className="w-4">
                      {assigneeIds.includes(member.user.id) && (
                        <CheckIcon className="size-4" />
                      )}
                    </span>
                    <span className="whitespace-nowrap">
                      {displayNameOf(member.user)}
                    </span>
                    <span className="whitespace-nowrap text-muted-foreground">
                      @{member.user.login}
                    </span>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </section>
        </aside>
      )}
    </div>
  );
}
