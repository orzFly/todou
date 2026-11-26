import { Badge } from "@orz/ui/components/badge";
import { Button } from "@orz/ui/components/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@orz/ui/components/select";
import { Skeleton } from "@orz/ui/components/skeleton";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  type Agent,
  type AgentMembership,
  type ManageableProject,
  MemberRole,
  ROLE_RANK,
  roleRankOf,
} from "@todou/shared";
import { PlusIcon, Trash2Icon } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { agentMembershipsQuery, api } from "@/api/queries.ts";
import {
  LoadFailure,
  RefreshFailure,
} from "@/components/shared/load-failure.tsx";
import { ProjectIcon } from "@/components/shared/project-icon.tsx";
import { cappedRole } from "@/lib/roles.ts";
import { useProjectRefs } from "@/lib/use-project-refs.ts";
import { useReadFailure } from "@/lib/use-read-failure.ts";

/** As many icons as the list cell draws before the count speaks for the rest. */
const MAX_ICONS = 4;

/**
 * The `Projects` cell of the agents list. Reads the shared memberships query
 * itself rather than taking rows as props, so every row on the page answers
 * from one cache entry.
 *
 * `useQuery`, not `useSuspenseQuery`: this is one supplementary column, and
 * a failing endpoint should not drop the whole page into an error boundary.
 *
 * Nothing here may be interactive: the cell sits inside the row's link, so
 * each icon's project and role ride its native `title`.
 */
export function AgentProjectsSummary({ agent }: { agent: Agent }) {
  const memberships = useQuery(agentMembershipsQuery);
  const { replace } = useReadFailure(
    [memberships.isError ? memberships.error : null],
    memberships.data !== undefined,
    agentMembershipsQuery.queryKey,
  );
  const mine = useMemo(
    () =>
      (memberships.data?.memberships ?? []).filter(
        (m) => m.agent_id === agent.id,
      ),
    [memberships.data, agent.id],
  );
  // `useProjectRefs` memoizes on the array's identity.
  const projects = useMemo(() => mine.map((m) => m.project), [mine]);
  const refs = useProjectRefs(projects);

  if (replace !== null) {
    return (
      <span
        className="text-sm text-muted-foreground"
        title={`Could not load projects: ${replace}`}
      >
        —
      </span>
    );
  }
  if (memberships.data === undefined) return <Skeleton className="h-5 w-28" />;
  if (mine.length === 0) {
    return (
      <span className="truncate text-sm text-muted-foreground">
        Not in any project
      </span>
    );
  }
  return (
    <span className="flex min-w-0 items-center gap-2.5">
      <span className="flex shrink-0 items-center gap-1">
        {mine.slice(0, MAX_ICONS).map((m, i) => (
          <ProjectIcon
            key={m.project.id}
            aria-hidden="true"
            title={`${m.project.name} · ${m.role}`}
            project={{
              slug: m.project.slug,
              name: m.project.name,
              prefix: refs.get(m.project.slug)?.prefix ?? null,
              icon_url: m.project.icon_url,
            }}
            // A phone-width column holds one icon and the count; the rest
            // would push the count under the chevron.
            className={i > 0 ? "@max-lg:hidden" : undefined}
          />
        ))}
      </span>
      {mine.length === 1 ? (
        <span className="truncate text-sm">{mine[0].project.name}</span>
      ) : (
        <span className="shrink-0 text-sm">{mine.length} projects</span>
      )}
    </span>
  );
}

export function AgentProjectsNotice() {
  const memberships = useQuery(agentMembershipsQuery);
  const { notice } = useReadFailure(
    [memberships.isError ? memberships.error : null],
    memberships.data !== undefined,
    agentMembershipsQuery.queryKey,
  );

  if (notice === null) return null;

  return (
    <RefreshFailure
      what="agent projects"
      detail={notice}
      onRetry={() => memberships.refetch()}
      retrying={memberships.isFetching}
    />
  );
}

/** The agent page's Projects section: every membership, editable in place. */
export function AgentProjectsSection({ agent }: { agent: Agent }) {
  return (
    <section aria-label={`Projects for ${agent.login}`} className="space-y-3">
      <h2 className="text-base font-semibold">Projects</h2>
      <AgentProjectsBody key={agent.id} agent={agent} />
    </section>
  );
}

