import {
  useMutation,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query";
import { useParams } from "@tanstack/react-router";
import type {
  Member,
  MemberRole,
  Status,
  StatusUpdateInput,
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

const ROLES: MemberRole[] = ["admin", "writer", "reader"];

/** Preset swatches offered in the status color popover. */
export const STATUS_COLORS = [
  "#6b7280",
  "#ef4444",
  "#f97316",
  "#f59e0b",
  "#eab308",
  "#22c55e",
  "#10b981",
  "#14b8a6",
  "#0ea5e9",
  "#3b82f6",
  "#8b5cf6",
  "#ec4899",
];

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
    </div>
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
              <StatusColorPicker
                status={status}
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

function StatusColorPicker({
  status,
  onPick,
}: {
  status: Status;
  onPick: (color: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [hex, setHex] = useState(status.color);
  const normalized = normalizeHexColor(hex);

  const pick = (color: string) => {
    onPick(color);
    setOpen(false);
  };

  return (
    <Popover
      open={open}
      onOpenChange={(isOpen) => {
        setOpen(isOpen);
        if (isOpen) setHex(status.color);
      }}
    >
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={`change ${status.name} color`}
          title="Change color"
        >
          <span
            className="size-4 rounded-full border"
            style={{ backgroundColor: status.color }}
            aria-hidden
          />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-2">
        <div className="grid grid-cols-6 gap-1.5">
          {STATUS_COLORS.map((color) => (
            <button
              key={color}
              type="button"
              aria-label={`set ${status.name} color ${color}`}
              className="flex size-6 cursor-pointer items-center justify-center rounded-full border transition-transform hover:scale-110"
              style={{ backgroundColor: color }}
              onClick={() => pick(color)}
            >
              {color === status.color.toLowerCase() && (
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
            value={normalized ?? status.color}
            onChange={(e) => setHex(e.target.value)}
            aria-label={`custom color for ${status.name}`}
            className="size-7 shrink-0 cursor-pointer rounded border"
          />
          <Input
            value={hex}
            onChange={(e) => setHex(e.target.value)}
            placeholder="#8b5cf6"
            aria-label={`custom hex for ${status.name}`}
            className="h-7 w-24 font-mono text-xs"
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

  return (
    <section className="space-y-3">
      <h2 className="text-lg font-semibold">Labels</h2>
      <div className="flex flex-wrap items-center gap-2">
        {labels.data.map((label) => (
          <span key={label.id} className="inline-flex items-center gap-1">
            <LabelChip label={label} />
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
        <input
          type="color"
          value={color}
          onChange={(e) => setColor(e.target.value)}
          aria-label="label color"
          className="size-8 cursor-pointer rounded border"
        />
        <Button type="submit" size="sm">
          <PlusIcon className="size-3.5" /> Add
        </Button>
      </form>
    </section>
  );
}
