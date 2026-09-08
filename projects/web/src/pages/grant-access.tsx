import { useMutation, useQueries, useQuery } from "@tanstack/react-query";
import { Link, useSearch } from "@tanstack/react-router";
import type {
  Agent,
  Me,
  Member,
  MemberRole,
  ReferenceDirectory,
} from "@todou/shared";
import { MEMBER_ROLES } from "@todou/shared";
import { useState } from "react";
import { toast } from "sonner";
import {
  agentsQuery,
  api,
  membersQuery,
  meQuery,
  projectsQuery,
} from "@/api/queries.ts";
import { referenceDirectoryQuery } from "@/api/references.ts";
import {
  AuthTargetFieldset,
  readLastAgentId,
  type Selection,
  useTargetSelection,
} from "@/components/shared/auth-target-picker.tsx";
import { RolePermissionsDialog } from "@/components/shared/role-permissions-table.tsx";
import { UserChip } from "@/components/shared/user-chip.tsx";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { type GrantTarget, resolveGrantTarget } from "@/lib/grant-target.ts";

/**
 * Where the link a failed CLI command printed lands (T-280): an agent could
 * not read some project, and somebody who can decides — a role here, or no.
 *
 * The page implements no visibility policy of its own. What the opener may
 * see comes from the projects they can already list, so a target outside
 * that reach is indistinguishable from a target naming nothing, and the
 * agent that printed the link learns nothing by opening it itself.
 */

/** Nothing in the URL is trusted except `uid`, and that only as a subject. */
export type GrantSearch = {
  /** Deduped; a link may name several projects. */
  targets: string[];
  /** A display hint only — never what a write is addressed to. */
  login?: string;
  /** Who a Decline is recorded against; the opener may not own that agent. */
  uid?: number;
};

/**
 * The router's search decoder coerces `?target=41` to a number and
 * `?target=true` to a boolean, and gives a scalar rather than an array for a
 * key that appears once — so every value is put back to the string it was on
 * the wire before anything reads it as a project ref.
 */
export function parseGrantSearch(search: Record<string, unknown>): GrantSearch {
  const raw = search.target;
  const targets = (Array.isArray(raw) ? raw : [raw])
    .filter((value) => value !== undefined && value !== null && value !== "")
    .map((value) => String(value));
  const login = search.login === undefined ? "" : String(search.login);
  const uid = Number(search.uid);
  return {
    targets: [...new Set(targets)],
    ...(login === "" ? {} : { login }),
    ...(Number.isInteger(uid) && uid > 0 ? { uid } : {}),
  };
}

/**
 * The requester's own words, carried in the fragment so they never reach the
 * server or its access log. Capped, and rendered as plain text: an agent
 * writes this, and markdown here would let it forge the page's own voice.
 */
const REASON_MAX = 500;

export function readReason(hash: string): string | null {
  const params = new URLSearchParams(hash.replace(/^#/, ""));
  const reason = params.get("reason")?.trim();
  return reason === undefined || reason === ""
    ? null
    : reason.slice(0, REASON_MAX);
}

/** The role a fresh grant offers, matching every other agent-adding UI. */
const DEFAULT_ROLE: MemberRole = "writer";

const ROLES: readonly MemberRole[] = MEMBER_ROLES;

export type ProjectBriefRow = { id: number; slug: string; name: string };

/** One line of the page: a target, and everything decided about it so far. */
type Row = {
  raw: string;
  target: GrantTarget;
  /** Null while several candidates are still on offer. */
  slug: string | null;
  members: Member[] | undefined;
  isAdmin: boolean;
  role: MemberRole;
  included: boolean;
};

function PageShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto max-w-2xl px-4 py-16">
      <Card>
        <CardContent className="flex flex-col gap-5 pt-6">
          {children}
        </CardContent>
      </Card>
    </div>
  );
}

/**
 * Which agent a grant would land on. Given no `me` on purpose (T-301): this
 * is the only place the page turns a selection into a user id, and with the
 * opener's id out of reach, a grant landing on them is not a case anyone has
 * to remember to exclude.
 */
function subjectOf(selection: Selection, agents: Agent[]): number | null {
  if (selection === null || selection.kind !== "agent") return null;
  return agents.some((a) => a.id === selection.id) ? selection.id : null;
}

