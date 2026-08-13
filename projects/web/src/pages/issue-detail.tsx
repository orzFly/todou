import {
  useMutation,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query";
import { useParams } from "@tanstack/react-router";
import { formatRef, type Issue, type Status } from "@todou/shared";
import { CheckIcon, PencilIcon, XIcon } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { issueQuery, useIssueStatusMutation } from "@/api/issues.ts";
import {
  api,
  labelsQuery,
  membersQuery,
  meQuery,
  statusesQuery,
} from "@/api/queries.ts";
import { useRefPrefix } from "@/api/references.ts";
import { AttachmentList } from "@/components/issue/attachment-list.tsx";
import { LabelChips } from "@/components/issue/label-chip.tsx";
import { MarkReadOnView } from "@/components/issue/mark-read-on-view.tsx";
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
import { MarkdownView } from "@/components/shared/markdown-view.tsx";
import { RevisionHistory } from "@/components/shared/revision-history.tsx";
import { UserChip } from "@/components/shared/user-chip.tsx";
import {
  Composer,
  useCommentComposer,
  withAttachmentMarkers,
} from "@/components/timeline/composer.tsx";
import { Timeline } from "@/components/timeline/timeline.tsx";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";

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
  const viewer = {
    id: me.data.id,
    isAdmin: members.data.some(
      (m) => m.user.id === me.data.id && m.role === "admin",
    ),
  };

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_240px]">
      <MarkReadOnView slug={slug} number={issueNumber} />
      <div className="min-w-0 space-y-4">
        <TitleBlock slug={slug} issue={issue.data} />
        <BodyBlock slug={slug} issue={issue.data} />
        <SpecEntryRow slug={slug} issueNumber={issueNumber} />
        <AttachmentList slug={slug} issueNumber={issueNumber} />
        <Separator />
        <Timeline
          slug={slug}
          issueNumber={issueNumber}
          pendingComments={composer.pending.filter((p) => !p.failed)}
          viewer={viewer}
        />
        {/* Floats at the viewport bottom while the timeline scrolls by,
            and settles into flow at the end of the page (GitHub-style). */}
        <div className="sticky bottom-0 z-10 border-t bg-background pt-3 pb-4">
          <Composer
            slug={slug}
            issueNumber={issueNumber}
            onSend={composer.send}
            failed={composer.pending.filter((p) => p.failed)}
            onRetry={composer.retry}
          />
        </div>
      </div>
      <Sidebar
        slug={slug}
        issue={issue.data}
        statuses={statuses.data}
        allLabels={labels.data}
        members={members.data}
      />
    </div>
  );
}

function TitleBlock({ slug, issue }: { slug: string; issue: Issue }) {
  const refPrefix = useRefPrefix(slug);
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(issue.title);
  const queryClient = useQueryClient();
  const rename = useMutation({
    mutationFn: () => api.updateIssue(slug, issue.number, { title }),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ["issue", slug, issue.number],
      });
      queryClient.invalidateQueries({ queryKey: ["issues", slug] });
      queryClient.invalidateQueries({
        queryKey: ["timeline", slug, issue.number],
      });
      setEditing(false);
    },
    onError: (error) => toast.error(error.message),
  });

  if (editing) {
    return (
      <form
        className="flex items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          rename.mutate();
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
      <h1 className="text-2xl font-semibold">
        {issue.title}{" "}
        <span className="font-normal text-muted-foreground">
          {formatRef(refPrefix, issue.number)}
        </span>
      </h1>
      <Button
        size="icon-sm"
        variant="ghost"
        aria-label="edit title"
        onClick={() => setEditing(true)}
      >
        <PencilIcon className="size-4" />
      </Button>
    </div>
  );
}

function BodyBlock({ slug, issue }: { slug: string; issue: Issue }) {
  const [editing, setEditing] = useState(false);
  const [body, setBody] = useState(issue.body);
  const [uploading, setUploading] = useState(false);
  const staging = useStagedFiles();
  const queryClient = useQueryClient();
  const save = useMutation({
    mutationFn: (finalBody: string) =>
      api.updateIssue(slug, issue.number, { body: finalBody }),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ["issue", slug, issue.number],
      });
      setEditing(false);
      staging.clear();
    },
    onError: (error) => toast.error(error.message),
  });

  async function handleSave() {
    if (uploading) return;
    let full = body;
    if (staging.staged.length > 0) {
      setUploading(true);
      try {
        const markers = await staging.uploadAll(slug, issue.number);
        full = withAttachmentMarkers(body.trimEnd(), markers);
      } catch (error) {
        toast.error(`Could not upload files: ${(error as Error).message}`);
        return;
      } finally {
        setUploading(false);
      }
    }
    save.mutate(full);
  }

  return (
    <div className="rounded-lg border">
      <div className="flex items-center gap-2 border-b bg-muted/40 px-3 py-1.5 text-sm">
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
        <Button
          size="icon-sm"
          variant="ghost"
          className="ml-auto"
          aria-label="edit body"
          onClick={() => {
            setBody(issue.body);
            staging.clear();
            setEditing(!editing);
          }}
        >
          <PencilIcon className="size-3.5" />
        </Button>
      </div>
      <div className="px-3 py-2">
        {editing ? (
          <div className="space-y-2">
            <Textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={8}
              placeholder="Describe the issue… (paste or drop files)"
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
          <MarkdownView
            slug={slug}
            issueNumber={issue.number}
            refDate={issue.created_at}
          >
            {issue.body}
          </MarkdownView>
        )}
      </div>
    </div>
  );
}

