import {
  type Announcements,
  closestCenter,
  DndContext,
  type DragEndEvent,
  KeyboardSensor,
  PointerSensor,
  type UniqueIdentifier,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import {
  useMutation,
  useQuery,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  defaultInsightsRole,
  enumValue,
  Role,
  type Status,
  type StatusOrderInput,
  type StatusUpdateInput,
  type StatusUsage,
  TodouError,
} from "@todou/shared";
import {
  ChevronDownIcon,
  GripVerticalIcon,
  PlusIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react";
import { type CSSProperties, type ReactNode, useState } from "react";
import { toast } from "sonner";
import { insightsSettingsQuery, invalidateInsights } from "@/api/insights.ts";
import {
  api,
  projectQuery,
  statusesQuery,
  statusUsageQuery,
  useCan,
} from "@/api/queries.ts";
import { StatusPill } from "@/components/issue/status-pill.tsx";
import { ColorSwatches } from "@/components/settings/color-swatches.tsx";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { labelColorFor } from "@/lib/labels.ts";
import {
  arrangementOf,
  drawLine,
  type Item,
  itemId,
  LINE_ID,
  lineStatusOf,
  move,
  orderRequest,
  roleException,
} from "@/lib/status-arrangement.ts";
import { cn } from "@/lib/utils";

type Category = "open" | "closed";

type Draft = {
  name: string;
  category: Category;
  color: string;
  /** A stored role from a newer server stays as its raw string until picked. */
  role: string;
  isDefault: boolean;
};

const ROLE_LABELS: Record<Role, string> = {
  remaining: "Remaining",
  completed: "Completed",
  excluded: "Excluded",
};

const isRole = (role: string): role is Role => Role.safeParse(role).success;

const sortableId = (id: UniqueIdentifier) =>
  id === LINE_ID ? LINE_ID : Number(id);

const translate = (t: { x: number; y: number } | null) =>
  t ? `translate3d(${Math.round(t.x)}px, ${Math.round(t.y)}px, 0)` : undefined;

/**
 * One list for everything read off the status set (T-712): its order, the
 * block clear line drawn inside that order, and each status's chart role in
 * its own editor. Built on the Labels page so the two read as siblings.
 */
export function StatusesSection({ slug }: { slug: string }) {
  const statuses = useSuspenseQuery(statusesQuery(slug));
  const project = useSuspenseQuery(projectQuery(slug));
  const settings = useSuspenseQuery(insightsSettingsQuery(slug));
  // A heavier read than the list; the list does not wait for it.
  const usage = useQuery({
    ...statusUsageQuery(slug),
    enabled: useCan(slug, "status.usage"),
  });
  const canManage = useCan(slug, "status.manage");
  const queryClient = useQueryClient();

  const [open, setOpen] = useState<number | "new" | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  // Until picked, a new status's colour follows its name and its chart role
  // follows its name and category.
  const [colorPicked, setColorPicked] = useState(false);
  const [rolePicked, setRolePicked] = useState(false);
  const [deleting, setDeleting] = useState<Status | null>(null);

  const lineStatusId = project.data.block_clear_status_id ?? null;
  const items = arrangementOf(statuses.data, lineStatusId);
  const byId = new Map(statuses.data.map((s) => [s.id, s]));
  const roleById = new Map(
    settings.data.roles.map((entry) => [entry.status_id, entry.role]),
  );
  const usageById = new Map(usage.data?.map((u) => [u.id, u]));

  const invalidateBlocks = () => {
    // Every card's blocked badge can move with the order or the line.
    queryClient.invalidateQueries({ queryKey: ["issues"] });
    queryClient.invalidateQueries({ queryKey: ["issue"] });
  };

  const reorder = useMutation({
    mutationFn: (vars: { slug: string; input: StatusOrderInput }) =>
      api.reorderStatuses(vars.slug, vars.input),
    onMutate: async (vars) => {
      const statusesKey = statusesQuery(vars.slug).queryKey;
      const projectKey = projectQuery(vars.slug).queryKey;
      await Promise.all([
        queryClient.cancelQueries({ queryKey: statusesKey, exact: true }),
        queryClient.cancelQueries({ queryKey: projectKey, exact: true }),
      ]);
      const previous = {
        statuses: queryClient.getQueryData(statusesKey),
        project: queryClient.getQueryData(projectKey),
      };
      queryClient.setQueryData(statusesKey, (rows) => {
        if (!rows) return rows;
        const map = new Map(rows.map((row) => [row.id, row]));
        return vars.input.ids.flatMap((id, position) => {
          const row = map.get(id);
          return row ? [{ ...row, position }] : [];
        });
      });
      if (vars.input.block_clear_status_id !== undefined) {
        const line = vars.input.block_clear_status_id;
        queryClient.setQueryData(projectKey, (p) =>
          p ? { ...p, block_clear_status_id: line } : p,
        );
      }
      return previous;
    },
    onError: (error, vars, previous) => {
      if (previous) {
        queryClient.setQueryData(
          statusesQuery(vars.slug).queryKey,
          previous.statuses,
        );
        queryClient.setQueryData(
          projectQuery(vars.slug).queryKey,
          previous.project,
        );
      }
      toast.error(error.message);
    },
    onSettled: (_data, _error, vars) => {
      queryClient.invalidateQueries({
        queryKey: statusesQuery(vars.slug).queryKey,
      });
      queryClient.invalidateQueries({
        queryKey: projectQuery(vars.slug).queryKey,
      });
      invalidateBlocks();
    },
  });

  const afterWrite = (slug: string) => {
    queryClient.invalidateQueries({ queryKey: statusesQuery(slug).queryKey });
    void invalidateInsights(queryClient, slug);
    // Issue rows and board cards embed status names and colours.
    queryClient.invalidateQueries({ queryKey: ["issues", slug] });
  };

  const save = useMutation({
    mutationFn: async (vars: {
      slug: string;
      id: number;
      patch: StatusUpdateInput | null;
      role: Role | null;
    }) => {
      const results = await Promise.allSettled([
        vars.patch && api.updateStatus(vars.slug, vars.id, vars.patch),
        vars.role && api.setInsightsRole(vars.slug, vars.id, vars.role),
      ]);
      return results.flatMap((r) =>
        r.status === "rejected" ? [errorMessage(r.reason)] : [],
      );
    },
    onSuccess: (failures, vars) => {
      for (const message of failures) toast.error(message);
      if (failures.length === 0) setOpen(null);
      afterWrite(vars.slug);
      if (vars.patch?.category !== undefined) invalidateBlocks();
    },
    onError: (error) => toast.error(error.message),
  });

  const create = useMutation({
    mutationFn: async (vars: {
      slug: string;
      draft: Draft;
      role: Role | null;
    }) => {
      const created = await api.createStatus(vars.slug, {
        name: vars.draft.name,
        category: vars.draft.category,
        color: vars.draft.color,
      });
      if (vars.role) {
        try {
          await api.setInsightsRole(vars.slug, created.id, vars.role);
        } catch (error) {
          toast.error(errorMessage(error));
        }
      }
      return created;
    },
    onSuccess: (_data, vars) => {
      setOpen(null);
      afterWrite(vars.slug);
    },
    onError: (error) => toast.error(error.message),
  });

  const remove = useMutation({
    mutationFn: (vars: { slug: string; id: number }) =>
      api.deleteStatus(vars.slug, vars.id),
    onSuccess: (_data, vars) => {
      setDeleting(null);
      setOpen(null);
      afterWrite(vars.slug);
    },
    onError: (error, vars) => {
      toast.error(error.message);
      queryClient.invalidateQueries({
        queryKey: statusUsageQuery(vars.slug).queryKey,
      });
    },
  });

  function sendOrder(next: Item[]) {
    const input = orderRequest(next);
    const sameOrder = input.ids.every((id, i) => statuses.data[i]?.id === id);
    if (sameOrder && input.block_clear_status_id === lineStatusId) return;
    reorder.mutate({ slug, input });
  }

  function savedDraft(status: Status): Draft {
    return {
      name: status.name,
      category: enumValue(status.category, "status category") as Category,
      color: status.color,
      role: roleById.get(status.id) ?? defaultInsightsRole(status),
      isDefault: status.is_default,
    };
  }

  function toggle(status: Status) {
    if (open === status.id) return setOpen(null);
    setDraft(savedDraft(status));
    setOpen(status.id);
  }

  function startNew() {
    setDraft({
      name: "",
      category: "open",
      color: labelColorFor(""),
      role: defaultInsightsRole({ name: "", category: "open" }),
      isDefault: false,
    });
    setColorPicked(false);
    setRolePicked(false);
    setOpen("new");
  }

  const editedNew = (next: Draft, picked?: "role" | "color"): Draft => {
    const name = next.name.trim();
    return {
      ...next,
      color:
        colorPicked || picked === "color" ? next.color : labelColorFor(name),
      role:
        rolePicked || picked === "role"
          ? next.role
          : defaultInsightsRole({ name, category: next.category }),
    };
  };

  const sensors = useSensors(
    // A click on a grip is not a drag; the row scrolls normally on touch
    // because only the grip is `touch-action: none`.
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  const statusCount = statuses.data.length;
  const nameOf = (id: UniqueIdentifier) =>
    id === LINE_ID
      ? "The block clear line"
      : (byId.get(Number(id))?.name ?? "");
  function describe(active: UniqueIdentifier, over: UniqueIdentifier | null) {
    const next =
      over === null ? items : move(items, sortableId(active), sortableId(over));
    if (active === LINE_ID) {
      const at = byId.get(lineStatusOf(next) ?? -1);
      return at ? `Blocks now clear from ${at.name} down.` : "";
    }
    const rows = next.filter((item) => item.kind === "status");
    const index = rows.findIndex((item) => itemId(item) === active);
    const line = next.findIndex((item) => item.kind === "line");
    const self = next.findIndex((item) => itemId(item) === active);
    const status = byId.get(Number(active));
    const clears = line >= 0 ? self > line : status?.category === "closed";
    return `${status?.name}, position ${index + 1} of ${statusCount}${clears ? ", clears blocks" : ""}.`;
  }
  const announcements: Announcements = {
    onDragStart: ({ active }) => `Picked up ${nameOf(active.id)}.`,
    onDragOver: ({ active, over }) =>
      over ? describe(active.id, over.id) : undefined,
    onDragEnd: ({ active, over }) =>
      over ? describe(active.id, over.id) : undefined,
    onDragCancel: ({ active }) =>
      `${nameOf(active.id)} was put back where it was.`,
  };

  function onDragEnd({ active, over }: DragEndEvent) {
    if (!over || active.id === over.id) return;
    sendOrder(move(items, sortableId(active.id), sortableId(over.id)));
  }

  const firstStatus = statuses.data[0];
  const deletingStatus = deleting;

  return (
    <section className="space-y-3">
      <div className="flex min-h-8 items-center justify-between gap-3">
        <h2 className="text-lg font-semibold">Statuses</h2>
        {canManage && open !== "new" && (
          <Button variant="outline" onClick={startNew}>
            <PlusIcon className="size-3.5" /> New status
          </Button>
        )}
      </div>
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        accessibility={{ announcements }}
        onDragEnd={onDragEnd}
      >
        <SortableContext
          items={items.map(itemId)}
          strategy={verticalListSortingStrategy}
        >
          <div className="@container divide-y overflow-hidden rounded-lg border">
            {items.map((item) => {
              if (item.kind === "line") {
                return (
                  <ClearLine
                    key={LINE_ID}
                    canManage={canManage}
                    onRemove={() =>
                      sendOrder(items.filter((i) => i.kind !== "line"))
                    }
                  />
                );
              }
              const status = byId.get(item.id) as Status;
              const isOpen = open === status.id;
              const saved = savedDraft(status);
              const dirty =
                isOpen && draft !== null && !sameDraft(draft, saved);
              return (
                <StatusRow
                  key={status.id}
                  slug={slug}
                  status={status}
                  shown={isOpen && draft ? draft : saved}
                  isOpen={isOpen}
                  uses={usageById.get(status.id)}
                  canManage={canManage}
                  dragDisabled={dirty}
                  onToggle={() => toggle(status)}
                >
                  {isOpen && draft && (
                    <StatusEditor
                      draft={draft}
                      saved={saved}
                      firstStatus={firstStatus}
                      onDraft={setDraft}
                      submitLabel="Save"
                      canSubmit={draft.name.trim() !== "" && dirty}
                      pending={save.isPending}
                      onCancel={() => setOpen(null)}
                      deleteBlock={deleteBlock(
                        slug,
                        status,
                        usageById.get(status.id),
                        lineStatusId,
                      )}
                      onDelete={() => setDeleting(status)}
                      onSubmit={() => {
                        const name = draft.name.trim();
                        const patch: StatusUpdateInput = {
                          ...(name !== status.name && { name }),
                          ...(draft.category !== saved.category && {
                            category: draft.category,
                          }),
                          ...(draft.color !== status.color && {
                            color: draft.color,
                          }),
                          ...(draft.isDefault !== status.is_default && {
                            is_default: draft.isDefault,
                          }),
                        };
                        save.mutate({
                          slug,
                          id: status.id,
                          patch: Object.keys(patch).length > 0 ? patch : null,
                          role:
                            draft.role !== saved.role && isRole(draft.role)
                              ? draft.role
                              : null,
                        });
                      }}
                    />
                  )}
                </StatusRow>
              );
            })}
            {open === "new" && draft && (
              <div className="bg-muted/45">
                <div className="flex min-h-11 items-center pr-2 pl-3">
                  {draft.name.trim() ? (
                    <StatusPill
                      status={{ name: draft.name.trim(), color: draft.color }}
                    />
                  ) : (
                    <span className="text-sm text-muted-foreground">
                      New status
                    </span>
                  )}
                </div>
                <StatusEditor
                  draft={draft}
                  saved={null}
                  firstStatus={firstStatus}
                  onDraft={(next, picked) => {
                    if (picked === "role") setRolePicked(true);
                    if (picked === "color") setColorPicked(true);
                    setDraft(editedNew(next, picked));
                  }}
                  submitLabel="Create"
                  canSubmit={draft.name.trim() !== ""}
                  pending={create.isPending}
                  onCancel={() => setOpen(null)}
                  onSubmit={() => {
                    const name = draft.name.trim();
                    const role = isRole(draft.role) ? draft.role : null;
                    create.mutate({
                      slug,
                      draft: { ...draft, name },
                      role:
                        role !== null &&
                        role !==
                          defaultInsightsRole({
                            name,
                            category: draft.category,
                          })
                          ? role
                          : null,
                    });
                  }}
                />
              </div>
            )}
          </div>
        </SortableContext>
      </DndContext>
      {lineStatusId === null && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
          <span>Blocks clear at any closed status.</span>
          {canManage && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => sendOrder(drawLine(items, statuses.data))}
            >
              Draw a line
            </Button>
          )}
        </div>
      )}
      <ConfirmDialog
        open={deletingStatus !== null}
        onOpenChange={(isOpen) => {
          if (!isOpen) setDeleting(null);
        }}
        title="Delete this status?"
        description={
          deletingStatus && (
            <>
              <StatusPill status={deletingStatus} /> Burn charts will count time
              spent in it as unknown.
            </>
          )
        }
        confirmLabel="Delete status"
        destructive
        pending={remove.isPending}
        onConfirm={() => {
          if (deletingStatus) remove.mutate({ slug, id: deletingStatus.id });
        }}
      />
    </section>
  );
}

