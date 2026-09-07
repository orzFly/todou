import { useQuery } from "@tanstack/react-query";
import type {
  IssueMetadataEntry,
  IssueMetadataWriteEntry,
} from "@todou/shared";
import { MetadataKey, MetadataNamespace } from "@todou/shared";
import { type RefObject, useState } from "react";
import {
  conflictsOf,
  groupMetadata,
  issueMetadataQuery,
  type MetadataConflict,
  useWriteIssueMetadata,
} from "@/api/metadata.ts";
import { useCan } from "@/api/queries.ts";
import { compactAge } from "@/components/issue/metadata-section.tsx";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

/**
 * Which key a row names. Metadata entries have no id — `(namespace, key)` is
 * the name — so that pair is what every piece of local state here is keyed on.
 */
type Cell = { namespace: string; key: string };

const sameCell = (a: Cell | null, b: Cell): boolean =>
  a !== null && a.namespace === b.namespace && a.key === b.key;

/**
 * The row being edited, with the value that was on screen when the edit
 * began.
 *
 * `expect` is captured here rather than read off the entry at save time, and
 * that is the whole point of it: a tool writing to this key while someone is
 * typing arrives over the change feed and refetches, so an expectation read at
 * save time would quietly become the tool's new value and the save would
 * overwrite it — which is exactly what `if_match` exists to prevent.
 */
type Editing = Cell & { expect: string };

/**
 * Whether a value is long enough to fold. Read off the text rather than
 * measured off the layout: the dialog may not be laid out when this is first
 * asked, and being one line out only ever costs a button that expands
 * something already fully visible.
 */
function isLong(value: string): boolean {
  return value.split("\n").length > 5 || value.length > 240;
}

/**
 * The whole metadata table for one card (T-282): grouped by namespace, three
 * columns per group, and editable by anyone who may write.
 *
 * Grouped rather than carrying a repeated namespace column: a namespace is a
 * partition, its keys usually come from one writer and are read together, and
 * a repeated cell hands the grouping back to the reader to reassemble. Group
 * order and row order are the API's; neither end sorts twice.
 */
