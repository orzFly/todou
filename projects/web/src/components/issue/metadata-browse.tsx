import type { IssueMetadataEntry } from "@todou/shared";
import { PencilIcon, PlusIcon, Trash2Icon } from "lucide-react";
import type { ReactNode } from "react";
import { useState } from "react";
import { compactAge } from "@/components/issue/metadata-section.tsx";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { SM_UP, useMediaQuery } from "@/lib/use-media-query.ts";

/**
 * Whether a value is long enough to fold. Read off the text rather than
 * measured off the layout: the dialog may not be laid out when this is first
 * asked, and being one line out only ever costs a button that expands
 * something already fully visible.
 */
function isLong(value: string): boolean {
  return value.split("\n").length > 5 || value.length > 240;
}

/** The value's UTF-8 byte length, which is what the server's limit counts. */
function byteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

/**
 * The Browse tab (design: "Browse 档"): read-only. A reader opens this
 * dialog to see what external integrations wrote, so the tab shows exactly
 * that — a table, no editor state machine. Editing lives one click away in
 * Bulk or JSON, and the only controls here are the jumps to them, for
 * people who may write.
 *
 * One `table-fixed` table for the whole card: the key column is sized by
 * the longest key anywhere, so groups align across the card instead of
 * every group calibrating its own widths.
 */
export function MetadataBrowse({
  groups,
  canWrite,
  failure,
  onAddKey,
  onDeleteNamespace,
  onEditValue,
  onDeleteKey,
  onAdd,
}: {
  /** Grouped entries, in the API's order; neither end sorts again. */
  groups: {
    namespace: string;
    entries: IssueMetadataEntry[];
  }[];
  canWrite: boolean;
  /** The dialog's failure block. Given, it replaces the empty-card sentence
   * — an empty table is only "nothing written" once the query said so. */
  failure?: ReactNode;
  onAddKey: (namespace: string) => void;
  /** Bulk-delete every key in the group. */
  onDeleteNamespace: (namespace: string) => void;
  /** Jump to Bulk with this row's value selected. */
  onEditValue: (namespace: string, key: string) => void;
  /** Delete one key, immediately (a row is not worth a confirmation). */
  onDeleteKey: (namespace: string, key: string) => void;
  /** Jump to Bulk with a new-entry snippet at the end. */
  onAdd: () => void;
}) {
  const wide = useMediaQuery(SM_UP);
  const longestKey = Math.max(
    8,
    ...groups.flatMap((g) => g.entries.map((e) => e.key.length)),
  );
  // ch units size the column by the text itself, so no measuring pass.
  const keyColWidth = `${Math.min(longestKey, wide ? 40 : 16) + 2}ch`;
  // meta lives on the data row from `sm` up and drops to its own second
  // row below it, so the writable column count follows the viewport too.
  const columns = canWrite ? (wide ? 4 : 3) : wide ? 3 : 2;
  const [confirmingNs, setConfirmingNs] = useState<string | null>(null);

  return (
    <div className="space-y-3">
      <table
        className="w-full table-fixed border-separate border-spacing-0 text-sm"
        data-testid="metadata-browse-table"
      >
        <colgroup>
          <col style={{ width: keyColWidth }} />
          <col />
          {wide && <col style={{ width: "11rem" }} />}
          {canWrite && <col style={{ width: "3.5rem" }} />}
        </colgroup>
        <thead className="sr-only">
          <tr>
            <th scope="col">Key</th>
            <th scope="col">Value</th>
            {wide && <th scope="col">Updated</th>}
            {canWrite && <th scope="col">Actions</th>}
          </tr>
        </thead>
        {groups.map((group) => (
          <tbody
            key={group.namespace}
            data-testid={`metadata-group-${group.namespace}`}
          >
            <tr>
              <th
                colSpan={columns}
                scope="colgroup"
                className="pt-3 pb-1 text-left font-mono text-[12.5px] font-semibold"
              >
                [{group.namespace}]
                <span className="ml-2 font-sans text-xs font-normal text-muted-foreground">
                  {group.entries.length}{" "}
                  {group.entries.length === 1 ? "key" : "keys"}
                </span>
                {canWrite && (
                  <span className="float-right flex gap-1">
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => onAddKey(group.namespace)}
                      aria-label={`Add key in ${group.namespace}`}
                    >
                      <PlusIcon className="size-3.5" /> key
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setConfirmingNs(group.namespace)}
                      aria-label={`Delete namespace ${group.namespace}`}
                    >
                      <Trash2Icon className="size-3.5" />
                    </Button>
                  </span>
                )}
              </th>
            </tr>
            {group.entries.map((entry) => (
              <BrowseRow
                key={entry.key}
                entry={entry}
                canWrite={canWrite}
                wide={wide}
                onEdit={() => onEditValue(entry.namespace, entry.key)}
                onDelete={() => onDeleteKey(entry.namespace, entry.key)}
              />
            ))}
          </tbody>
        ))}
      </table>

      {groups.length === 0 &&
        (failure ?? (
          <p className="text-sm text-muted-foreground">
            Nothing has been written on this card.
          </p>
        ))}

      {canWrite && (
        <Button
          size="sm"
          variant="outline"
          className="w-full border-dashed"
          onClick={onAdd}
        >
          <PlusIcon className="size-3.5" /> Add
        </Button>
      )}

      <ConfirmDialog
        open={confirmingNs !== null}
        onOpenChange={(next) => {
          if (!next) setConfirmingNs(null);
        }}
        destructive
        title={
          confirmingNs === null
            ? ""
            : `Delete ${groups.find((g) => g.namespace === confirmingNs)?.entries.length ?? 0} keys in [${confirmingNs}]?`
        }
        description="Every key in this namespace is removed in one write. This is not part of the card's history."
        confirmLabel="Delete"
        onConfirm={() => {
          if (confirmingNs !== null) onDeleteNamespace(confirmingNs);
          setConfirmingNs(null);
        }}
      />
    </div>
  );
}

