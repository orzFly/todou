import type { IssueListItem } from "@todou/shared";
import {
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { useRefCandidates } from "@/api/ref-candidates.ts";
import { StatusPill } from "@/components/issue/status-pill.tsx";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { parsesAsRef } from "@/lib/ref-completion.ts";
import { cn } from "@/lib/utils";

type PickerRow =
  | { kind: "project"; key: string; ref: string; name: string }
  | { kind: "issue"; key: string; ref: string; item: IssueListItem }
  | { kind: "raw"; key: string; ref: string };

export function RefPicker({
  slug,
  exclude,
  trigger,
  pending,
  onPick,
}: {
  slug: string;
  exclude: ReadonlyArray<{ slug: string; number: number }>;
  trigger: ReactNode;
  pending: boolean;
  /**
   * Resolve = clear and close; reject = keep the picker and original input.
   *
   * `target` is where the ref points, for a caller that has to draw the pick
   * back before anything has resolved it — the card being created on the
   * new-issue page has no server round-trip to read it out of (T-458). It is
   * null for a hand-typed ref that matched no candidate, which is the one
   * shape this component cannot resolve locally.
   */
  onPick: (
    ref: string,
    target: { slug: string; number: number } | null,
  ) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState("");
  const [selection, setSelection] = useState({
    value: "",
    signature: "",
    index: -1,
  });
  const input = useRef<HTMLInputElement>(null);
  const baseId = useId();
  const listId = `${baseId}-listbox`;
  const candidates = useRefCandidates(slug, value, open, exclude);
  const issueRows = [...candidates.open, ...candidates.closed].map(
    (item): PickerRow => ({
      kind: "issue",
      key: `issue-${candidates.target}-${item.number}`,
      ref: `${candidates.anchor}${item.number}`,
      item,
    }),
  );
  const rawMatchesCandidate =
    candidates.typedTarget !== null &&
    candidates.typedTarget.slug === candidates.target &&
    issueRows.some(
      (row) =>
        row.kind === "issue" &&
        row.item.number === candidates.typedTarget?.number,
    );
  const raw =
    value !== "" &&
    parsesAsRef(
      value,
      typeof window === "undefined"
        ? "https://todou.example"
        : window.location.origin,
    ) &&
    !rawMatchesCandidate;
  const rows: PickerRow[] = [
    ...candidates.projects.map(
      (project): PickerRow => ({
        kind: "project",
        key: `project-${project.slug}`,
        ref: project.spellings[0] as string,
        name: project.name,
      }),
    ),
    ...issueRows,
    ...(raw ? [{ kind: "raw" as const, key: "raw", ref: value }] : []),
  ];

  const signature = rows.map((row) => `${row.key}:${row.ref}`).join("\u0000");
  const exactIndex = rows.findIndex(
    (row) =>
      row.kind === "issue" &&
      candidates.typedTarget?.slug === candidates.target &&
      row.item.number === candidates.typedTarget.number,
  );
  const initial =
    value.trim() === ""
      ? -1
      : raw
        ? rows.length - 1
        : exactIndex >= 0
          ? exactIndex
          : rows.length > 0
            ? 0
            : -1;
  const active =
    selection.value === value && selection.signature === signature
      ? selection.index
      : initial;
  const setActive = (index: number) =>
    setSelection({ value, signature, index });
  const activeOption = useRef<HTMLButtonElement>(null);
  const activeKey = rows[active]?.key;
  useEffect(() => {
    if (active >= 0 && activeKey !== undefined) {
      activeOption.current?.scrollIntoView({ block: "nearest" });
    }
  }, [active, activeKey]);

  const fill = (row: PickerRow) => {
    setValue(row.ref);
    requestAnimationFrame(() => input.current?.focus());
  };
  const choose = async (row: PickerRow) => {
    if (pending) return;
    if (row.kind === "project") {
      fill(row);
      return;
    }
    try {
      await onPick(
        row.ref,
        row.kind === "issue"
          ? { slug: candidates.target, number: row.item.number }
          : candidates.typedTarget,
      );
      setValue("");
      setOpen(false);
    } catch {
      input.current?.focus();
    }
  };
  const move = (next: number) => {
    if (rows.length === 0) return;
    setActive(Math.max(0, Math.min(next, rows.length - 1)));
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (pending || event.nativeEvent.isComposing) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      move(active < 0 ? 0 : active + 1);
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      move(active < 0 ? rows.length - 1 : active - 1);
      return;
    }
    if (event.key === "Home") {
      event.preventDefault();
      move(0);
      return;
    }
    if (event.key === "End") {
      event.preventDefault();
      move(rows.length - 1);
      return;
    }
    const row = rows[active];
    if (row === undefined) {
      if (event.key === "Enter" && raw) {
        event.preventDefault();
        void choose({ kind: "raw", key: "raw", ref: value });
      }
      return;
    }
    if (event.key === "Tab") {
      event.preventDefault();
      fill(row);
    } else if (event.key === "Enter") {
      event.preventDefault();
      void choose(row);
    }
  };
  const option = (row: PickerRow, index: number) => {
    const id = `${baseId}-option-${index}`;
    return (
      <button
        key={row.key}
        ref={active === index ? activeOption : undefined}
        id={id}
        type="button"
        role="option"
        tabIndex={-1}
        aria-selected={active === index}
        disabled={pending}
        className={cn(
          "flex w-full cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm outline-none disabled:cursor-default disabled:opacity-50",
          active === index && "bg-accent",
        )}
        onMouseDown={(event) => event.preventDefault()}
        onMouseEnter={() => setActive(index)}
        onClick={() => void choose(row)}
      >
        {row.kind === "project" ? (
          <>
            <span className="text-muted-foreground">◇</span>
            <span className="font-mono text-xs">{row.ref}</span>
            <span className="ml-auto truncate text-xs text-muted-foreground">
              {row.name}
            </span>
          </>
        ) : row.kind === "issue" ? (
          <>
            <span className="shrink-0 font-mono text-xs text-muted-foreground">
              {row.ref}
            </span>
            <span className="min-w-0 flex-1 truncate">{row.item.title}</span>
            <StatusPill status={row.item.status} className="shrink-0" />
          </>
        ) : (
          <>
            <span className="text-muted-foreground">+</span>
            <span className="min-w-0 flex-1 truncate font-mono text-xs">
              {row.ref}
            </span>
            <span className="shrink-0 text-xs text-muted-foreground">
              as typed
            </span>
          </>
        )}
      </button>
    );
  };

  const projectCount = candidates.projects.length;
  const openCount = candidates.open.length;
  const closedStart = projectCount + openCount;
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) setSelection({ value: "", signature: "", index: -1 });
      }}
    >
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent
        className="w-72 overflow-hidden p-0"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          input.current?.focus();
        }}
      >
        <input
          ref={input}
          role="combobox"
          aria-expanded={rows.length > 0}
          aria-controls={rows.length > 0 ? listId : undefined}
          aria-autocomplete="list"
          aria-activedescendant={
            active < 0 ? undefined : `${baseId}-option-${active}`
          }
          autoComplete="off"
          className="w-full border-b bg-transparent px-3 py-2 text-base outline-none placeholder:text-muted-foreground disabled:opacity-50 md:text-sm"
          placeholder="#12 or other-project#12"
          value={value}
          disabled={pending}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={onKeyDown}
        />
        {rows.length > 0 && (
          <div
            id={listId}
            role="listbox"
            aria-label="Issue references"
            className="max-h-80 overflow-y-auto p-1"
          >
            {rows.slice(0, projectCount + openCount).map(option)}
            {candidates.closed.length > 0 && (
              <fieldset
                aria-label="Closed"
                className="m-0 min-w-0 border-0 p-0"
              >
                <div
                  aria-hidden="true"
                  className="px-2 py-1 text-xs text-muted-foreground"
                >
                  closed
                </div>
                {rows
                  .slice(closedStart, closedStart + candidates.closed.length)
                  .map((row, offset) => option(row, closedStart + offset))}
              </fieldset>
            )}
            {raw && option(rows[rows.length - 1] as PickerRow, rows.length - 1)}
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