export function MetadataDialog({
  slug,
  issueNumber,
  open,
  onOpenChange,
  restoreFocusTo,
}: {
  slug: string;
  issueNumber: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  restoreFocusTo?: RefObject<HTMLElement | null>;
}) {
  // The same query the sidebar summary runs, so opening this costs nothing.
  const metadata = useQuery(issueMetadataQuery(slug, issueNumber));
  const canWrite = useCan(slug, "metadata.write");
  const write = useWriteIssueMetadata(slug, issueNumber);
  const groups = groupMetadata(metadata.data?.entries ?? []);

  const [editing, setEditing] = useState<Editing | null>(null);
  const [draft, setDraft] = useState("");
  const [expanded, setExpanded] = useState<Cell[]>([]);
  const [adding, setAdding] = useState<string | null>(null);
  const [newNamespace, setNewNamespace] = useState<string | null>(null);
  /** The write a 409 refused, kept so it can be re-sent against what is there now. */
  const [refused, setRefused] = useState<IssueMetadataWriteEntry[] | null>(
    null,
  );

  const conflicts = conflictsOf(write.error) ?? [];

  const reset = () => {
    setEditing(null);
    setDraft("");
    setAdding(null);
    setNewNamespace(null);
    setRefused(null);
    write.reset();
  };

  const submit = (entries: IssueMetadataWriteEntry[]) => {
    setRefused(entries);
    write.mutate(entries, {
      onSuccess: () => {
        setEditing(null);
        setAdding(null);
        setNewNamespace(null);
        setRefused(null);
      },
    });
  };

  /** Re-send what was refused, expecting what the server says is there now. */
  const retryAgainstCurrent = () => {
    if (refused === null) return;
    const now = new Map(
      conflicts.map((c) => [`${c.namespace}/${c.key}`, c.current]),
    );
    submit(
      refused.map((entry) => {
        const current = now.get(`${entry.namespace}/${entry.key}`);
        return current === undefined ? entry : { ...entry, if_match: current };
      }),
    );
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset();
        onOpenChange(next);
      }}
    >
      <DialogContent
        className="max-h-[85vh] overflow-y-auto sm:max-w-3xl"
        onCloseAutoFocus={(event) => {
          const trigger = restoreFocusTo?.current;
          if (!trigger) return;
          // Radix takes the focus back after this handler runs, so handing it
          // over synchronously here would be overwritten; a frame later the
          // dialog is gone and the trigger keeps it.
          event.preventDefault();
          requestAnimationFrame(() => trigger.focus());
        }}
      >
        <DialogHeader>
          <DialogTitle>Metadata</DialogTitle>
          <DialogDescription>
            These values are written by tools. They are not part of the card's
            history and nothing here notifies anyone.
          </DialogDescription>
        </DialogHeader>

        {conflicts.length > 0 && (
          <div
            className="space-y-2 rounded-md bg-muted p-2 text-sm"
            data-testid="metadata-conflict"
          >
            <p>Someone changed this while you were editing:</p>
            <ul className="space-y-0.5 font-mono text-xs">
              {conflicts.map((conflict) => (
                <li key={`${conflict.namespace}/${conflict.key}`}>
                  {conflict.namespace}/{conflict.key} is{" "}
                  {conflict.current === null
                    ? "not set"
                    : JSON.stringify(conflict.current)}
                  {changedBy(metadata.data?.entries ?? [], conflict)}
                </li>
              ))}
            </ul>
            {/* Never retried automatically: whether the edit still means what
                it meant is the reader's call, and only they can make it. */}
            <Button size="sm" variant="outline" onClick={retryAgainstCurrent}>
              Write over the new value
            </Button>
          </div>
        )}

        {write.isError && conflicts.length === 0 && (
          <p className="text-sm text-destructive">
            {(write.error as Error).message}
          </p>
        )}

        {groups.length === 0 && (
          <p className="text-sm text-muted-foreground">
            Nothing has been written on this card.
          </p>
        )}

        {groups.map((group) => (
          <section key={group.namespace} className="space-y-1">
            <h4 className="font-mono text-xs font-medium text-muted-foreground">
              {group.namespace}
            </h4>
            <table className="w-full table-fixed text-sm">
              <thead className="sr-only">
                <tr>
                  <th>Key</th>
                  <th>Value</th>
                  <th>Updated</th>
                </tr>
              </thead>
              <tbody>
                {group.entries.map((entry) => (
                  <Row
                    key={entry.key}
                    entry={entry}
                    canWrite={canWrite}
                    editing={sameCell(editing, entry)}
                    draft={draft}
                    expanded={expanded.some((cell) => sameCell(cell, entry))}
                    busy={write.isPending}
                    onExpand={() =>
                      setExpanded((prev) => [
                        ...prev,
                        { namespace: entry.namespace, key: entry.key },
                      ])
                    }
                    onEdit={() => {
                      write.reset();
                      setEditing({
                        namespace: entry.namespace,
                        key: entry.key,
                        expect: entry.value,
                      });
                      setDraft(entry.value);
                    }}
                    onDraft={setDraft}
                    onCancel={() => setEditing(null)}
                    onSave={() =>
                      submit([
                        {
                          namespace: entry.namespace,
                          key: entry.key,
                          value: draft,
                          // What was on screen when the edit began, so an
                          // edit over a value a tool has replaced since is
                          // refused rather than silently applied.
                          if_match: editing?.expect ?? entry.value,
                        },
                      ])
                    }
                    onDelete={() =>
                      submit([
                        {
                          namespace: entry.namespace,
                          key: entry.key,
                          value: null,
                          if_match: entry.value,
                        },
                      ])
                    }
                  />
                ))}
              </tbody>
            </table>
            {canWrite &&
              (adding === group.namespace ? (
                <NewEntry
                  namespace={group.namespace}
                  busy={write.isPending}
                  onCancel={() => setAdding(null)}
                  onSave={(key, value) =>
                    submit([
                      {
                        namespace: group.namespace,
                        key,
                        value,
                        // A key being added is expected not to be there.
                        if_match: null,
                      },
                    ])
                  }
                />
              ) : (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setAdding(group.namespace)}
                >
                  Add key
                </Button>
              ))}
          </section>
        ))}

        {canWrite &&
          (newNamespace === null ? (
            <div>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setNewNamespace("")}
              >
                Add namespace
              </Button>
            </div>
          ) : (
            <NewNamespace
              name={newNamespace}
              busy={write.isPending}
              onName={setNewNamespace}
              onCancel={() => setNewNamespace(null)}
              onSave={(namespace, key, value) =>
                submit([{ namespace, key, value, if_match: null }])
              }
            />
          ))}
      </DialogContent>
    </Dialog>
  );
}

