import {
  type UseMutationResult,
  useMutation,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query";
import { useNavigate, useParams } from "@tanstack/react-router";
import {
  type AccessDenial,
  formatRef,
  MEMBER_ROLES,
  type Member,
  type MemberRole,
  type ProjectUpdateInput,
  ROLE_RANK,
  type Status,
  type StatusUpdateInput,
  type TodouError,
} from "@todou/shared";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  CheckIcon,
  PencilIcon,
  PinIcon,
  PlusIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import {
  accessDenialsQuery,
  agentsQuery,
  api,
  labelsQuery,
  membersQuery,
  meQuery,
  projectQuery,
  statusesQuery,
  useCan,
} from "@/api/queries.ts";
import { referenceConfigQuery } from "@/api/references.ts";
import { LabelChip } from "@/components/issue/label-chip.tsx";
import { StatusPill } from "@/components/issue/status-pill.tsx";
import { AddAgentPicker } from "@/components/shared/add-agent-picker.tsx";
import { AvatarEditor } from "@/components/shared/avatar-editor.tsx";
import { projectIconFallback } from "@/components/shared/project-icon.tsx";
import { RolePermissionsDialog } from "@/components/shared/role-permissions-table.tsx";
import { displayNameOf, UserChip } from "@/components/shared/user-chip.tsx";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { PRESET_COLORS } from "@/lib/labels.ts";
import { cappedRole } from "@/lib/roles.ts";
import { useProjectRefs } from "@/lib/use-project-refs.ts";

/** Exported so a test can hold the picker to the schema's own list. */
export const ROLES: readonly MemberRole[] = MEMBER_ROLES;

export { PRESET_COLORS };

/** Lenient hand-typed hex → canonical #rrggbb, or null when unparseable. */
export function normalizeHexColor(input: string): string | null {
  const raw = input.trim().replace(/^#/, "").toLowerCase();
  if (/^[0-9a-f]{6}$/.test(raw)) return `#${raw}`;
  if (/^[0-9a-f]{3}$/.test(raw)) {
    return `#${raw.replaceAll(/./g, (c) => c + c)}`;
  }
  return null;
}

export function ProjectSettingsPage() {
  const { slug } = useParams({ from: "/authed/projects/$slug" });
  return (
    <div className="space-y-10">
      <ProjectSection slug={slug} />
      <MembersSection slug={slug} />
      <AccessDenialsSection slug={slug} />
      <StatusesSection slug={slug} />
      <LabelsSection slug={slug} />
      <ReferencesSection slug={slug} />
      <SlugSection slug={slug} />
    </div>
  );
}

export function SlugSection({ slug }: { slug: string }) {
  const project = useSuspenseQuery(projectQuery(slug));
  const [draft, setDraft] = useState(slug);
  const [confirming, setConfirming] = useState(false);
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  const target = draft.trim();
  const dirty = target !== "" && target !== project.data.slug;
  const formerSlugs = project.data.former_slugs ?? [];

  const rename = useMutation({
    mutationFn: (vars: { slug: string; target: string; reclaim: boolean }) =>
      api.updateProject(vars.slug, {
        slug: vars.target,
        ...(vars.reclaim ? { reclaim: true } : {}),
      }),
    onSuccess: (updated, vars) => {
      setConfirming(false);
      // Every cache key in the app is keyed by slug; none of them are
      // reachable under the new one, so drop the lot rather than remap.
      queryClient.invalidateQueries();
      // The rename is on the project the write named, but the page may have
      // been left for another one while the write was paused — yanking the
      // reader back to `p`'s settings would turn a finished rename into a
      // navigation bug, so only follow when still standing on it.
      if (vars.slug === slug) {
        navigate({
          to: "/projects/$slug/settings",
          params: { slug: updated.slug },
          replace: true,
        });
      }
      toast.success(`Renamed to ${updated.slug}`);
    },
    onError: (error) => {
      if ((error as TodouError).code === "slug_reserved") {
        setConfirming(true);
        return;
      }
      setConfirming(false);
      toast.error(error.message);
    },
  });

  return (
    <section className="space-y-3">
      <h2 className="text-lg font-semibold">Slug</h2>
      <div className="max-w-xl space-y-3 rounded-lg border border-destructive/40 p-4">
        <p className="text-sm text-muted-foreground">
          Renaming keeps the old slug working — it redirects here until some
          other project takes it over.
        </p>
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (dirty) rename.mutate({ slug, target, reclaim: false });
          }}
        >
          <Input
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value.trim().toLowerCase());
              setConfirming(false);
            }}
            aria-label="project slug"
            className="w-64 font-mono"
          />
          <Button
            type="submit"
            size="sm"
            variant="destructive"
            disabled={!dirty || rename.isPending}
          >
            {rename.isPending ? "Renaming…" : "Rename"}
          </Button>
        </form>
        {confirming && (
          <div className="space-y-2 rounded-md border border-destructive/40 bg-destructive/5 p-3">
            <p className="text-sm">
              <code>{target}</code> still redirects to the project that used it.
              Taking it over sends that project's existing links — including
              attachment URLs in its old comments — here instead.
            </p>
            <Button
              size="sm"
              variant="destructive"
              disabled={rename.isPending}
              onClick={() => rename.mutate({ slug, target, reclaim: true })}
            >
              Take it over anyway
            </Button>
          </div>
        )}
        {formerSlugs.length > 0 && (
          <p className="text-sm text-muted-foreground">
            Also reachable as{" "}
            {formerSlugs.map((former, i) => (
              <span key={former}>
                {i > 0 && ", "}
                <code>{former}</code>
              </span>
            ))}
            .
          </p>
        )}
      </div>
    </section>
  );
}