function AgentProjectsBody({ agent }: { agent: Agent }) {
  const memberships = useQuery(agentMembershipsQuery);
  const queryClient = useQueryClient();
  const { replace, notice } = useReadFailure(
    [memberships.isError ? memberships.error : null],
    memberships.data !== undefined,
    agentMembershipsQuery.queryKey,
  );
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

  // Above the early returns, as a hook must be. Briefs carry slug and name,
  // which is all a prefix lookup needs.
  const known = useMemo(
    () => (memberships.data?.memberships ?? []).map((m) => m.project),
    [memberships.data],
  );
  const refs = useProjectRefs(known);

  if (replace !== null) {
    return (
      <LoadFailure
        message={replace}
        detail={replace}
        onRetry={() => memberships.refetch()}
        retrying={memberships.isFetching}
      />
    );
  }
  if (memberships.data === undefined) {
    return (
      <div className="space-y-2">
        <Skeleton className="h-9 w-full" />
        <Skeleton className="h-9 w-full" />
      </div>
    );
  }

  const mine = memberships.data.memberships.filter(
    (m) => m.agent_id === agent.id,
  );
  const manageable = memberships.data.manageable_projects;
  const ceilingOf = new Map(manageable.map((p) => [p.id, p.my_role]));
  const joined = new Set(mine.map((m) => m.project.id));
  const candidates = manageable.filter((p) => !joined.has(p.id));
  const toAddCeiling = manageable.find((p) => p.slug === toAdd)?.my_role;
  // `min(writer, my role there)`: a reporter adding their own agent as a
  // writer would only find out at the 409. A missing `my_role` — a server
  // from before the field — means no known ceiling, so nothing is offered;
  // the client parses no schema at runtime, so this branch is the only thing
  // between an undefined and a ceiling computed from it.
  const addRole = cappedRole("writer", toAddCeiling);

  return (
    <div className="space-y-3">
      {notice !== null && (
        <RefreshFailure
          what={`projects for ${agent.login}`}
          detail={notice}
          onRetry={() => memberships.refetch()}
          retrying={memberships.isFetching}
        />
      )}
      {mine.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Not a member of any project yet.
        </p>
      ) : (
        <div className="divide-y rounded-lg border">
          {mine.map((m) => (
            <MembershipRow
              key={m.project.id}
              membership={m}
              prefix={refs.get(m.project.slug)?.prefix ?? null}
              manageable={ceilingOf.has(m.project.id)}
              ceiling={ceilingOf.get(m.project.id)}
              onRole={(role) => setRole.mutate({ slug: m.project.slug, role })}
              onRemove={() => remove.mutate(m.project.slug)}
            />
          ))}
        </div>
      )}

      {manageable.length > 0 && (
        <div className="space-y-1">
          {candidates.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No more projects to add.
            </p>
          ) : (
            <>
              <div className="flex min-w-0 items-center gap-2">
                <Select value={toAdd} onValueChange={setToAdd}>
                  <SelectTrigger
                    size="sm"
                    className="min-w-0 w-56"
                    aria-label="Project to add"
                  >
                    <SelectValue placeholder="Choose a project" />
                  </SelectTrigger>
                  <SelectContent>
                    {candidates.map((p: ManageableProject) => (
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
                  className="shrink-0"
                  disabled={
                    toAdd === "" || addRole === null || setRole.isPending
                  }
                  onClick={() => {
                    if (addRole === null) return;
                    setRole.mutate({ slug: toAdd, role: addRole });
                    setToAdd("");
                  }}
                >
                  <PlusIcon className="size-3.5" /> Add
                </Button>
              </div>
              {addRole !== null && (
                <p className="text-xs text-muted-foreground">
                  Added as {addRole} — change the role above afterwards.
                </p>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

function MembershipRow({
  membership,
  prefix,
  manageable,
  ceiling,
  onRole,
  onRemove,
}: {
  membership: AgentMembership;
  /** The project's REF, which the icon falls back to before initials. */
  prefix: string | null;
  manageable: boolean;
  /** My role in this project: what the agent's role here may not exceed. */
  ceiling: MemberRole | undefined;
  onRole: (role: MemberRole) => void;
  onRemove: () => void;
}) {
  const { project, role } = membership;
  const rank = roleRankOf(role);
  const ceilingRank = ceiling === undefined ? undefined : roleRankOf(ceiling);
  const locked = rank === undefined || ceilingRank === undefined;
  // The clamp has to land here as well as on Add. Widening `manageable` past
  // admins means a reader owner now sees their own agent's row — and left
  // unclamped it would still offer admin, so the ordinary path would walk
  // into the 409 the ceiling exists to keep off the screen.
  const overCeiling = (option: MemberRole) =>
    locked ||
    (ceilingRank !== undefined &&
      ROLE_RANK[option] > ceilingRank &&
      option !== role);
  return (
    <div className="flex min-h-12 items-center gap-2.5 py-2 pr-2 pl-3">
      <ProjectIcon
        aria-hidden="true"
        project={{
          slug: project.slug,
          name: project.name,
          prefix,
          icon_url: project.icon_url,
        }}
        className="size-7 shrink-0"
      />
      <div className="min-w-0 flex-1 truncate text-sm font-medium">
        {project.name}
      </div>
      {manageable ? (
        <>
          <Select
            value={role}
            disabled={locked}
            onValueChange={(next) => onRole(next as MemberRole)}
          >
            <SelectTrigger
              size="sm"
              className="w-28"
              aria-label={`role in ${project.name}`}
              title={
                ceiling === undefined
                  ? undefined
                  : `At most ${ceiling} — an agent cannot outrank its owner.`
              }
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {MemberRole.options.map((option) => (
                <SelectItem
                  key={option}
                  value={option}
                  disabled={overCeiling(option)}
                >
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
