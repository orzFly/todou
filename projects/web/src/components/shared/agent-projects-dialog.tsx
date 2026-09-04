import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  type Agent,
  type AgentMembership,
  MemberRole,
  type ProjectBrief,
} from "@todou/shared";
import { PlusIcon, SettingsIcon, Trash2Icon } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { agentMembershipsQuery, api } from "@/api/queries.ts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

/** Visual grouping only — the role is also written out in text. */
const ROLE_DOT: Record<MemberRole, string> = {
  admin: "bg-violet-500",
  writer: "bg-sky-500",
  reader: "bg-muted-foreground",
};

const MAX_BADGES = 3;

/**
 * The `Projects` column of the agents table, and the dialog behind it. Reads
 * the shared memberships query itself rather than taking rows as props, so
 * every row on the page answers from one cache entry and the page keeps a
 * three-line diff.
 *
 * `useQuery`, not `useSuspenseQuery`: this is one supplementary column, and
 * a failing endpoint should not drop the whole page into an error boundary.
 */
export function AgentProjectsCell({ agent }: { agent: Agent }) {
  const memberships = useQuery(agentMembershipsQuery);
  const mine = (memberships.data?.memberships ?? []).filter(
    (m) => m.agent_id === agent.id,
  );

  return (
    <Dialog>
      <DialogTrigger asChild>
        <button
          type="button"
          aria-label={`Manage ${agent.login}'s projects`}
          className="flex w-full cursor-pointer flex-wrap items-center gap-1 rounded-md px-1.5 py-1 text-left hover:bg-muted"
        >
          {memberships.isPending ? (
            <Skeleton className="h-5 w-28" />
          ) : memberships.isError ? (
            <span
              className="text-sm text-muted-foreground"
              title={`Could not load projects: ${memberships.error.message}`}
            >
              —
            </span>
          ) : mine.length === 0 ? (
            <span className="text-sm text-muted-foreground">No projects</span>
          ) : (
            <ProjectBadges memberships={mine} />
          )}
        </button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Projects for {agent.login}</DialogTitle>
          <DialogDescription>
            Roles apply immediately. Only projects you administer can be
            changed.
          </DialogDescription>
        </DialogHeader>
        <AgentProjectsBody agent={agent} />
      </DialogContent>
    </Dialog>
  );
}

/**
 * Nothing here may be interactive: the whole cell is already a button, and a
 * nested button is invalid HTML. That rules out a Radix `Tooltip`, whose
 * trigger is a button — so the role rides native `title`/`aria-label`.
 */
function ProjectBadges({ memberships }: { memberships: AgentMembership[] }) {
  const shown = memberships.slice(0, MAX_BADGES);
  const rest = memberships.length - shown.length;
  return (
    <>
      {shown.map((m) => (
        <Badge
          key={m.project.id}
          variant="outline"
          title={`${m.project.name} · ${m.role}`}
          aria-label={`${m.project.name} · ${m.role}`}
        >
          <span
            className={cn("size-1.5 rounded-full", ROLE_DOT[m.role])}
            aria-hidden="true"
          />
          {m.project.slug}
        </Badge>
      ))}
      {rest > 0 && (
        <span className="text-xs text-muted-foreground">+{rest}</span>
      )}
      <SettingsIcon
        className="size-3.5 shrink-0 text-muted-foreground"
        aria-hidden="true"
      />
    </>
  );
}