/**
 * The agent the link names, if the opener owns it. A preselection only:
 * `login` is whatever the CLI wrote, and picking the wrong row here is the
 * same mistake as picking it by hand. A link naming the opener themselves
 * therefore preselects nothing, exactly as one naming a stranger does.
 */
function preselect(
  login: string | undefined,
  agents: Agent[],
): Selection | undefined {
  if (login === undefined) return undefined;
  const agent = agents.find((a) => a.login === login && a.disabled_at === null);
  return agent === undefined ? undefined : { kind: "agent", id: agent.id };
}

export function GrantAccessCard({
  search,
  reason,
  me,
  agents,
  projects,
  directory,
}: {
  search: GrantSearch;
  reason: string | null;
  me: Me;
  agents: Agent[];
  projects: readonly ProjectBriefRow[];
  directory: ReferenceDirectory | null;
}) {
  const found = search.targets.map((raw) => ({
    raw,
    target: resolveGrantTarget(raw, { projects, directory }),
  }));
  // A target several readable projects answer to waits on the opener; until
  // then it contributes no row to act on.
  const [chosen, setChosen] = useState<Record<string, string>>({});
  const [roles, setRoles] = useState<Record<string, MemberRole>>({});
  const [dropped, setDropped] = useState<Record<string, true>>({});

  const slugs = found
    .map((entry) =>
      entry.target.kind === "one"
        ? entry.target.slug
        : (chosen[entry.raw] ?? null),
    )
    .filter((slug): slug is string => slug !== null);
  const memberLists = useQueries({
    queries: slugs.map((slug) => membersQuery(slug)),
  });
  const membersOf = (slug: string): Member[] | undefined =>
    memberLists[slugs.indexOf(slug)]?.data;

  // The same predicate `useTargetSelection` applies to build `candidates`,
  // computed a second time because `initial` has to be ready before the hook
  // runs and so cannot read the hook's own answer.
  const enabled = agents.filter((a) => a.disabled_at === null);
  const picker = useTargetSelection(
    agents,
    readLastAgentId(),
    preselect(search.login, agents) ??
      // No create form here and no yourself row, so `defaultSelection`'s
      // no-agents fallback would leave a selection no row on this page can
      // render. Nothing is selected instead, and `NoTarget` says why.
      (enabled.length === 0 ? null : undefined),
  );
  const subject = subjectOf(picker.selection, agents);

  const rows: Row[] = found.map((entry) => {
    const slug =
      entry.target.kind === "one"
        ? entry.target.slug
        : (chosen[entry.raw] ?? null);
    if (slug === null) {
      return {
        ...entry,
        slug,
        members: undefined,
        isAdmin: false,
        role: DEFAULT_ROLE,
        included: false,
      };
    }
    const members = membersOf(slug);
    // An instance admin is an admin everywhere and holds no membership row,
    // so the member list alone would read them as a stranger.
    const isAdmin =
      me.is_instance_admin ||
      (members ?? []).some((m) => m.user.id === me.id && m.role === "admin");
    const current = members?.find((m) => m.user.id === subject);
    return {
      ...entry,
      slug,
      members,
      isAdmin,
      role: roles[slug] ?? current?.role ?? DEFAULT_ROLE,
      included: dropped[slug] === undefined,
    };
  });

  const grantable = rows.flatMap((row) =>
    row.slug !== null && row.isAdmin && row.included
      ? [{ slug: row.slug, role: row.role }]
      : [],
  );

  const grant = useMutation({
    mutationFn: async (userId: number) => {
      // Sequential: each is a separate decision, and a failure part-way
      // through must leave the ones already written in place rather than
      // report a single verdict for the batch.
      for (const row of grantable) {
        await api.setMember(row.slug, userId, row.role);
      }
      return grantable.map((row) => row.slug);
    },
    onSuccess: (done) =>
      toast.success(
        done.length === 1
          ? `Added to ${done[0]}`
          : `Added to ${done.length} projects`,
      ),
    onError: (error) => toast.error(error.message),
  });

  const decline = useMutation({
    mutationFn: (vars: { slug: string; userId: number }) =>
      api.denyAccess(vars.slug, vars.userId),
    onSuccess: () =>
      toast.success("Declined — the CLI will stop offering this link"),
    onError: (error) => toast.error(error.message),
  });

  return (
    <PageShell>
      <div className="flex flex-col gap-2">
        <h1 className="text-lg font-semibold">Access request</h1>
        <p className="text-sm text-muted-foreground">
          {/* Said as the link's claim, not the server's: nothing here has
              been checked, and the account a grant lands on is the one
              picked below. */}
          The link says{" "}
          <span className="font-medium text-foreground">
            {search.login ?? "an agent"}
          </span>{" "}
          could not reach the{" "}
          {search.targets.length === 1 ? "project" : "projects"} below.
        </p>
      </div>

      {reason === null ? null : (
        <div className="space-y-1 rounded-lg border bg-muted/40 p-3">
          <p className="text-xs uppercase tracking-wide text-muted-foreground">
            Reason given by the CLI · not verified
          </p>
          {/* Plain text on purpose — see REASON_MAX. */}
          <p className="text-sm whitespace-pre-wrap break-words">{reason}</p>
        </div>
      )}

      <div className="divide-y overflow-hidden rounded-lg border">
        {rows.map((row) => (
          <TargetRow
            key={row.raw}
            row={row}
            project={projects.find((p) => p.slug === row.slug)}
            denyUid={search.uid}
            busy={decline.isPending || grant.isPending}
            onChoose={(slug) =>
              setChosen((prev) => ({ ...prev, [row.raw]: slug }))
            }
            onRole={(slug, role) =>
              setRoles((prev) => ({ ...prev, [slug]: role }))
            }
            onInclude={(slug, next) =>
              setDropped((prev) => {
                const copy = { ...prev };
                if (next) delete copy[slug];
                else copy[slug] = true;
                return copy;
              })
            }
            onDeny={(slug, userId) => decline.mutate({ slug, userId })}
          />
        ))}
      </div>

      {grantable.length === 0 ? null : (
        <>
          {picker.candidates.length === 0 ? (
            <NoTarget hasAgents={agents.length > 0} />
          ) : (
            <AuthTargetFieldset
              // No `me`: a grant here never lands on the opener (T-301).
              picker={picker}
              legend="Grant access to"
              // Creating an account here would grant a role to something that
              // is not the caller that failed.
              allowNew={false}
            />
          )}
          <div className="flex items-center justify-between gap-2">
            <RolePermissionsDialog />
            <Button
              onClick={() => subject !== null && grant.mutate(subject)}
              disabled={subject === null || grant.isPending}
            >
              {grant.isPending
                ? "Adding…"
                : grantable.length === 1
                  ? "Add to project"
                  : `Add to ${grantable.length} projects`}
            </Button>
          </div>
        </>
      )}
    </PageShell>
  );
}