function errorMessage(error: unknown): string {
  return error instanceof TodouError || error instanceof Error
    ? error.message
    : String(error);
}

const sameDraft = (a: Draft, b: Draft) =>
  a.name.trim() === b.name &&
  a.category === b.category &&
  a.color === b.color &&
  a.role === b.role &&
  a.isDefault === b.isDefault;

const issuesLink = (slug: string, statusId: number) =>
  ({
    to: "/projects/$slug",
    params: { slug },
    // A closed status would otherwise land on the list's default, open.
    search: { status: String(statusId), category: "all" },
  }) as const;

const countLinkClass =
  "whitespace-nowrap tabular-nums underline-offset-3 hover:text-foreground hover:underline";

/** Why the server would refuse a delete, first reason first; null if it would not. */
function deleteBlock(
  slug: string,
  status: Status,
  uses: StatusUsage | undefined,
  lineStatusId: number | null,
): ReactNode {
  if (uses && uses.issues > 0) {
    return (
      <>
        <Link {...issuesLink(slug, status.id)} className={countLinkClass}>
          {plural(uses.issues, "issue")} {uses.issues === 1 ? "is" : "are"} in
          it
        </Link>{" "}
        — move {uses.issues === 1 ? "it" : "them"} first.
      </>
    );
  }
  if (uses && uses.trashed > 0) {
    return `${plural(uses.trashed, "trashed issue")} ${uses.trashed === 1 ? "is" : "are"} still in it.`;
  }
  if (lineStatusId === status.id) {
    return "Blocks clear here — move the line first.";
  }
  return null;
}