/**
 * The project's icon, for whoever may change it.
 *
 * Mounted only when the viewer may edit — the caller's check, not one in
 * here, because the directory query behind the REF fallback would otherwise
 * be fetched for a reader who never gets to see the control.
 */
function ProjectIconEditor({ slug }: { slug: string }) {
  const project = useSuspenseQuery(projectQuery(slug));
  const refs = useProjectRefs([project.data]);
  const queryClient = useQueryClient();

  // Everything that draws an icon: this page, the project list and the home
  // cards, and the bot list's project chips.
  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["project", slug] });
    queryClient.invalidateQueries({ queryKey: ["projects"] });
    queryClient.invalidateQueries({ queryKey: ["agent-memberships"] });
  };
  const upload = useMutation({
    mutationFn: (file: File) => api.uploadProjectIcon(slug, file),
    onError: (error) => toast.error(error.message),
    onSettled: invalidate,
  });
  const remove = useMutation({
    mutationFn: () => api.deleteProjectIcon(slug),
    onError: (error) => toast.error(error.message),
    onSettled: invalidate,
  });

  const prefix = refs.get(slug)?.prefix ?? null;
  return (
    <AvatarEditor
      subject={{
        name: project.data.name,
        imageUrl: project.data.icon_url ?? null,
      }}
      shape="square"
      fallback={projectIconFallback({ name: project.data.name, prefix })}
      onUpload={(file) => upload.mutate(file)}
      onRemove={() => remove.mutate()}
      pending={upload.isPending || remove.isPending}
    />
  );
}

export function ProjectSection({ slug }: { slug: string }) {
  const project = useSuspenseQuery(projectQuery(slug));
  // Hidden rather than shown disabled: a reader has nothing to read here that
  // the icon beside the project's name upstairs does not already show.
  const mayEditIcon = useCan(slug, "project.update");
  const [nameDraft, setNameDraft] = useState<string | null>(null);
  const [descriptionDraft, setDescriptionDraft] = useState<string | null>(null);
  const queryClient = useQueryClient();

  const current = project.data;
  // null = untouched field; the control shows the live value until edited.
  const name = nameDraft ?? current.name;
  const description = descriptionDraft ?? current.description;

  const changes: ProjectUpdateInput = {};
  if (nameDraft !== null && nameDraft.trim() !== current.name) {
    changes.name = nameDraft.trim();
  }
  if (
    descriptionDraft !== null &&
    descriptionDraft.trim() !== current.description
  ) {
    changes.description = descriptionDraft.trim();
  }
  const dirty = Object.keys(changes).length > 0 && name.trim() !== "";

  const save = useMutation({
    mutationFn: (vars: { slug: string; changes: ProjectUpdateInput }) =>
      api.updateProject(vars.slug, vars.changes),
    onSuccess: (_data, vars) => {
      setNameDraft(null);
      setDescriptionDraft(null);
      queryClient.invalidateQueries({
        queryKey: ["project", vars.slug],
      });
      // The name rides along in the header, the switcher and the project list.
      queryClient.invalidateQueries({ queryKey: ["projects"] });
    },
    onError: (error) => toast.error(error.message),
  });

  return (
    <section className="space-y-3">
      <h2 className="text-lg font-semibold">Project</h2>
      {mayEditIcon && <ProjectIconEditor slug={slug} />}
      <form
        className="max-w-xl space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (dirty) save.mutate({ slug, changes });
        }}
      >
        <div className="space-y-2">
          <Label htmlFor="project-settings-name">Name</Label>
          <Input
            id="project-settings-name"
            value={name}
            onChange={(e) => setNameDraft(e.target.value)}
            placeholder="My potato field"
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="project-settings-description">Description</Label>
          <Textarea
            id="project-settings-description"
            value={description}
            onChange={(e) => setDescriptionDraft(e.target.value)}
            placeholder="Optional"
          />
        </div>
        <Button type="submit" size="sm" disabled={!dirty}>
          {save.isPending ? "Saving…" : "Save"}
        </Button>
      </form>
    </section>
  );
}