/**
 * Stands where the fieldset would be when the opener owns no account a grant
 * could land on. The two causes need different instructions, so they are told
 * apart here rather than folded into one sentence (as on AddAgentPicker).
 */
function NoTarget({ hasAgents }: { hasAgents: boolean }) {
  const linkClass = "font-medium text-foreground hover:underline";
  return (
    <div className="flex flex-col gap-1">
      <p className="text-sm font-medium">Grant access to</p>
      <p className="text-sm text-muted-foreground">
        A grant here lands on an agent you own — never on your own account.{" "}
        {hasAgents ? (
          <>
            Every agent you own is deactivated:{" "}
            <Link
              to="/settings/agents"
              search={{ state: "deactivated" }}
              className={linkClass}
            >
              reactivate one
            </Link>
            , then come back to this page.
          </>
        ) : (
          <>
            You own none yet:{" "}
            <Link to="/settings/agents" className={linkClass}>
              create an agent
            </Link>
            , then come back to this page.
          </>
        )}
      </p>
    </div>
  );
}

function TargetRow({
  row,
  project,
  denyUid,
  busy,
  onChoose,
  onRole,
  onInclude,
  onDeny,
}: {
  row: Row;
  project: ProjectBriefRow | undefined;
  denyUid: number | undefined;
  busy: boolean;
  onChoose: (slug: string) => void;
  onRole: (slug: string, role: MemberRole) => void;
  onInclude: (slug: string, next: boolean) => void;
  onDeny: (slug: string, userId: number) => void;
}) {
  const { raw, target, slug, members, isAdmin, role, included } = row;
  if (target.kind === "none") {
    return (
      <div className="space-y-1 px-3 py-3">
        <p className="font-mono text-sm">{raw}</p>
        {/* The one sentence this page may say about a project it cannot see,
            and therefore the same sentence it says about one that does not
            exist. No Decline either: declining names a project. */}
        <p className="text-sm text-muted-foreground">
          No project you can read answers to this. If such a project does exist,
          only someone who can see it can act on this request.
        </p>
      </div>
    );
  }

  if (slug === null) {
    return (
      <div className="space-y-2 px-3 py-3">
        <p className="font-mono text-sm">{raw}</p>
        <p className="text-sm text-muted-foreground">
          Several projects you can read answer to this — pick the one it means.
        </p>
        <div className="flex flex-wrap gap-2">
          {(target.kind === "several" ? target.slugs : []).map((candidate) => (
            <Button
              key={candidate}
              size="sm"
              variant="outline"
              onClick={() => onChoose(candidate)}
            >
              {candidate}
            </Button>
          ))}
        </div>
      </div>
    );
  }

  const admins = (members ?? []).filter((m) => m.role === "admin");
  const name = project?.name ?? slug;

  return (
    <div className="flex flex-wrap items-center gap-3 px-3 py-3">
      {isAdmin ? (
        <input
          type="checkbox"
          className="accent-primary"
          aria-label={`include ${slug}`}
          checked={included}
          onChange={(e) => onInclude(slug, e.target.checked)}
        />
      ) : null}
      <div className="min-w-40 flex-1">
        <p className="text-sm font-medium">{name}</p>
        <p className="font-mono text-xs text-muted-foreground">{slug}</p>
      </div>
      {isAdmin ? (
        <Select
          value={role}
          onValueChange={(next) => onRole(slug, next as MemberRole)}
        >
          <SelectTrigger size="sm" aria-label={`role in ${slug}`}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {ROLES.map((option) => (
              <SelectItem key={option} value={option}>
                {option}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : (
        <p className="flex flex-wrap items-center gap-1 text-sm text-muted-foreground">
          {/* Naming the project is no disclosure: reading it is what got the
              opener this far, and saying nothing would read as a broken
              link. Same wording as the read-only member row elsewhere. */}
          <span>You are not an admin of {name}</span>
          {admins.length === 0 ? null : (
            <>
              <span>— ask</span>
              {admins.map((admin) => (
                <UserChip key={admin.user.id} user={admin.user} />
              ))}
            </>
          )}
        </p>
      )}
      {denyUid === undefined ? null : (
        <Button
          variant="outline"
          size="sm"
          disabled={busy}
          onClick={() => onDeny(slug, denyUid)}
        >
          Decline
        </Button>
      )}
    </div>
  );
}

export function GrantAccessPage() {
  const routerSearch = useSearch({ strict: false }) as Record<string, unknown>;
  const search = parseGrantSearch(routerSearch);
  // Read once, and from `window.location`: the router never sees a fragment,
  // which is exactly why the reason travels in one.
  const [reason] = useState(() =>
    readReason(typeof window === "undefined" ? "" : window.location.hash),
  );

  const me = useQuery(meQuery);
  const agents = useQuery(agentsQuery);
  const projects = useQuery(projectsQuery);
  const directory = useQuery(referenceDirectoryQuery);

  if (search.targets.length === 0) {
    return (
      <PageShell>
        <p className="text-sm text-destructive">
          This access link names no project. Re-run the command that printed it.
        </p>
      </PageShell>
    );
  }
  if (
    me.isPending ||
    agents.isPending ||
    projects.isPending ||
    directory.isPending
  ) {
    return (
      <div className="mx-auto max-w-2xl space-y-3 px-4 py-16">
        <Skeleton className="h-8 w-2/3" />
        <Skeleton className="h-48 w-full" />
      </div>
    );
  }
  const failure = me.error ?? agents.error ?? projects.error;
  if (failure || me.isError || agents.isError || projects.isError) {
    return (
      <PageShell>
        <p className="text-sm text-destructive">
          Could not load your projects: {failure?.message ?? "unknown error"}
        </p>
      </PageShell>
    );
  }
  return (
    <GrantAccessCard
      search={search}
      reason={reason}
      me={me.data}
      agents={agents.data}
      projects={projects.data}
      directory={directory.data ?? null}
    />
  );
}