/**
 * " (by alice)", when the refetch that followed the 409 already says who. The
 * error payload names the value but not the writer, and the refetch is on its
 * way regardless — so this fills in when it lands rather than asking again.
 */
function changedBy(
  entries: IssueMetadataEntry[],
  conflict: MetadataConflict,
): string {
  const entry = entries.find(
    (e) => e.namespace === conflict.namespace && e.key === conflict.key,
  );
  if (entry === undefined || entry.value !== conflict.current) return "";
  return ` (by ${entry.updated_by.display_name})`;
}

function Row({
  entry,
  canWrite,
  editing,
  draft,
  expanded,
  busy,
  onExpand,
  onEdit,
  onDraft,
  onCancel,
  onSave,
  onDelete,
}: {
  entry: IssueMetadataEntry;
  canWrite: boolean;
  editing: boolean;
  draft: string;
  expanded: boolean;
  busy: boolean;
  onExpand: () => void;
  onEdit: () => void;
  onDraft: (value: string) => void;
  onCancel: () => void;
  onSave: () => void;
  onDelete: () => void;
}) {
  const multiline = draft.includes("\n") || entry.value.includes("\n");
  const folded = isLong(entry.value) && !expanded;

  return (
    <tr className="align-top">
      <th
        scope="row"
        className="w-1/4 py-1 pr-2 text-left font-mono text-xs font-normal break-all"
      >
        {entry.key}
      </th>
      <td className="py-1 pr-2">
        {editing ? (
          <div className="space-y-1">
            {multiline ? (
              <textarea
                aria-label={`${entry.namespace}/${entry.key}`}
                className="min-h-20 w-full rounded-md border border-input bg-transparent p-1 font-mono text-xs field-sizing-content"
                value={draft}
                // biome-ignore lint/a11y/noAutofocus: the click that opened it
                autoFocus
                onChange={(e) => onDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    // Only this editor closes; the dialog stays open.
                    e.stopPropagation();
                    onCancel();
                  }
                }}
              />
            ) : (
              <input
                aria-label={`${entry.namespace}/${entry.key}`}
                className="w-full rounded-md border border-input bg-transparent p-1 font-mono text-xs"
                value={draft}
                // biome-ignore lint/a11y/noAutofocus: the click that opened it
                autoFocus
                onChange={(e) => onDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    e.stopPropagation();
                    onCancel();
                  }
                  if (e.key === "Enter") onSave();
                }}
              />
            )}
            <div className="flex gap-1">
              <Button size="sm" onClick={onSave} disabled={busy}>
                Save
              </Button>
              <Button size="sm" variant="ghost" onClick={onCancel}>
                Cancel
              </Button>
            </div>
          </div>
        ) : canWrite ? (
          <button
            type="button"
            onClick={onEdit}
            className="w-full rounded-md px-1 text-left hover:bg-muted"
            title="Edit this value"
          >
            <Value value={entry.value} folded={folded} />
          </button>
        ) : (
          <Value value={entry.value} folded={folded} />
        )}
        {folded && (
          <Button size="sm" variant="ghost" onClick={onExpand}>
            Show all
          </Button>
        )}
      </td>
      <td className="w-32 py-1 text-right text-xs text-muted-foreground">
        <span title={entry.updated_at}>{compactAge(entry.updated_at)}</span>
        <span className="block truncate">{entry.updated_by.display_name}</span>
        {canWrite && !editing && (
          // No second confirmation: one key/value pair is not a comment, and
          // a confirm per row would turn a cleanup into a clicking game.
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={onDelete}
            aria-label={`Delete ${entry.namespace}/${entry.key}`}
          >
            Delete
          </Button>
        )}
      </td>
    </tr>
  );
}