export function ReferencesSection({ slug }: { slug: string }) {
  const config = useSuspenseQuery(referenceConfigQuery(slug));
  const [prefixDraft, setPrefixDraft] = useState<string | null>(null);
  const [linkPrefix, setLinkPrefix] = useState("");
  const [linkTemplate, setLinkTemplate] = useState("");
  const queryClient = useQueryClient();
  const invalidate = (slug: string) =>
    queryClient.invalidateQueries({ queryKey: ["reference-config", slug] });
  const current = config.data.format.prefix;
  // null = untouched form; the input shows the live value until edited.
  const draft = prefixDraft ?? current ?? "";
  const dirty = prefixDraft !== null && (prefixDraft || null) !== current;
  const setFormat = useMutation({
    mutationFn: (vars: { slug: string; prefix: string | null }) =>
      api.setReferenceFormat(vars.slug, { prefix: vars.prefix }),
    onSuccess: (_data, vars) => {
      setPrefixDraft(null);
      invalidate(vars.slug);
    },
    onError: (error) => toast.error(error.message),
  });
  const addAutolink = useMutation({
    mutationFn: (vars: { slug: string; prefix: string; urlTemplate: string }) =>
      api.createAutolink(vars.slug, {
        prefix: vars.prefix,
        url_template: vars.urlTemplate,
      }),
    onSuccess: (_data, vars) => {
      setLinkPrefix("");
      setLinkTemplate("");
      invalidate(vars.slug);
    },
    onError: (error) => toast.error(error.message),
  });
  const removeAutolink = useMutation({
    mutationFn: (vars: { slug: string; id: number }) =>
      api.deleteAutolink(vars.slug, vars.id),
    onSuccess: (_data, vars) => invalidate(vars.slug),
    onError: (error) => toast.error(error.message),
  });

  return (
    <section className="space-y-4">
      <h2 className="text-lg font-semibold">References</h2>
      <div className="space-y-2">
        <h3 className="text-sm font-medium">Issue reference format</h3>
        <p className="text-sm text-muted-foreground">
          References already written keep pointing where they did — this only
          changes how new ones are read.
        </p>
        <form
          className="flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (dirty) setFormat.mutate({ slug, prefix: draft.trim() || null });
          }}
        >
          <Input
            value={draft}
            onChange={(e) =>
              setPrefixDraft(e.target.value.toUpperCase().trim())
            }
            placeholder="#"
            aria-label="reference format prefix"
            className="w-32"
          />
          <span
            className="text-sm text-muted-foreground"
            data-testid="ref-format-preview"
          >
            {formatRef(draft.trim() || null, 76)}
          </span>
          <Button type="submit" size="sm" disabled={!dirty}>
            {setFormat.isPending ? "Saving…" : "Save"}
          </Button>
        </form>
      </div>
      <div className="space-y-2">
        <h3 className="text-sm font-medium">Autolinks</h3>
        <p className="text-sm text-muted-foreground">
          Rendering only — no reference events.
        </p>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Prefix</TableHead>
              <TableHead>URL template</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {config.data.autolinks.map((rule) => (
              <TableRow key={rule.id}>
                <TableCell className="font-mono">{rule.prefix}</TableCell>
                <TableCell className="break-all font-mono text-xs">
                  {rule.url_template}
                </TableCell>
                <TableCell className="text-right">
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`delete autolink ${rule.prefix}`}
                    onClick={() => removeAutolink.mutate({ slug, id: rule.id })}
                  >
                    <Trash2Icon className="size-3.5" />
                  </Button>
                </TableCell>
              </TableRow>
            ))}
            {config.data.autolinks.length === 0 && (
              <TableRow>
                <TableCell
                  colSpan={3}
                  className="text-sm text-muted-foreground"
                >
                  No autolinks yet.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (linkPrefix && linkTemplate)
              addAutolink.mutate({
                slug,
                prefix: linkPrefix,
                urlTemplate: linkTemplate,
              });
          }}
        >
          <Input
            value={linkPrefix}
            onChange={(e) => setLinkPrefix(e.target.value.trim())}
            placeholder="Prefix (e.g. #)"
            aria-label="autolink prefix"
            className="w-36"
          />
          <Input
            value={linkTemplate}
            onChange={(e) => setLinkTemplate(e.target.value.trim())}
            placeholder="https://github.com/org/repo/issues/<num>"
            aria-label="autolink url template"
            className="w-96 max-w-full"
          />
          <Button type="submit" size="sm">
            <PlusIcon className="size-3.5" /> Add
          </Button>
        </form>
      </div>
    </section>
  );
}

const ORPHAN_NOTE =
  "They rejoin the list above by themselves once their owner is a member again.";

/**
 * One owner and the machines of theirs that are in this project. `owner` is
 * their membership row where they have one; an owner who holds no row still
 * heads a group, because their machines have to be filed under somebody.
 */
type Group = {
  key: number;
  owner: Member | null;
  ownerRef: Member["user"]["owner"] | Member["user"];
  machines: Member[];
};

/**
 * Members as an indented tree: a human, then the machines they own here
 * beneath them (T-340). The grouping is computed here rather than served,
 * because `listMembers` already carries every fact it needs — who owns each
 * machine, and what its owner's role here is.
 */
