import type { UserKind } from "@todou/shared";
import { CheckIcon, ChevronDownIcon } from "lucide-react";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { PICKER_ROW, usePickerOrder } from "@/components/issue/picker-row.ts";
import { displayNameOf, UserAvatar } from "@/components/shared/user-chip.tsx";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";

/** What every user picker needs to know about a candidate. */
export type PickerUser = {
  id: number;
  login: string;
  display_name?: string;
  avatar_url?: string | null;
  kind?: UserKind;
};

/**
 * The one way a person is drawn wherever the reader is choosing one (T-677):
 * avatar, display name, `@login`. `lead="login"` swaps the two texts for the
 * completion panels, where the login is what gets typed and inserted, so it is
 * what the eye has to land on first.
 */
export function UserOption({
  user,
  badge = true,
  lead = "name",
  children,
}: {
  user: PickerUser;
  /**
   * Off only where every candidate is an agent: the badge is what tells the
   * two kinds apart, and a list of one kind gains nothing from it (T-236).
   */
  badge?: boolean;
  lead?: "name" | "login";
  /** Trailing content: a check slot, a note. */
  children?: ReactNode;
}) {
  const name = displayNameOf(user);
  const login = `@${user.login}`;
  return (
    <>
      {/* Decorative: the initials fallback would otherwise be read out glued
          to the name this row already carries. The badge keeps its own
          label, since it is the only thing telling a human from an agent. */}
      <UserAvatar user={user} badge={badge} aria-hidden />
      {/* Short of room, the name gives way and the login never does: the
          login is what tells two people of one name apart. */}
      {lead === "login" ? (
        <>
          <span className="shrink-0">{login}</span>
          <span className="min-w-0 truncate text-muted-foreground">{name}</span>
        </>
      ) : (
        <>
          <span className="min-w-0 truncate">{name}</span>
          <span className="shrink-0 text-muted-foreground">{login}</span>
        </>
      )}
      {children}
    </>
  );
}

/** Case-insensitive, on either the display name or the login. */
export function matchesUser(user: PickerUser, query: string): boolean {
  const q = query.trim().toLowerCase();
  return (
    q === "" ||
    user.login.toLowerCase().includes(q) ||
    displayNameOf(user).toLowerCase().includes(q)
  );
}

/**
 * A trigger for a single-choice picker that reads like the Select it
 * replaced, showing who is picked. The avatar rides along, since the trigger
 * is often too narrow for the `@login` the rows disambiguate with.
 */
export function UserSelectTrigger({
  user,
  placeholder,
  size = "default",
  className,
  ...props
}: {
  user: PickerUser | undefined;
  /** Shown when nobody is picked. */
  placeholder: string;
  size?: "sm" | "default";
} & React.ComponentProps<"button">) {
  return (
    <button
      type="button"
      className={cn(
        "flex items-center justify-between gap-1.5 rounded-lg border border-input bg-transparent pr-2 pl-2.5 text-sm whitespace-nowrap transition-colors outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-input/30 dark:hover:bg-input/50",
        size === "sm" ? "h-7 rounded-[min(var(--radius-md),10px)]" : "h-8",
        className,
      )}
      {...props}
    >
      <span className="flex min-w-0 items-center gap-1.5">
        {user === undefined ? (
          <span className="truncate">{placeholder}</span>
        ) : (
          <>
            <UserAvatar user={user} badge aria-hidden />
            <span className="truncate">{displayNameOf(user)}</span>
          </>
        )}
      </span>
      <ChevronDownIcon className="size-4 shrink-0 text-muted-foreground" />
    </button>
  );
}

type Row<U> = { kind: "anyone" } | { kind: "user"; user: U };

/**
 * Every "pick a person" popover in the app (T-677): a filter box over a
 * listbox of `UserOption` rows. A hand-rolled listbox — highlight via
 * aria-activedescendant, focus pinned on the input — rather than a Radix
 * menu, whose typeahead would fight the filter box for the same keys.
 *
 * `multiple` keeps it open across picks (assigning several people in a row
 * beats reopening after each); otherwise a pick closes it.
 */