function BrowseRow({
  entry,
  canWrite,
  wide,
  onEdit,
  onDelete,
}: {
  entry: IssueMetadataEntry;
  canWrite: boolean;
  wide: boolean;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const folded = isLong(entry.value) && !expanded;
  const meta = (
    <span
      className="block truncate"
      title={`${entry.updated_by.display_name} · ${entry.updated_at}`}
    >
      {entry.updated_by.display_name} · {compactAge(entry.updated_at)}
    </span>
  );
  const actions = canWrite && (
    <span className="flex justify-end gap-0.5">
      <Button
        size="icon-xs"
        variant="ghost"
        onClick={onEdit}
        aria-label={`Edit ${entry.namespace}/${entry.key} in Bulk`}
        title="Edit in Bulk"
      >
        <PencilIcon />
      </Button>
      {/* No confirmation per row: one key/value pair is not a
          comment, and a confirm per row turns a cleanup into a
          clicking game. The namespace-level delete does confirm. */}
      <Button
        size="icon-xs"
        variant="ghost"
        onClick={onDelete}
        aria-label={`Delete ${entry.namespace}/${entry.key}`}
      >
        <Trash2Icon />
      </Button>
    </span>
  );

  return (
    <>
      <tr className="align-top">
        <th
          scope="row"
          className="border-t py-1 pr-2 text-left align-top font-mono text-xs font-normal truncate text-muted-foreground"
          title={entry.key}
        >
          {entry.key}
        </th>
        <td className="border-t py-1 pr-2">
          {entry.value === "" ? (
            <Badge variant="outline">empty</Badge>
          ) : folded ? (
            <div className="relative">
              <pre className="font-mono text-xs whitespace-pre-wrap [overflow-wrap:anywhere] line-clamp-5">
                {entry.value}
              </pre>
              <Button
                size="sm"
                variant="ghost"
                className="h-auto px-1 py-0.5 text-xs"
                onClick={() => setExpanded(true)}
              >
                Show all ({byteLength(entry.value)} B)
              </Button>
            </div>
          ) : (
            <pre className="font-mono text-xs whitespace-pre-wrap [overflow-wrap:anywhere]">
              {entry.value}
            </pre>
          )}
        </td>
        {wide && (
          <td className="border-t py-1 pr-2 text-right text-xs text-muted-foreground">
            {meta}
          </td>
        )}
        {canWrite && (
          <td className="border-t py-1 text-right align-top">{actions}</td>
        )}
      </tr>
      {!wide && (
        <tr>
          <td
            colSpan={canWrite ? 3 : 2}
            className="pb-1 text-right text-xs text-muted-foreground"
          >
            {meta}
          </td>
        </tr>
      )}
    </>
  );
}