export function MembersSection({ slug }: { slug: string }) {
  const members = useSuspenseQuery(membersQuery(slug));
  const agents = useSuspenseQuery(agentsQuery);
  const me = useSuspenseQuery(meQuery);
  const queryClient = useQueryClient();
  const [addingPerson, setAddingPerson] = useState(false);
  const invalidate = (slug: string) =>
    queryClient.invalidateQueries({ queryKey: ["members", slug] });

  const setRole = useMutation({
    mutationFn: (vars: { slug: string; userId: number; role: MemberRole }) =>
      api.setMember(vars.slug, vars.userId, vars.role),
    onSuccess: (_data, vars) => invalidate(vars.slug),
    onError: (error) => toast.error(error.message),
  });
  const remove = useMutation({
    mutationFn: (vars: { slug: string; userId: number }) =>
      api.removeMember(vars.slug, vars.userId),
    onSuccess: (_data, vars) => invalidate(vars.slug),
    onError: (error) => toast.error(error.message),
  });
  const addPerson = useMutation({
    mutationFn: (vars: { slug: string; login: string; role: MemberRole }) =>
      api.addMember(vars.slug, { login: vars.login, role: vars.role }),
    onSuccess: (_data, vars) => {
      setAddingPerson(false);
      invalidate(vars.slug);
    },
    onError: (error) => toast.error(error.message),
  });

  const rows = members.data;
  // The same rule `projectRoleOf` applies server-side: an instance admin is
  // an admin here while holding no membership row, so reading my role off the
  // table alone would show them the page a stranger gets.
  const myRole: MemberRole | null = me.data.is_instance_admin
    ? "admin"
    : (rows.find((m) => m.user.id === me.data.id)?.role ?? null);
  const iAmAdmin = myRole === "admin";

  const { groups, orphans } = groupByOwner(rows);
  const memberIds = new Set(rows.map((m) => m.user.id));
  // A reporter who adds their agent as a writer would only meet the ceiling
  // as a 409; offer what they may actually grant instead.
  const addAgentRole = cappedRole("writer", myRole);

  const rowProps = { slug, me: me.data, iAmAdmin, setRole, remove };

  return (
    <section className="space-y-3">
      <h2 className="text-lg font-semibold">Members</h2>
      <div className="rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>User</TableHead>
              <TableHead className="w-52">
                <div className="flex flex-col items-start">
                  Role
                  <RolePermissionsDialog />
                </div>
              </TableHead>
              <TableHead className="w-16" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {groups.map((group) => (
              <GroupRows key={group.key} group={group} {...rowProps} />
            ))}
          </TableBody>
        </Table>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <AddAgentPicker
          agents={agents.data}
          memberIds={memberIds}
          busy={setRole.isPending}
          onAdd={(agent) => {
            // Null means no role of my own to hand down; the picker is not
            // offered a write it cannot make.
            if (addAgentRole === null) return;
            setRole.mutate({ slug, userId: agent.id, role: addAgentRole });
          }}
        />
        {iAmAdmin && !addingPerson && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => setAddingPerson(true)}
          >
            <PlusIcon className="size-3.5" /> Add person
          </Button>
        )}
      </div>
      {iAmAdmin && addingPerson && (
        <AddPersonForm
          busy={addPerson.isPending}
          onCancel={() => setAddingPerson(false)}
          onAdd={(login, role) => addPerson.mutate({ slug, login, role })}
        />
      )}
      {orphans.length > 0 && (
        <div className="space-y-2 pt-2">
          <h3 className="text-sm font-medium">Owner is not a member here</h3>
          <p className="max-w-xl text-sm text-muted-foreground">
            {ORPHAN_NOTE}
          </p>
          <div className="rounded-lg border border-amber-500/40">
            <Table>
              <TableBody>
                {orphans.map((group) => (
                  <GroupRows key={group.key} group={group} {...rowProps} />
                ))}
              </TableBody>
            </Table>
          </div>
        </div>
      )}
    </section>
  );
}

/**
 * Machines filed under their owner, and the ones whose owner has no role here
 * split off. The split is `owner_role`, not "is the owner in the list": an
 * instance admin owns machines in projects they hold no row in, and those are
 * ordinary rows with an ordinary ceiling.
 *
 * A missing `owner_role` — a server from before the field — stays in the main
 * list rather than being called an orphan, and reads as an unknown ceiling,
 * which `roleControl` renders read-only.
 */
function groupByOwner(rows: Member[]): { groups: Group[]; orphans: Group[] } {
  const humans = new Map<number, Member>();
  for (const row of rows) {
    if (row.user.kind === "human") humans.set(row.user.id, row);
  }
  const byOwner = new Map<number, Group>();
  const orphanOwners = new Set<number>();
  for (const row of rows) {
    const owner = row.user.owner;
    if (row.user.kind !== "machine" || owner === null) continue;
    let group = byOwner.get(owner.id);
    if (!group) {
      group = {
        key: owner.id,
        owner: humans.get(owner.id) ?? null,
        ownerRef: humans.get(owner.id)?.user ?? owner,
        machines: [],
      };
      byOwner.set(owner.id, group);
    }
    group.machines.push(row);
    if (row.owner_role === null) orphanOwners.add(owner.id);
  }
  for (const [id, row] of humans) {
    if (!byOwner.has(id)) {
      byOwner.set(id, {
        key: id,
        owner: row,
        ownerRef: row.user,
        machines: [],
      });
    }
  }

  const byName = (a: Group, b: Group) =>
    nameOf(a.ownerRef).localeCompare(nameOf(b.ownerRef));
  const all = [...byOwner.values()];
  for (const group of all) {
    group.machines.sort((a, b) =>
      displayNameOf(a.user).localeCompare(displayNameOf(b.user)),
    );
  }
  return {
    groups: all.filter((g) => !orphanOwners.has(g.key)).sort(byName),
    orphans: all.filter((g) => orphanOwners.has(g.key)).sort(byName),
  };
}

/** An owner reference carries no display name; its login has to stand in. */
const nameOf = (ref: Group["ownerRef"]): string =>
  ref === null ? "" : displayNameOf(ref);

type RoleVars = { slug: string; userId: number; role: MemberRole };
type RemoveVars = { slug: string; userId: number };

