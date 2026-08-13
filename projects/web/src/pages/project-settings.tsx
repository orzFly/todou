import {
  useMutation,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query";
import { useParams } from "@tanstack/react-router";
import {
  formatRef,
  type Member,
  type MemberRole,
  type Status,
  type StatusUpdateInput,
} from "@todou/shared";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  CheckIcon,
  PinIcon,
  PlusIcon,
  Trash2Icon,
} from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import {
  agentsQuery,
  api,
  labelsQuery,
  membersQuery,
  statusesQuery,
} from "@/api/queries.ts";
import { referenceConfigQuery } from "@/api/references.ts";
import { LabelChip } from "@/components/issue/label-chip.tsx";
import { StatusPill } from "@/components/issue/status-pill.tsx";
import { UserChip } from "@/components/shared/user-chip.tsx";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
import { PRESET_COLORS } from "@/lib/labels.ts";

const ROLES: MemberRole[] = ["admin", "writer", "reader"];

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
      <MembersSection slug={slug} />
      <StatusesSection slug={slug} />
      <LabelsSection slug={slug} />
      <ReferencesSection slug={slug} />
    </div>
  );
}

export function ReferencesSection({ slug }: { slug: string }) {
  const config = useSuspenseQuery(referenceConfigQuery(slug));
  const [prefixDraft, setPrefixDraft] = useState<string | null>(null);
  const [linkPrefix, setLinkPrefix] = useState("");
  const [linkTemplate, setLinkTemplate] = useState("");
  const queryClient = useQueryClient();
  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: ["reference-config", slug] });

  const current = config.data.format.prefix;
  // null = untouched form; the input shows the live value until edited.
  const draft = prefixDraft ?? current ?? "";
  const dirty = prefixDraft !== null && (prefixDraft || null) !== current;

  const setFormat = useMutation({
    mutationFn: () =>
      api.setReferenceFormat(slug, { prefix: draft.trim() || null }),
    onSuccess: () => {
      setPrefixDraft(null);
      invalidate();
    },
    onError: (error) => toast.error(error.message),
  });
  const addAutolink = useMutation({
    mutationFn: () =>
      api.createAutolink(slug, {
        prefix: linkPrefix,
        url_template: linkTemplate,
      }),
    onSuccess: () => {
      setLinkPrefix("");
      setLinkTemplate("");
      invalidate();
    },
    onError: (error) => toast.error(error.message),
  });
  const removeAutolink = useMutation({
    mutationFn: (id: number) => api.deleteAutolink(slug, id),
    onSuccess: invalidate,
    onError: (error) => toast.error(error.message),
  });

  return (
    <section className="space-y-4">
      <h2 className="text-lg font-semibold">References</h2>
      <div className="space-y-2">
        <h3 className="text-sm font-medium">Issue reference format</h3>
        <p className="text-sm text-muted-foreground">
          How this project's issues are written and displayed. Existing text is
          safe: content keeps parsing under the format that was active when it
          was written.
        </p>
        <form
          className="flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (dirty) setFormat.mutate();
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
        <p className="text-xs text-muted-foreground">
          Empty = the built-in <code>#76</code> form. A prefix like{" "}
          <code>T</code> switches new writing to <code>T-76</code>.
        </p>
      </div>
      <div className="space-y-2">
        <h3 className="text-sm font-medium">Autolinks</h3>
        <p className="text-sm text-muted-foreground">
          Prefix + number tokens that link out to an external tracker, e.g.{" "}
          <code>#</code> → GitHub issues once the internal format is prefixed.
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
                    onClick={() => removeAutolink.mutate(rule.id)}
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
            if (linkPrefix && linkTemplate) addAutolink.mutate();
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

function MembersSection({ slug }: { slug: string }) {
  const members = useSuspenseQuery(membersQuery(slug));
  const agents = useSuspenseQuery(agentsQuery);
  const queryClient = useQueryClient();
  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: ["members", slug] });

  const setRole = useMutation({
    mutationFn: (vars: { userId: number; role: MemberRole }) =>
      api.setMember(slug, vars.userId, vars.role),
    onSuccess: invalidate,
    onError: (error) => toast.error(error.message),
  });
  const remove = useMutation({
    mutationFn: (userId: number) => api.removeMember(slug, userId),
    onSuccess: invalidate,
    onError: (error) => toast.error(error.message),
  });

  const memberIds = new Set(members.data.map((m) => m.user.id));
  const addableAgents = agents.data.filter(
    (a) => !memberIds.has(a.id) && a.disabled_at === null,
  );

  return (
    <section className="space-y-3">
      <h2 className="text-lg font-semibold">Members</h2>
      <div className="rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>User</TableHead>
              <TableHead className="w-36">Role</TableHead>
              <TableHead className="w-16" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {members.data.map((member: Member) => (
              <TableRow key={member.user.id}>
                <TableCell>
                  <UserChip user={member.user} />
                </TableCell>
                <TableCell>
                  <Select
                    value={member.role}
                    onValueChange={(role) =>
                      setRole.mutate({
                        userId: member.user.id,
                        role: role as MemberRole,
                      })
                    }
                  >
                    <SelectTrigger size="sm">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {ROLES.map((role) => (
                        <SelectItem key={role} value={role}>
                          {role}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </TableCell>
                <TableCell>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`remove ${member.user.login}`}
                    onClick={() => remove.mutate(member.user.id)}
                  >
                    <Trash2Icon className="size-4" />
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      {addableAgents.length > 0 && (
        <div className="flex items-center gap-2 text-sm">
          <span className="text-muted-foreground">Add agent:</span>
          {addableAgents.map((agent) => (
            <Button
              key={agent.id}
              variant="outline"
              size="sm"
              onClick={() =>
                setRole.mutate({ userId: agent.id, role: "writer" })
              }
            >
              <PlusIcon className="size-3.5" /> {agent.login}
            </Button>
          ))}
        </div>
      )}
    </section>
  );
}

function StatusesSection({ slug }: { slug: string }) {
  const statuses = useSuspenseQuery(statusesQuery(slug));
  const [name, setName] = useState("");
  const [category, setCategory] = useState<"open" | "closed">("open");
  const queryClient = useQueryClient();
  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: ["statuses", slug] });

  const create = useMutation({
    mutationFn: () =>
      api.createStatus(slug, { name, category, color: "#6b7280" }),
    onSuccess: () => {
      setName("");
      invalidate();
    },
    onError: (error) => toast.error(error.message),
  });
  const patch = useMutation({
    mutationFn: (vars: { id: number; input: StatusUpdateInput }) =>
      api.updateStatus(slug, vars.id, vars.input),
    onSuccess: invalidate,
    onError: (error) => toast.error(error.message),
  });
  const remove = useMutation({
    mutationFn: (id: number) => api.deleteStatus(slug, id),
    onSuccess: invalidate,
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
    patch.mutate({ id: a.id, input: { position: b.position } });
    patch.mutate({ id: b.id, input: { position: a.position } });
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
                  patch.mutate({ id: status.id, input: { color } })
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
                onClick={() => remove.mutate(status.id)}
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
          if (name.trim()) create.mutate();
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
    </section>
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

function LabelsSection({ slug }: { slug: string }) {
  const labels = useSuspenseQuery(labelsQuery(slug));
  const [name, setName] = useState("");
  const [color, setColor] = useState("#3b82f6");
  const queryClient = useQueryClient();
  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: ["labels", slug] });

  const create = useMutation({
    mutationFn: () => api.createLabel(slug, { name, color }),
    onSuccess: () => {
      setName("");
      invalidate();
    },
    onError: (error) => toast.error(error.message),
  });
  const remove = useMutation({
    mutationFn: (id: number) => api.deleteLabel(slug, id),
    onSuccess: invalidate,
    onError: (error) => toast.error(error.message),
  });
  const recolor = useMutation({
    mutationFn: (vars: { id: number; color: string }) =>
      api.updateLabel(slug, vars.id, { color: vars.color }),
    onSuccess: invalidate,
    onError: (error) => toast.error(error.message),
  });

  return (
    <section className="space-y-3">
      <h2 className="text-lg font-semibold">Labels</h2>
      <div className="flex flex-wrap items-center gap-2">
        {labels.data.map((label) => (
          <span key={label.id} className="inline-flex items-center gap-1">
            <LabelChip label={label} />
            <ColorPicker
              name={label.name}
              color={label.color}
              onPick={(picked) =>
                recolor.mutate({ id: label.id, color: picked })
              }
            />
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={`delete label ${label.name}`}
              onClick={() => remove.mutate(label.id)}
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
          if (name.trim()) create.mutate();
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