function Sidebar({
  slug,
  issue,
  statuses,
  allLabels,
  members,
}: {
  slug: string;
  issue: Issue;
  statuses: Status[];
  allLabels: Array<{ id: number; name: string; color: string }>;
  members: Array<{ user: { id: number; login: string } }>;
}) {
  const queryClient = useQueryClient();
  const statusMutation = useIssueStatusMutation(slug);
  const patch = useMutation({
    mutationFn: (input: { label_ids?: number[]; assignee_ids?: number[] }) =>
      api.updateIssue(slug, issue.number, input),
    onSettled: () => {
      queryClient.invalidateQueries({
        queryKey: ["issue", slug, issue.number],
      });
      queryClient.invalidateQueries({ queryKey: ["issues", slug] });
      queryClient.invalidateQueries({
        queryKey: ["timeline", slug, issue.number],
      });
    },
    onError: (error) => toast.error(error.message),
  });

  return (
    // Sticky on large screens (T-63): the sidebar keeps Status and the
    // Latest spec section in view while the timeline scrolls; when taller
    // than the viewport it scrolls internally.
    <aside className="space-y-5 text-sm lg:sticky lg:top-20 lg:max-h-[calc(100vh-6rem)] lg:self-start lg:overflow-y-auto">
      <section className="space-y-2">
        <h3 className="text-xs font-medium text-muted-foreground uppercase">
          Status
        </h3>
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
                    issueNumber: issue.number,
                    status: s,
                  })
                }
              >
                <span className="w-4">
                  {s.id === issue.status.id && <CheckIcon className="size-4" />}
                </span>
                {s.name}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </section>

      <section className="space-y-2">
        <h3 className="text-xs font-medium text-muted-foreground uppercase">
          Labels
        </h3>
        <div className="flex flex-wrap items-center gap-1.5">
          <LabelChips labels={issue.labels} />
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm">
              Edit labels
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            {allLabels.length === 0 && (
              <DropdownMenuItem disabled>No labels defined</DropdownMenuItem>
            )}
            {allLabels.map((label) => {
              const active = issue.labels.some((l) => l.id === label.id);
              return (
                <DropdownMenuItem
                  key={label.id}
                  onSelect={(e) => {
                    e.preventDefault();
                    const current = issue.labels.map((l) => l.id);
                    patch.mutate({
                      label_ids: active
                        ? current.filter((id) => id !== label.id)
                        : [...current, label.id],
                    });
                  }}
                >
                  <span className="w-4">
                    {active && <CheckIcon className="size-4" />}
                  </span>
                  {label.name}
                </DropdownMenuItem>
              );
            })}
          </DropdownMenuContent>
        </DropdownMenu>
      </section>

      <section className="space-y-2">
        <h3 className="text-xs font-medium text-muted-foreground uppercase">
          Assignees
        </h3>
        <div className="flex flex-wrap gap-2">
          {issue.assignees.map((user) => (
            <UserChip key={user.id} user={user} />
          ))}
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm">
              Edit assignees
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            {members.map((member) => {
              const active = issue.assignees.some(
                (a) => a.id === member.user.id,
              );
              return (
                <DropdownMenuItem
                  key={member.user.id}
                  onSelect={(e) => {
                    e.preventDefault();
                    const current = issue.assignees.map((a) => a.id);
                    patch.mutate({
                      assignee_ids: active
                        ? current.filter((id) => id !== member.user.id)
                        : [...current, member.user.id],
                    });
                  }}
                >
                  <span className="w-4">
                    {active && <CheckIcon className="size-4" />}
                  </span>
                  {member.user.login}
                </DropdownMenuItem>
              );
            })}
          </DropdownMenuContent>
        </DropdownMenu>
      </section>

      {/* Placement per the T-63 verdict: after Assignees, verdict-free. */}
      <SpecSidebarSection slug={slug} issueNumber={issue.number} />
    </aside>
  );
}