const plural = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;

function exceptionText(category: string, role: string): string {
  const parts = category === "closed" ? ["closed"] : [];
  const exception = roleException(
    { category } as Pick<Status, "category">,
    role,
  );
  if (exception !== null) {
    parts.push(
      exception === "excluded"
        ? "excluded from charts"
        : `${exception} in charts`,
    );
  }
  return parts.join(" · ");
}

function StatusRow({
  slug,
  status,
  shown,
  isOpen,
  uses,
  canManage,
  dragDisabled,
  onToggle,
  children,
}: {
  slug: string;
  status: Status;
  /** The saved status, or the open row's draft, which the row previews. */
  shown: Draft;
  isOpen: boolean;
  uses: StatusUsage | undefined;
  canManage: boolean;
  dragDisabled: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: status.id, disabled: !canManage || dragDisabled });
  const style: CSSProperties = { transform: translate(transform), transition };
  const pillName = shown.name.trim() || status.name;
  const tags = exceptionText(shown.category, shown.role);

  const body = (
    <>
      <StatusPill status={{ name: pillName, color: shown.color }} />
      {shown.isDefault && (
        <span className="rounded-full border px-2 py-0.5 text-xs text-muted-foreground">
          default
        </span>
      )}
      {tags && <span className="text-sm text-muted-foreground">{tags}</span>}
    </>
  );
  const bodyClass =
    "flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1 self-stretch py-2 text-left";

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={cn(
        isOpen ? "bg-muted/45" : "bg-background",
        isDragging && "relative z-10 shadow-lg",
      )}
    >
      <div
        className={cn(
          "flex min-h-11 items-center gap-1 pr-2",
          canManage ? "pl-0.5 sm:pl-1.5" : "pl-3",
          canManage && !isOpen && "hover:bg-muted/60",
        )}
      >
        {canManage && (
          <button
            ref={setActivatorNodeRef}
            type="button"
            {...attributes}
            {...listeners}
            aria-label={`Move ${status.name}`}
            disabled={dragDisabled}
            className="flex h-10 w-9 shrink-0 cursor-grab touch-none items-center justify-center rounded-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-default disabled:opacity-40 sm:h-8 sm:w-7"
          >
            <GripVerticalIcon className="size-4" />
          </button>
        )}
        {canManage ? (
          <button
            type="button"
            aria-expanded={isOpen}
            aria-label={`edit status ${status.name}`}
            className={cn(
              bodyClass,
              "cursor-pointer rounded-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
            )}
            onClick={onToggle}
          >
            {body}
          </button>
        ) : (
          <div className={bodyClass}>{body}</div>
        )}
        {uses && (
          <Link
            {...issuesLink(slug, status.id)}
            className={cn(countLinkClass, "pl-2 text-sm text-muted-foreground")}
          >
            {plural(uses.issues, "issue")}
          </Link>
        )}
        {canManage && (
          <Button
            variant="ghost"
            size="icon-sm"
            tabIndex={-1}
            aria-hidden
            onClick={onToggle}
          >
            <ChevronDownIcon
              className={cn(
                "size-4 text-muted-foreground transition-transform",
                isOpen && "rotate-180",
              )}
            />
          </Button>
        )}
      </div>
      {children}
    </div>
  );
}

