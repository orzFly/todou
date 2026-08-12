import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import type { Status } from "@todou/shared";
import { PlusIcon } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { api } from "@/api/queries.ts";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
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

export function NewIssueDialog({
  slug,
  statuses,
}: {
  slug: string;
  statuses: Status[];
}) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [statusId, setStatusId] = useState<string>("");
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const create = useMutation({
    mutationFn: () =>
      api.createIssue(slug, {
        title,
        body,
        status_id: statusId === "" ? undefined : Number(statusId),
        assignee_ids: [],
        label_ids: [],
      }),
    onSuccess: (issue) => {
      queryClient.invalidateQueries({ queryKey: ["issues", slug] });
      setOpen(false);
      setTitle("");
      setBody("");
      navigate({
        to: "/projects/$slug/issues/$number",
        params: { slug, number: String(issue.number) },
      });
    },
    onError: (error) => toast.error(error.message),
  });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm">
          <PlusIcon /> New issue
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>New issue</DialogTitle>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            create.mutate();
          }}
        >
          <div className="space-y-2">
            <Label htmlFor="issue-title">Title</Label>
            <Input
              id="issue-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Dig up the potatoes"
              required
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="issue-body">Description</Label>
            <Textarea
              id="issue-body"
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder="Markdown supported. Reference other issues with #N."
              rows={6}
            />
          </div>
          <div className="space-y-2">
            <Label>Status</Label>
            <Select value={statusId} onValueChange={setStatusId}>
              <SelectTrigger className="w-48">
                <SelectValue
                  placeholder={pickDefaultStatus(statuses)?.name ?? "Status"}
                />
              </SelectTrigger>
              <SelectContent>
                {statuses.map((s) => (
                  <SelectItem key={s.id} value={String(s.id)}>
                    {s.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <DialogFooter>
            <Button type="submit" disabled={create.isPending}>
              Create issue
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