function AgentProjectsBody({ agent }: { agent: Agent }) {
  const memberships = useQuery(agentMembershipsQuery);
  const queryClient = useQueryClient();
  const [toAdd, setToAdd] = useState("");

  // Both caches, always: the project settings page shows the same rows from
  // the other side. Settled rather than success — a rejected write may still
  // have landed, and the server's answer is what the UI must return to.
  const invalidate = (slug: string) => {
    queryClient.invalidateQueries({ queryKey: ["agent-memberships"] });
    queryClient.invalidateQueries({ queryKey: ["members", slug] });
  };

  const setRole = useMutation({
    mutationFn: (vars: { slug: string; role: MemberRole }) =>
      api.setMember(vars.slug, agent.id, vars.role),
    onError: (error) => toast.error(error.message),
    onSettled: (_data, _error, vars) => invalidate(vars.slug),
  });
  const remove = useMutation({
    mutationFn: (slug: string) => api.removeMember(slug, agent.id),
    onError: (error) => toast.error(error.message),
    onSettled: (_data, _error, slug) => invalidate(slug),
  });

  if (memberships.isPending) {
    return (
      <div className="space-y-2">
        <Skeleton className="h-9 w-full" />
        <Skeleton className="h-9 w-full" />
      </div>
    );
  }
  if (memberships.isError) {
    return (
      <div className="space-y-2">
        <p className="text-sm text-destructive">{memberships.error.message}</p>
        <Button
          variant="outline"
          size="sm"
          onClick={() => memberships.refetch()}
        >
          Retry
        </Button>
      </div>
    );
  }

  const mine = memberships.data.memberships.filter(
    (m) => m.agent_id === agent.id,
  );
  const manageable = memberships.data.manageable_projects;
  const manageableIds = new Set(manageable.map((p) => p.id));
  const joined = new Set(mine.map((m) => m.project.id));
  const candidates = manageable.filter((p) => !joined.has(p.id));

  return (
    <div className="space-y-3">
      {mine.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Not a member of any project yet.
        </p>
      ) : (
        <div className="space-y-2">
          {mine.map((m) => (
            <MembershipRow
              key={m.project.id}
              membership={m}
              manageable={manageableIds.has(m.project.id)}
              onRole={(role) => setRole.mutate({ slug: m.project.slug, role })}
              onRemove={() => remove.mutate(m.project.slug)}
            />
          ))}
        </div>
      )}

      {manageable.length > 0 && (
        <div className="space-y-1 border-t pt-3">
          {candidates.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No more projects to add.
            </p>
          ) : (
            <>
              <div className="flex items-center gap-2">
                <Select value={toAdd} onValueChange={setToAdd}>
                  <SelectTrigger
                    size="sm"
                    className="w-56"
                    aria-label="Project to add"
                  >
                    <SelectValue placeholder="Choose a project" />
                  </SelectTrigger>
                  <SelectContent>
                    {candidates.map((p: ProjectBrief) => (
                      <SelectItem key={p.id} value={p.slug}>
                        {p.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {/* Select-then-Add, never select-to-write: one stray click
                    would otherwise hand out a real grant. */}
                <Button
                  size="sm"
                  disabled={toAdd === "" || setRole.isPending}
                  onClick={() => {
                    setRole.mutate({ slug: toAdd, role: "writer" });
                    setToAdd("");
                  }}
                >
                  <PlusIcon className="size-3.5" /> Add
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                Added as writer — change the role above afterwards.
              </p>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function MembershipRow({
  membership,
  manageable,
  onRole,
  onRemove,
}: {
  membership: AgentMembership;
  manageable: boolean;
  onRole: (role: MemberRole) => void;
  onRemove: () => void;
}) {
  const { project, role } = membership;
  return (
    <div className="flex items-center gap-2">
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm">{project.name}</div>
        <div className="truncate text-xs text-muted-foreground">
          {project.slug}
        </div>
      </div>
      {manageable ? (
        <>
          <Select
            value={role}
            onValueChange={(next) => onRole(next as MemberRole)}
          >
            <SelectTrigger
              size="sm"
              className="w-28"
              aria-label={`role in ${project.name}`}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {MemberRole.options.map((option) => (
                <SelectItem key={option} value={option}>
                  {option}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={`remove ${project.name}`}
            onClick={onRemove}
          >
            <Trash2Icon className="size-4" />
          </Button>
        </>
      ) : (
        <span
          className="flex items-center gap-2 text-sm text-muted-foreground"
          title={`You are not an admin of ${project.name}, so this membership is read-only.`}
        >
          {role}
          <Badge variant="outline">read-only</Badge>
        </span>
      )}
    </div>
  );
}