/**
 * The block clear line, a seam between two rows: the status right below it
 * is `block_clear_status_id`. Its capsule is the drag handle, so the line
 * moves the way a row does.
 */
function ClearLine({
  canManage,
  onRemove,
}: {
  canManage: boolean;
  onRemove: () => void;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: LINE_ID, disabled: !canManage });
  const style: CSSProperties = { transform: translate(transform), transition };

  return (
    <div
      ref={setNodeRef}
      style={style}
      // The list draws each divider as a row's bottom border: the one above
      // the seam stays, the seam's own would be a second line under the rule.
      className={cn(
        "relative h-3.5 border-b-transparent max-sm:h-4.5",
        isDragging ? "z-20" : "z-1",
      )}
    >
      <span
        aria-hidden
        className="absolute inset-x-0 top-1.5 h-0.5 bg-foreground max-sm:top-2"
      />
      <span
        className={cn(
          "absolute -top-1 left-1/2 flex h-5.5 -translate-x-1/2 items-stretch overflow-hidden rounded-full bg-foreground text-xs font-medium whitespace-nowrap text-background max-sm:-top-1.25 max-sm:h-7",
          isDragging
            ? "shadow-[0_8px_24px_oklch(0_0_0/0.18)]"
            : "shadow-[0_1px_2px_oklch(0_0_0/0.12),0_2px_6px_oklch(0_0_0/0.08)]",
        )}
      >
        {canManage ? (
          <>
            <button
              ref={setActivatorNodeRef}
              type="button"
              {...attributes}
              {...listeners}
              aria-label="Blocks clear below; drag to move"
              className="flex cursor-grab touch-none items-center gap-1 pr-2.5 pl-1.5 outline-none hover:bg-background/15 focus-visible:bg-background/20"
            >
              <GripVerticalIcon aria-hidden className="size-3.25 opacity-60" />
              Blocks clear below
            </button>
            <button
              type="button"
              aria-label="Remove the block clear line"
              className="flex w-6 cursor-pointer items-center justify-center border-l border-background/20 text-background/70 outline-none hover:bg-background/15 hover:text-background focus-visible:bg-background/20 max-sm:w-8"
              onClick={onRemove}
            >
              <XIcon className="size-3.25" />
            </button>
          </>
        ) : (
          <span className="flex items-center px-2.5">Blocks clear below</span>
        )}
      </span>
    </div>
  );
}

