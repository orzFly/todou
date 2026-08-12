import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useNavigate, useParams } from "@tanstack/react-router";
import type { Issue, Status } from "@todou/shared";
import { CheckIcon } from "lucide-react";
import { useRef, useState } from "react";
import { toast } from "sonner";
import {
  api,
  labelsQuery,
  membersQuery,
  statusesQuery,
} from "@/api/queries.ts";
import { LabelChip } from "@/components/issue/label-chip.tsx";
import {
  StagedFileTray,
  useStagedFiles,
} from "@/components/issue/staged-files.tsx";
import { UserChip } from "@/components/shared/user-chip.tsx";
import { withAttachmentMarkers } from "@/components/timeline/composer.tsx";
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
import { Textarea } from "@/components/ui/textarea";

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

  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [statusId, setStatusId] = useState("");
  const [labelIds, setLabelIds] = useState<number[]>([]);
  const [assigneeIds, setAssigneeIds] = useState<number[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const staging = useStagedFiles();
  // A retry after a failed attachment upload must not create the issue
  // twice — the created issue survives the failed attempt here.
  const createdRef = useRef<Issue | null>(null);

  async function submit() {
    const trimmedTitle = title.trim();
    if (submitting || trimmedTitle === "") return;
    setSubmitting(true);
    try {
      let issue = createdRef.current;
      if (!issue) {
        issue = await api.createIssue(slug, {
          title: trimmedTitle,
          body,
          status_id: statusId === "" ? undefined : Number(statusId),
          label_ids: labelIds,
          assignee_ids: assigneeIds,
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
    <div className="grid gap-6 lg:grid-cols-[1fr_240px]">
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
          <Label htmlFor="new-issue-body">Description</Label>
          <Textarea
            id="new-issue-body"
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder="Markdown supported. Reference other issues with #N; paste or drop files."
            rows={10}
            onPaste={staging.onPaste}
            onDrop={staging.onDrop}
            onDragOver={staging.onDragOver}
          />
          <StagedFileTray
            staged={staging.staged}
            onRemove={staging.remove}
            disabled={submitting}
          />
        </div>
        <div className="flex justify-end gap-2">
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
          <Button type="submit" disabled={submitting || title.trim() === ""}>
            {submitting ? "Creating…" : "Create issue"}
          </Button>
        </div>
      </form>

      <aside className="space-y-5 text-sm">
        <section className="space-y-2">
          <h3 className="text-xs font-medium text-muted-foreground uppercase">
            Status
          </h3>
          <Select value={statusId} onValueChange={setStatusId}>
            <SelectTrigger className="w-full">
              <SelectValue
                placeholder={pickDefaultStatus(statuses.data)?.name ?? "Status"}
              />
            </SelectTrigger>
            <SelectContent>
              {statuses.data.map((s) => (
                <SelectItem key={s.id} value={String(s.id)}>
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
          <div className="flex flex-wrap gap-1">
            {labels.data
              .filter((label) => labelIds.includes(label.id))
              .map((label) => (
                <LabelChip key={label.id} label={label} />
              ))}
          </div>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm">
                Edit labels
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent>
              {labels.data.length === 0 && (
                <DropdownMenuItem disabled>No labels defined</DropdownMenuItem>
              )}
              {labels.data.map((label) => (
                <DropdownMenuItem
                  key={label.id}
                  onSelect={(e) => {
                    e.preventDefault();
                    setLabelIds((prev) =>
                      prev.includes(label.id)
                        ? prev.filter((id) => id !== label.id)
                        : [...prev, label.id],
                    );
                  }}
                >
                  <span className="w-4">
                    {labelIds.includes(label.id) && (
                      <CheckIcon className="size-4" />
                    )}
                  </span>
                  {label.name}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
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
            <DropdownMenuContent>
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
                  {member.user.login}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </section>
      </aside>
    </div>
  );
}