export function UserPicker<U extends PickerUser>({
  users,
  selectedIds,
  onPick,
  trigger,
  multiple = false,
  anyone,
  badge = true,
  check = true,
  busy = false,
  noun = "people",
  empty,
  defaultOpen = false,
}: {
  users: U[];
  selectedIds: number[];
  /** Null is the `anyone` row. */
  onPick: (user: U | null) => void;
  trigger: ReactNode;
  multiple?: boolean;
  /**
   * Label of a leading row standing for nobody in particular, picked when
   * `selectedIds` is empty. Hidden while filtering: it matches no name.
   */
  anyone?: string;
  badge?: boolean;
  /** Off where picking adds rather than selects, so nothing stays checked. */
  check?: boolean;
  /** A write is pending or unavailable: disable the choices. */
  busy?: boolean;
  /** Plural, for the filter's placeholder and label. */
  noun?: string;
  /** What to say when there are no candidates at all. */
  empty?: string;
  /** Test-only, as on LabelPicker. */
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const idPrefix = useId();

  const ordered = usePickerOrder(
    users.filter((user) => matchesUser(user, query)),
    selectedIds,
    (user) => user.id,
    open,
    query,
  );
  const rows: Row<U>[] = [
    ...(anyone !== undefined && query.trim() === ""
      ? [{ kind: "anyone" } as const]
      : []),
    ...ordered.map((user) => ({ kind: "user", user }) as const),
  ];
  // Clamped, not just reset on keystroke: a pick can take its row out of
  // `users` (adding an agent makes it a member), from under a highlight
  // nobody moved.
  const hl = Math.min(highlight, Math.max(0, rows.length - 1));
  const optionId = (row: Row<U>) =>
    `${idPrefix}-${row.kind === "anyone" ? "anyone" : row.user.id}`;
  const active = rows[hl];

  useEffect(() => {
    if (!open) return;
    listRef.current
      ?.querySelector(`[data-idx="${hl}"]`)
      ?.scrollIntoView?.({ block: "nearest" });
  }, [open, hl]);

  const reset = (next: boolean) => {
    setOpen(next);
    setQuery("");
    setHighlight(0);
  };

  const pick = (row: Row<U> | undefined) => {
    if (busy || row === undefined) return;
    onPick(row.kind === "anyone" ? null : row.user);
    if (!multiple) reset(false);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") setHighlight(Math.min(hl + 1, rows.length - 1));
    else if (e.key === "ArrowUp") setHighlight(Math.max(hl - 1, 0));
    else if (e.key === "Home") setHighlight(0);
    else if (e.key === "End") setHighlight(Math.max(0, rows.length - 1));
    else if (e.key === "Enter") pick(rows[hl]);
    // Escape falls through to radix, which closes the popover with it.
    else return;
    e.preventDefault();
  };

  const isPicked = (row: Row<U>) =>
    row.kind === "anyone"
      ? selectedIds.length === 0
      : selectedIds.includes(row.user.id);

  return (
    <Popover open={open} onOpenChange={reset}>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      {/* Sized to the widest row, as the menus these replaced were, and held
          to the viewport by the available width radix measures. */}
      {/* Floating UI positions with roundByDPR = Math.round(value * dpr) / dpr.
          At DPR 1, rounding a half-pixel-wide popover's position right
          reduces the shared 8px collision padding to 7.5px of real clearance.
          The extra 0.5px bounds the rightward rounding error for DPR >= 1
          and preserves the overlay's measured 8px edge contract. Below DPR 1
          that bound does not hold: DPR 0.5 has a 2px rounding grid, so even
          padding 8.5 can leave 7.5px clearance. The smoke measures DPR 1. */}
      <PopoverContent
        className="w-auto max-w-(--radix-popover-content-available-width) min-w-64 p-0"
        collisionPadding={8.5}
        onKeyDown={onKeyDown}
        // Keyboard-first: focus lands in the filter, not on radix's default
        // first-focusable pick.
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          inputRef.current?.focus();
        }}
      >
        <input
          ref={inputRef}
          role="combobox"
          aria-expanded="true"
          aria-controls={`${idPrefix}-list`}
          aria-activedescendant={active ? optionId(active) : undefined}
          aria-label={`filter ${noun}`}
          placeholder={`Filter ${noun}…`}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setHighlight(0);
          }}
          // text-base below md: sub-16px inputs trigger iOS focus auto-zoom.
          className="w-full border-b bg-transparent px-3 py-2 text-base outline-none placeholder:text-muted-foreground md:text-sm"
        />
        <div
          ref={listRef}
          id={`${idPrefix}-list`}
          role="listbox"
          aria-label={noun}
          aria-multiselectable={multiple || undefined}
          className="max-h-64 overflow-y-auto p-1"
        >
          {rows.map((row, idx) => (
            <button
              type="button"
              key={optionId(row)}
              id={optionId(row)}
              data-idx={idx}
              disabled={busy}
              role="option"
              aria-selected={check && isPicked(row)}
              tabIndex={-1}
              className={cn(
                "flex w-full cursor-pointer items-center rounded-sm text-left whitespace-nowrap",
                PICKER_ROW,
                idx === hl && "bg-accent",
                busy && "opacity-50",
              )}
              // onMouseMove, not onMouseEnter: a list scrolling under a still
              // cursor would otherwise steal the highlight.
              onMouseMove={() => setHighlight(idx)}
              onClick={() => pick(row)}
            >
              {row.kind === "anyone" ? (
                <span className="min-w-0 truncate">{anyone}</span>
              ) : (
                <UserOption user={row.user} badge={badge} />
              )}
              {/* Kept in the layout unchecked (T-458): the popover sizes
                  itself to its widest row, so a check that only occupies
                  space once picked would widen it under the pointer that
                  just clicked. */}
              {check && (
                <span className="ml-auto w-4 shrink-0">
                  {isPicked(row) && <CheckIcon className="size-4" />}
                </span>
              )}
            </button>
          ))}
          {rows.length === 0 && (
            <div className="px-2 py-1.5 text-sm text-muted-foreground">
              {users.length === 0 && empty !== undefined
                ? empty
                : `No matching ${noun}.`}
            </div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