function Value({ value, folded }: { value: string; folded: boolean }) {
  return (
    <pre
      className={`font-mono text-xs whitespace-pre-wrap [overflow-wrap:anywhere] ${
        folded ? "line-clamp-5" : ""
      }`}
    >
      {value}
    </pre>
  );
}

function NewEntry({
  namespace,
  busy,
  onCancel,
  onSave,
}: {
  namespace: string;
  busy: boolean;
  onCancel: () => void;
  onSave: (key: string, value: string) => void;
}) {
  const [key, setKey] = useState("");
  const [value, setValue] = useState("");
  const bad = key !== "" && !MetadataKey.safeParse(key).success;

  return (
    <div className="space-y-1">
      <div className="flex gap-1">
        <input
          aria-label={`New key in ${namespace}`}
          className="w-1/3 rounded-md border border-input bg-transparent p-1 font-mono text-xs"
          placeholder="key"
          value={key}
          onChange={(e) => setKey(e.target.value)}
        />
        <input
          aria-label={`New value in ${namespace}`}
          className="flex-1 rounded-md border border-input bg-transparent p-1 font-mono text-xs"
          placeholder="value"
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
      </div>
      {bad && (
        <p className="text-xs text-destructive">
          A key is lowercase letters, digits, and . - _ between them.
        </p>
      )}
      <div className="flex gap-1">
        <Button
          size="sm"
          disabled={busy || key === "" || bad}
          onClick={() => onSave(key, value)}
        >
          Add
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

function NewNamespace({
  name,
  busy,
  onName,
  onCancel,
  onSave,
}: {
  name: string;
  busy: boolean;
  onName: (name: string) => void;
  onCancel: () => void;
  onSave: (namespace: string, key: string, value: string) => void;
}) {
  const [key, setKey] = useState("");
  const [value, setValue] = useState("");
  // Checked here against the same schema the server checks, so a name that
  // cannot work says so before a request goes out.
  const badName = name !== "" && !MetadataNamespace.safeParse(name).success;
  const badKey = key !== "" && !MetadataKey.safeParse(key).success;

  return (
    <div className="space-y-1 rounded-md border border-input p-2">
      <div className="flex gap-1">
        <input
          aria-label="New namespace"
          className="w-1/3 rounded-md border border-input bg-transparent p-1 font-mono text-xs"
          placeholder="namespace"
          value={name}
          onChange={(e) => onName(e.target.value)}
        />
        <input
          aria-label="First key of the new namespace"
          className="w-1/3 rounded-md border border-input bg-transparent p-1 font-mono text-xs"
          placeholder="key"
          value={key}
          onChange={(e) => setKey(e.target.value)}
        />
        <input
          aria-label="First value of the new namespace"
          className="flex-1 rounded-md border border-input bg-transparent p-1 font-mono text-xs"
          placeholder="value"
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
      </div>
      {badName && (
        <p className="text-xs text-destructive">
          A namespace is lowercase letters, digits, and . - _ between them.
        </p>
      )}
      {badKey && (
        <p className="text-xs text-destructive">
          A key is lowercase letters, digits, and . - _ between them.
        </p>
      )}
      <div className="flex gap-1">
        <Button
          size="sm"
          disabled={busy || name === "" || key === "" || badName || badKey}
          onClick={() => onSave(name, key, value)}
        >
          Add
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