/** What every row in either table needs, carried as one bundle. */
type RowProps = {
  slug: string;
  me: { id: number };
  iAmAdmin: boolean;
  setRole: UseMutationResult<void, Error, RoleVars, unknown>;
  remove: UseMutationResult<void, Error, RemoveVars, unknown>;
};

function GroupRows({
  group,
  slug,
  me,
  iAmAdmin,
  setRole,
  remove,
}: RowProps & { group: Group }) {
  const owner = group.owner;
  return (
    <>
      {owner === null ? (
        <OwnerHeaderRow group={group} />
      ) : (
        <MemberRow
          member={owner}
          slug={slug}
          me={me}
          iAmAdmin={iAmAdmin}
          setRole={setRole}
          remove={remove}
        />
      )}
      {group.machines.map((machine) => (
        <MemberRow
          key={machine.user.id}
          member={machine}
          indented
          slug={slug}
          me={me}
          iAmAdmin={iAmAdmin}
          setRole={setRole}
          remove={remove}
        />
      ))}
    </>
  );
}

/**
 * An owner with no membership row of their own. Display only: giving it the
 * member row's template would put a role control and a remove button on a
 * membership that does not exist.
 */
function OwnerHeaderRow({ group }: { group: Group }) {
  const ref = group.ownerRef;
  const login = ref === null ? "?" : ref.login;
  const orphaned = group.machines.some((m) => m.owner_role === null);
  return (
    <TableRow>
      <TableCell>
        <span className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium">{login}</span>
          <span className="rounded-full border border-amber-500/50 px-2 py-0.5 text-xs text-amber-700 dark:text-amber-400">
            not a member of this project
          </span>
        </span>
      </TableCell>
      <TableCell className="text-sm text-muted-foreground">
        {orphaned ? "—" : "admin"}
      </TableCell>
      <TableCell />
    </TableRow>
  );
}

function MemberRow({
  member,
  indented = false,
  slug,
  me,
  iAmAdmin,
  setRole,
  remove,
}: RowProps & { member: Member; indented?: boolean }) {
  const isSelf = member.user.id === me.id;
  const isMine =
    member.user.kind === "machine" && member.user.owner?.id === me.id;
  const mayWrite = isSelf ? false : iAmAdmin || isMine;
  const name = displayNameOf(member.user);

  return (
    <TableRow className={indented ? "bg-muted/40" : undefined}>
      <TableCell className={indented ? "pl-10" : undefined}>
        <span className="flex items-center gap-2">
          {indented && (
            <span
              className="h-4 w-3 -translate-y-1 rounded-bl border-b border-l border-muted-foreground/40"
              aria-hidden
            />
          )}
          <UserChip user={member.user} showLogin />
        </span>
      </TableCell>
      <TableCell>
        <RoleCell
          member={member}
          isSelf={isSelf}
          mayWrite={mayWrite}
          onPick={(role) =>
            setRole.mutate({ slug, userId: member.user.id, role })
          }
        />
      </TableCell>
      <TableCell>
        {mayWrite ? (
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={`remove ${name}`}
            onClick={() => remove.mutate({ slug, userId: member.user.id })}
          >
            <Trash2Icon className="size-4" />
          </Button>
        ) : isSelf ? (
          // A disabled control, not nothing: this one is meaningful to the
          // person looking at it, it is simply not theirs to press.
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={`remove ${name}`}
            disabled
          >
            <Trash2Icon className="size-4" />
          </Button>
        ) : null}
      </TableCell>
    </TableRow>
  );
}

/**
 * Three states, deliberately told apart. A row you may write gets a live
 * select capped at the owner's role; your own row keeps the control disabled;
 * a row you hold no authority over becomes plain text,
 * because a greyed control there only invites "did I misclick?".
 */