function Segmented<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: ReadonlyArray<readonly [T, string]>;
  value: string;
  onChange: (value: T) => void;
}) {
  return (
    <fieldset
      aria-label={label}
      className="inline-flex w-fit gap-0.5 rounded-lg border bg-background p-0.5"
    >
      {options.map(([option, text]) => (
        <button
          key={option}
          type="button"
          aria-pressed={value === option}
          className="h-7 cursor-pointer rounded-md px-2.5 text-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 aria-pressed:bg-primary aria-pressed:font-medium aria-pressed:text-primary-foreground max-sm:h-8.5"
          onClick={() => onChange(option)}
        >
          {text}
        </button>
      ))}
    </fieldset>
  );
}

function StatusEditor({
  draft,
  saved,
  firstStatus,
  onDraft,
  submitLabel,
  canSubmit,
  pending,
  onCancel,
  deleteBlock,
  onDelete,
  onSubmit,
}: {
  draft: Draft;
  saved: Draft | null;
  firstStatus: Status | undefined;
  /** `picked` names the field the user chose outright, not by typing. */
  onDraft: (draft: Draft, picked?: "role" | "color") => void;
  submitLabel: string;
  canSubmit: boolean;
  pending: boolean;
  onCancel: () => void;
  deleteBlock?: ReactNode;
  onDelete?: () => void;
  onSubmit: () => void;
}) {
  const unknownRole = isRole(draft.role) ? null : draft.role;
  return (
    <form
      className="grid gap-4 px-3 pt-1 pb-3 @xl:grid-cols-[minmax(0,18rem)_auto] @xl:gap-x-8 sm:pl-11"
      onSubmit={(e) => {
        e.preventDefault();
        if (canSubmit) onSubmit();
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") onCancel();
      }}
    >
      <div className="space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="status-editor-name">Name</Label>
          <Input
            id="status-editor-name"
            value={draft.name}
            maxLength={60}
            onChange={(e) => onDraft({ ...draft, name: e.target.value })}
            placeholder="In Review"
            autoComplete="off"
            autoFocus
          />
        </div>
        <div className="space-y-1.5">
          <div className="text-sm leading-none font-medium">Category</div>
          <Segmented
            label="Category"
            options={[
              ["open", "Open"],
              ["closed", "Closed"],
            ]}
            value={draft.category}
            onChange={(category) => onDraft({ ...draft, category })}
          />
        </div>
        <div className="space-y-1.5">
          <div className="text-sm leading-none font-medium">In burn charts</div>
          <div className="flex flex-wrap items-center gap-2">
            <Segmented
              label="In burn charts"
              options={Role.options.map(
                (role) => [role, ROLE_LABELS[role]] as const,
              )}
              value={draft.role}
              onChange={(role) => {
                onDraft({ ...draft, role }, "role");
              }}
            />
            {unknownRole && (
              <span className="text-sm text-muted-foreground">
                {unknownRole}
              </span>
            )}
          </div>
          <p className="text-sm text-muted-foreground">
            Charts recount their whole history with it, not only from today.
          </p>
        </div>
        {saved !== null && (
          <div className="space-y-1.5">
            <Label className="flex items-center gap-2 font-normal">
              <Checkbox
                checked={draft.isDefault}
                onChange={(e) =>
                  onDraft({ ...draft, isDefault: e.target.checked })
                }
              />
              New issues start here
            </Label>
            {saved.isDefault && !draft.isDefault && firstStatus && (
              <p className="flex flex-wrap items-center gap-1 text-sm text-muted-foreground">
                Without a default they start in{" "}
                <StatusPill status={firstStatus} />.
              </p>
            )}
          </div>
        )}
      </div>
      <div className="space-y-1.5">
        <div className="text-sm leading-none font-medium">Colour</div>
        <ColorSwatches
          name={draft.name.trim() || "new status"}
          color={draft.color}
          onPick={(color) => {
            onDraft({ ...draft, color }, "color");
          }}
        />
      </div>
      <div className="flex flex-wrap items-center gap-2 border-t pt-3 @xl:col-span-2">
        {onDelete && (
          <>
            <Button
              type="button"
              variant="ghost"
              disabled={Boolean(deleteBlock)}
              className="text-destructive hover:bg-destructive/10 hover:text-destructive"
              onClick={onDelete}
            >
              <Trash2Icon className="size-3.5" /> Delete
            </Button>
            {deleteBlock && (
              <span className="text-sm text-muted-foreground">
                {deleteBlock}
              </span>
            )}
          </>
        )}
        <span className="flex-1" />
        <Button type="button" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" disabled={!canSubmit || pending}>
          {submitLabel}
        </Button>
      </div>
    </form>
  );
}