function RoleCell({
  member,
  isSelf,
  mayWrite,
  onPick,
}: {
  member: Member;
  isSelf: boolean;
  mayWrite: boolean;
  onPick: (role: MemberRole) => void;
}) {
  const isMachine = member.user.kind === "machine";
  const ceiling = isMachine ? member.owner_role : undefined;
  // Null and undefined both mean "no ceiling to check a role against": the
  // owner holds nothing here, or the server never said. Either way the role
  // cannot be written, only the row removed.
  const locked = isMachine && ceiling == null;
  const overCeiling =
    ceiling != null && ROLE_RANK[member.role] > ROLE_RANK[ceiling];

  if (locked) {
    return (
      <span
        className="text-sm text-muted-foreground"
        title="No ceiling can be worked out for this machine, so its role cannot be changed — only the row removed."
      >
        {member.role} <span className="opacity-70">(locked)</span>
      </span>
    );
  }
  if (!mayWrite && !isSelf) {
    return <span className="text-sm">{member.role}</span>;
  }

  const ownerLogin = member.user.owner?.login;
  const title =
    isSelf || ceiling == null
      ? undefined
      : `At most ${ceiling} — a machine cannot outrank its owner @${ownerLogin}.`;

  return (
    <span className="flex flex-col items-start gap-0.5">
      <Select
        value={member.role}
        disabled={isSelf}
        onValueChange={(role) => onPick(role as MemberRole)}
      >
        <SelectTrigger size="sm" title={title}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {ROLES.map((role) => (
            <SelectItem
              key={role}
              value={role}
              // The stored role stays selectable even when it is already over
              // the ceiling, or the control would show a role the project
              // does not hold. Writing it back is the server's to refuse.
              disabled={
                ceiling != null &&
                ROLE_RANK[role] > ROLE_RANK[ceiling] &&
                role !== member.role
              }
            >
              {role}
              {ceiling != null && ROLE_RANK[role] > ROLE_RANK[ceiling]
                ? " — above the owner"
                : ""}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {overCeiling && (
        <span className="text-xs text-amber-700 dark:text-amber-400">
          above @{ownerLogin} — the next change clamps it to {ceiling}
        </span>
      )}
    </span>
  );
}

/**
 * Add by exact login. No directory, no search box: a picker over every
 * account on the instance is a different thing to hand a project admin than
 * the ability to confirm one login they already knew.
 */
function AddPersonForm({
  busy,
  onAdd,
  onCancel,
}: {
  busy: boolean;
  onAdd: (login: string, role: MemberRole) => void;
  onCancel: () => void;
}) {
  const [login, setLogin] = useState("");
  const [role, setRole] = useState<MemberRole>("reporter");

  return (
    <form
      className="max-w-xl space-y-2 rounded-lg border p-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (login.trim()) onAdd(login.trim(), role);
      }}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm text-muted-foreground">@</span>
        <Input
          value={login}
          onChange={(e) => setLogin(e.target.value.trim().toLowerCase())}
          placeholder="their exact login"
          aria-label="login to add"
          className="w-56"
          autoFocus
        />
        <Select value={role} onValueChange={(v) => setRole(v as MemberRole)}>
          <SelectTrigger size="sm" className="w-32" aria-label="role to add as">
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
        <Button type="submit" size="sm" disabled={busy || login.trim() === ""}>
          {busy ? "Adding…" : "Add"}
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

/**
 * Agents somebody told to stop asking for access here (T-280). Undone from
 * this page rather than from the agent's own settings, because the person who
 * clicked Decline may only be a reader — and this is where the people of a
 * project manage who reaches it.
 */
export function AccessDenialsSection({ slug }: { slug: string }) {
  const denials = useSuspenseQuery(accessDenialsQuery(slug));
  const queryClient = useQueryClient();

  const allow = useMutation({
    mutationFn: (vars: { slug: string; userId: number }) =>
      api.allowAccess(vars.slug, vars.userId),
    onSuccess: (_data, vars) =>
      queryClient.invalidateQueries({
        queryKey: ["access-denials", vars.slug],
      }),
    onError: (error) => toast.error(error.message),
  });

  if (denials.data.length === 0) return null;

  return (
    <section className="space-y-3">
      <h2 className="text-lg font-semibold">Declined access requests</h2>
      <p className="max-w-xl text-sm text-muted-foreground">
        An admin can still add them above; nothing else is blocked.
      </p>
      <div className="rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Agent</TableHead>
              <TableHead>Declined by</TableHead>
              <TableHead className="w-44">When</TableHead>
              <TableHead className="w-24" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {denials.data.map((denial: AccessDenial) => (
              <TableRow key={denial.user.id}>
                <TableCell>
                  <UserChip user={denial.user} showLogin />
                </TableCell>
                <TableCell>
                  <UserChip user={denial.denied_by} />
                </TableCell>
                <TableCell className="text-sm text-muted-foreground">
                  {new Date(denial.created_at).toLocaleString()}
                </TableCell>
                <TableCell>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={allow.isPending}
                    aria-label={`allow ${displayNameOf(denial.user)} to ask again`}
                    onClick={() =>
                      allow.mutate({ slug, userId: denial.user.id })
                    }
                  >
                    Allow again
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </section>
  );
}

export function StatusesSection({ slug }: { slug: string }) {
  const statuses = useSuspenseQuery(statusesQuery(slug));
  const [name, setName] = useState("");
  const [category, setCategory] = useState<"open" | "closed">("open");
  const queryClient = useQueryClient();
  const invalidate = (slug: string) =>
    queryClient.invalidateQueries({ queryKey: ["statuses", slug] });
  const create = useMutation({
    mutationFn: (vars: {
      slug: string;
      name: string;
      category: "open" | "closed";
    }) =>
      api.createStatus(vars.slug, {
        name: vars.name,
        category: vars.category,
        color: "#6b7280",
      }),
    onSuccess: (_data, vars) => {
      setName("");
      invalidate(vars.slug);
    },
    onError: (error) => toast.error(error.message),
  });
  const patch = useMutation({
    mutationFn: (vars: {
      slug: string;
      id: number;
      input: StatusUpdateInput;
    }) => api.updateStatus(vars.slug, vars.id, vars.input),
    onSuccess: (_data, vars) => invalidate(vars.slug),
    onError: (error) => toast.error(error.message),
  });
  const remove = useMutation({
    mutationFn: (vars: { slug: string; id: number }) =>
      api.deleteStatus(vars.slug, vars.id),
    onSuccess: (_data, vars) => invalidate(vars.slug),
    onError: (error) =>
      toast.error(
        error.message.includes("used by")
          ? "Status is in use — move its issues to another status first."
          : error.message,
      ),
  });
  function swap(index: number, direction: -1 | 1) {
    const a = statuses.data[index];
    const b = statuses.data[index + direction];
    if (!a || !b) return;
    patch.mutate({ slug, id: a.id, input: { position: b.position } });
    patch.mutate({ slug, id: b.id, input: { position: a.position } });
  }

  return (
    <section className="space-y-3">
      <h2 className="text-lg font-semibold">Statuses</h2>
      <div className="space-y-2">
        {statuses.data.map((status: Status, index: number) => (
          <div
            key={status.id}
            className="flex items-center gap-2 rounded-md border px-3 py-1.5"
          >
            <StatusPill status={status} />
            <span className="text-xs text-muted-foreground">
              {status.category}
            </span>
            {status.is_default && (
              <span className="rounded-full border px-2 py-0.5 text-xs text-muted-foreground">
                default
              </span>
            )}
            <span className="ml-auto flex items-center gap-1">
              <ColorPicker
                name={status.name}
                color={status.color}
                onPick={(color) =>
                  patch.mutate({ slug, id: status.id, input: { color } })
                }
              />
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={
                  status.is_default
                    ? `clear default status`
                    : `make ${status.name} the default status`
                }
                title={
                  status.is_default
                    ? "Clear default — new issues go to the first status"
                    : "New issues default to this status"
                }
                onClick={() =>
                  patch.mutate({
                    slug,
                    id: status.id,
                    input: { is_default: !status.is_default },
                  })
                }
              >
                <PinIcon
                  className={
                    status.is_default
                      ? "size-4 fill-primary text-primary"
                      : "size-4 text-muted-foreground"
                  }
                />
              </Button>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={`move ${status.name} up`}
                disabled={index === 0}
                onClick={() => swap(index, -1)}
              >
                <ArrowUpIcon className="size-4" />
              </Button>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={`move ${status.name} down`}
                disabled={index === statuses.data.length - 1}
                onClick={() => swap(index, 1)}
              >
                <ArrowDownIcon className="size-4" />
              </Button>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={`delete ${status.name}`}
                onClick={() => remove.mutate({ slug, id: status.id })}
              >
                <Trash2Icon className="size-4" />
              </Button>
            </span>
          </div>
        ))}
      </div>
      <form
        className="flex items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim()) create.mutate({ slug, name, category });
        }}
      >
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="New status name"
          className="w-48"
        />
        <Select
          value={category}
          onValueChange={(v) => setCategory(v as "open" | "closed")}
        >
          <SelectTrigger className="w-28" size="sm">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="open">open</SelectItem>
            <SelectItem value="closed">closed</SelectItem>
          </SelectContent>
        </Select>
        <Button type="submit" size="sm">
          <PlusIcon className="size-3.5" /> Add
        </Button>
      </form>
      <ClearLinePicker slug={slug} statuses={statuses.data} />
    </section>
  );
}

/**
 * Which status stops a card blocking the ones waiting for it (T-377).
 *
 * Inside Statuses rather than beside it: the value names a status, the rule
 * is read off their order, and reordering the list above silently moves what
 * this means.
 */
function ClearLinePicker({
  slug,
  statuses,
}: {
  slug: string;
  statuses: Status[];
}) {
  const project = useSuspenseQuery(projectQuery(slug));
  const queryClient = useQueryClient();
  const current = project.data.block_clear_status_id ?? null;
  const set = useMutation({
    mutationFn: (vars: { slug: string; id: number | null }) =>
      api.updateProject(vars.slug, { block_clear_status_id: vars.id }),
    onSuccess: (_data, vars) => {
      queryClient.invalidateQueries({ queryKey: ["project", vars.slug] });
      // Every card's badge may have moved with the line.
      queryClient.invalidateQueries({ queryKey: ["issues"] });
      queryClient.invalidateQueries({ queryKey: ["issue"] });
    },
    onError: (error) => toast.error(error.message),
  });

  return (
    <div className="flex items-center gap-2 border-t pt-3">
      <span className="text-sm">Blocks clear at</span>
      <Select
        value={current === null ? "none" : String(current)}
        onValueChange={(v) =>
          set.mutate({ slug, id: v === "none" ? null : Number(v) })
        }
      >
        <SelectTrigger className="w-48" size="sm" aria-label="blocks clear at">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="none">any closed status</SelectItem>
          {statuses.map((status) => (
            <SelectItem key={status.id} value={String(status.id)}>
              {status.name} or later
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

function ColorPicker({
  name,
  color,
  onPick,
}: {
  name: string;
  color: string;
  onPick: (color: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [hex, setHex] = useState(color);
  const normalized = normalizeHexColor(hex);

  const pick = (picked: string) => {
    onPick(picked);
    setOpen(false);
  };

  return (
    <Popover
      open={open}
      onOpenChange={(isOpen) => {
        setOpen(isOpen);
        if (isOpen) setHex(color);
      }}
    >
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={`change ${name} color`}
          title="Change color"
        >
          <span
            className="size-4 rounded-full border"
            style={{ backgroundColor: color }}
            aria-hidden
          />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-2">
        <div className="grid grid-cols-6 gap-1.5">
          {PRESET_COLORS.map((preset) => (
            <button
              key={preset}
              type="button"
              aria-label={`set ${name} color ${preset}`}
              className="flex size-6 cursor-pointer items-center justify-center rounded-full border transition-transform hover:scale-110"
              style={{ backgroundColor: preset }}
              onClick={() => pick(preset)}
            >
              {preset === color.toLowerCase() && (
                <CheckIcon className="size-3.5 text-white drop-shadow" />
              )}
            </button>
          ))}
        </div>
        <form
          className="mt-2 flex items-center gap-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            if (normalized) pick(normalized);
          }}
        >
          <input
            type="color"
            value={normalized ?? color}
            onChange={(e) => setHex(e.target.value)}
            aria-label={`custom color for ${name}`}
            className="size-7 shrink-0 cursor-pointer rounded border"
          />
          <Input
            value={hex}
            onChange={(e) => setHex(e.target.value)}
            placeholder="#8b5cf6"
            aria-label={`custom hex for ${name}`}
            // text-base below md: sub-16px inputs trigger iOS focus auto-zoom.
            className="h-7 w-24 font-mono text-base md:text-xs"
          />
          <Button
            type="submit"
            size="sm"
            variant="outline"
            disabled={!normalized}
          >
            Set
          </Button>
        </form>
      </PopoverContent>
    </Popover>
  );
}

export function LabelsSection({ slug }: { slug: string }) {
  const labels = useSuspenseQuery(labelsQuery(slug));
  const [name, setName] = useState("");
  const [color, setColor] = useState("#3b82f6");
  const [editing, setEditing] = useState<{ id: number; draft: string } | null>(
    null,
  );
  const queryClient = useQueryClient();
  const invalidate = (slug: string) =>
    queryClient.invalidateQueries({ queryKey: ["labels", slug] });

  const create = useMutation({
    mutationFn: (vars: { slug: string; name: string; color: string }) =>
      api.createLabel(vars.slug, { name: vars.name, color: vars.color }),
    onSuccess: (_data, vars) => {
      setName("");
      invalidate(vars.slug);
    },
    onError: (error) => toast.error(error.message),
  });
  const remove = useMutation({
    mutationFn: (vars: { slug: string; id: number }) =>
      api.deleteLabel(vars.slug, vars.id),
    onSuccess: (_data, vars) => invalidate(vars.slug),
    onError: (error) => toast.error(error.message),
  });
  const recolor = useMutation({
    mutationFn: (vars: { slug: string; id: number; color: string }) =>
      api.updateLabel(vars.slug, vars.id, { color: vars.color }),
    onSuccess: (_data, vars) => invalidate(vars.slug),
    onError: (error) => toast.error(error.message),
  });
  const rename = useMutation({
    mutationFn: (vars: { slug: string; id: number; name: string }) =>
      api.updateLabel(vars.slug, vars.id, { name: vars.name }),
    onSuccess: (_data, vars) => {
      setEditing(null);
      invalidate(vars.slug);
      // Issue rows and board cards embed label names.
      queryClient.invalidateQueries({ queryKey: ["issues", vars.slug] });
    },
    onError: (error) => toast.error(error.message),
  });

  return (
    <section className="space-y-3">
      <h2 className="text-lg font-semibold">Labels</h2>
      <div className="flex flex-wrap items-center gap-2">
        {labels.data.map((label) => (
          <span key={label.id} className="inline-flex items-center gap-1">
            {editing?.id === label.id ? (
              <form
                className="inline-flex items-center gap-1"
                onSubmit={(e) => {
                  e.preventDefault();
                  const next = editing.draft.trim();
                  if (next === "" || next === label.name) setEditing(null);
                  else rename.mutate({ slug, id: label.id, name: next });
                }}
              >
                <Input
                  value={editing.draft}
                  onChange={(e) =>
                    setEditing({ id: label.id, draft: e.target.value })
                  }
                  onKeyDown={(e) => {
                    if (e.key === "Escape") setEditing(null);
                  }}
                  aria-label={`new name for ${label.name}`}
                  autoFocus
                  // text-base below md: sub-16px inputs trigger iOS focus auto-zoom.
                  className="h-7 w-44 text-base md:text-xs"
                />
                <Button
                  type="submit"
                  size="icon-sm"
                  variant="ghost"
                  aria-label={`save name for ${label.name}`}
                >
                  <CheckIcon className="size-3.5" />
                </Button>
                <Button
                  type="button"
                  size="icon-sm"
                  variant="ghost"
                  aria-label={`cancel renaming ${label.name}`}
                  onClick={() => setEditing(null)}
                >
                  <XIcon className="size-3.5" />
                </Button>
              </form>
            ) : (
              <>
                <LabelChip label={label} />
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`rename label ${label.name}`}
                  onClick={() =>
                    setEditing({ id: label.id, draft: label.name })
                  }
                >
                  <PencilIcon className="size-3.5" />
                </Button>
              </>
            )}
            <ColorPicker
              name={label.name}
              color={label.color}
              onPick={(picked) =>
                recolor.mutate({ slug, id: label.id, color: picked })
              }
            />
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={`delete label ${label.name}`}
              onClick={() => remove.mutate({ slug, id: label.id })}
            >
              <Trash2Icon className="size-3.5" />
            </Button>
          </span>
        ))}
        {labels.data.length === 0 && (
          <span className="text-sm text-muted-foreground">No labels yet.</span>
        )}
      </div>
      <form
        className="flex items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim()) create.mutate({ slug, name, color });
        }}
      >
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="New label name"
          className="w-48"
        />
        <ColorPicker name="new label" color={color} onPick={setColor} />
        <Button type="submit" size="sm">
          <PlusIcon className="size-3.5" /> Add
        </Button>
      </form>
    </section>
  );
}
