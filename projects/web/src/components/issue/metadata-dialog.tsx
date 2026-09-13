import type { EditorView } from "@codemirror/view";
import { useQuery } from "@tanstack/react-query";
import type {
  IssueMetadataEntry,
  IssueMetadataWriteEntry,
} from "@todou/shared";
import { type RefObject, useRef, useState } from "react";
import {
  conflictsOf,
  groupMetadata,
  issueMetadataQuery,
  type MetadataWriteVars,
  useWriteIssueMetadata,
} from "@/api/metadata.ts";
import { useCan } from "@/api/queries.ts";
import { MetadataBrowse } from "@/components/issue/metadata-browse.tsx";
import { MetadataEditorTab } from "@/components/issue/metadata-editor-tab.tsx";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { metadataJsonSupport } from "@/lib/editor/json-lang.ts";
import {
  appendNewEntry,
  insertKeyInGroup,
  metadataBulkSupport,
  selectValueOf,
} from "@/lib/editor/metadata-bulk-lang.ts";
import { parseBulk, serializeBulk } from "@/lib/metadata-bulk.ts";
import { type ConflictLine, conflictLines } from "@/lib/metadata-diff.ts";
import { parseJsonDoc, serializeJsonDoc } from "@/lib/metadata-json.ts";

type TabName = "browse" | "bulk" | "json";

const BULK_HELP =
  "One ns/key = value per line · # comments · heredoc <<MARK for multiline";
const JSON_HELP = "Formatted JSON: one object per namespace, string values.";

/**
 * The whole metadata surface for one card (design: "档位结构"): Browse to
 * read, Bulk and JSON to edit. The three panels are radix Tabs — the
 * non-active panel is not mounted, so switching tabs drops any draft. That
 * is deliberate: Bulk and JSON are two spellings of one document, and two
 * editors holding contradictory drafts is a state nobody can explain.
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
  const metadata = useQuery(issueMetadataQuery(slug, issueNumber));
  const canWrite = useCan(slug, "metadata.write");
  const write = useWriteIssueMetadata();
  const entries = metadata.data?.entries ?? [];
  const groups = groupMetadata(entries);
  const [tab, setTab] = useState<TabName>("browse");
  /** The write a 409 refused, kept so it can be re-sent against what is there now. */
  const [refused, setRefused] = useState<IssueMetadataWriteEntry[] | null>(
    null,
  );
  const [conflictNotice, setConflictNotice] = useState<ConflictLine[]>([]);
  const bulkView = useRef<EditorView | null>(null);
  const pendingJump = useRef<((view: EditorView) => void) | null>(null);

  const conflicts = conflictsOf(write.error) ?? [];

  const reset = () => {
    setRefused(null);
    setConflictNotice([]);
    setTab("browse");
    write.reset();
  };

  const submit = (writeEntries: IssueMetadataWriteEntry[]) => {
    setRefused(writeEntries);
    write.mutate(
      { slug, issueNumber, entries: writeEntries } satisfies MetadataWriteVars,
      {
        onSuccess: () => {
          setRefused(null);
          setConflictNotice([]);
        },
        onError: (error) => {
          // A refused write is explained by pairing what the user was
          // trying to do with what the server says is there now — from
          // whichever panel the write came (Browse delete, Bulk save…).
          const failed = conflictsOf(error);
          if (failed !== null) {
            setConflictNotice(conflictLines(writeEntries, failed, entries));
          }
        },
      },
    );
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

  /** Run a bulk-delete of every key in one namespace, after Browse's confirm. */
  const deleteNamespace = (namespace: string) => {
    const group = groups.find((g) => g.namespace === namespace);
    if (group === undefined) return;
    submit(
      group.entries.map((entry) => ({
        namespace: entry.namespace,
        key: entry.key,
        value: null,
        if_match: entry.value,
      })),
    );
  };

  const deleteKey = (namespace: string, key: string) => {
    const entry = entries.find(
      (e) => e.namespace === namespace && e.key === key,
    );
    if (entry === undefined) return;
    submit([
      {
        namespace,
        key,
        value: null,
        if_match: entry.value,
      },
    ]);
  };

  /** Switch to Bulk and place the cursor per `jump`, once the panel mounts. */
  const jumpToBulk = (jump: (view: EditorView) => void) => {
    write.reset();
    setConflictNotice([]);
    setTab("bulk");
    pendingJump.current = jump;
  };

  const onBulkTabMount = (view: EditorView | null) => {
    bulkView.current = view;
    if (view !== null && pendingJump.current !== null) {
      const jump = pendingJump.current;
      pendingJump.current = null;
      // The EditorView only exists once its panel has mounted, so the view
      // instance itself is the signal the panel is ready — driving the jump
      // here rather than a frame later keeps it working where animation
      // frames are throttled (background tabs, hidden windows).
      jump(view);
    }
  };

  const nsCount = groups.length;
  const keyCount = entries.length;

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
        aria-describedby={undefined}
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
        </DialogHeader>

        <div className="flex items-center justify-between">
          <Tabs
            value={tab}
            onValueChange={(value) => {
              write.reset();
              setConflictNotice([]);
              setTab(value as TabName);
            }}
            className="w-full"
          >
            <div className="flex items-center justify-between gap-2">
              <TabsList>
                <TabsTrigger value="browse">Browse</TabsTrigger>
                <TabsTrigger value="bulk">Bulk</TabsTrigger>
                <TabsTrigger value="json">JSON</TabsTrigger>
              </TabsList>
              <span
                className="text-xs text-muted-foreground"
                data-testid="metadata-counts"
              >
                {nsCount} {nsCount === 1 ? "namespace" : "namespaces"} ·{" "}
                {keyCount} {keyCount === 1 ? "key" : "keys"}
              </span>
            </div>

            {conflictNotice.length > 0 && (
              <div
                className="mt-2 space-y-2 rounded-md bg-muted p-2 text-sm"
                data-testid="metadata-conflict"
              >
                <p>Someone changed these while you were editing:</p>
                <ul className="space-y-0.5 font-mono text-xs">
                  {conflictNotice.map((line) => (
                    <li key={`${line.namespace}/${line.key}`}>
                      {line.namespace}/{line.key} {line.text}
                      {line.by !== null && ` (by ${line.by})`}
                    </li>
                  ))}
                </ul>
                {/* Never retried automatically: whether the edit still means
                    what it meant is the reader's call, and only they can
                    make it. */}
                <Button
                  size="sm"
                  variant="outline"
                  onClick={retryAgainstCurrent}
                >
                  Write over the new value
                </Button>
              </div>
            )}

            <TabsContent value="browse" className="mt-3">
              <MetadataBrowse
                groups={groups}
                canWrite={canWrite}
                onAddKey={(namespace) =>
                  jumpToBulk((view) => insertKeyInGroup(view, namespace))
                }
                onDeleteNamespace={deleteNamespace}
                onEditValue={(namespace, key) =>
                  jumpToBulk((view) => selectValueOf(view, namespace, key))
                }
                onDeleteKey={deleteKey}
                onAdd={() => jumpToBulk(appendNewEntry)}
              />
            </TabsContent>

            <TabsContent value="bulk" className="mt-3">
              <BulkPanel
                slug={slug}
                issueNumber={issueNumber}
                canWrite={canWrite}
                entries={entries}
                onJumpRef={onBulkTabMount}
                onConflicts={(lines) => {
                  setConflictNotice(lines);
                }}
                onSaved={() => {
                  setRefused(null);
                  setConflictNotice([]);
                }}
              />
            </TabsContent>

            <TabsContent value="json" className="mt-3">
              <JsonPanel
                slug={slug}
                issueNumber={issueNumber}
                canWrite={canWrite}
                entries={entries}
                onSaved={() => {
                  setRefused(null);
                  setConflictNotice([]);
                }}
              />
            </TabsContent>
          </Tabs>
        </div>

        {write.isError && conflicts.length === 0 && (
          <p className="text-sm text-destructive">
            {(write.error as Error).message}
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}

/**
 * The Bulk panel wires the shared editor tab to the bulk syntax, and hands
 * its EditorView up so Browse's jumps can drive the cursor. Parse failures
 * stay in the panel; only a 409 becomes a conflict notice, rendered from
 * the refused entries paired with what the server reported.
 */
function BulkPanel({
  slug,
  issueNumber,
  canWrite,
  entries,
  onJumpRef,
  onConflicts,
  onSaved,
}: {
  slug: string;
  issueNumber: number;
  canWrite: boolean;
  entries: IssueMetadataEntry[];
  onJumpRef: (view: EditorView | null) => void;
  onConflicts: (lines: ConflictLine[]) => void;
  onSaved: () => void;
}) {
  return (
    <MetadataEditorTab
      slug={slug}
      issueNumber={issueNumber}
      canWrite={canWrite}
      readOnly={!canWrite}
      language={metadataBulkSupport}
      serialize={serializeBulk}
      parse={parseBulk}
      helpText={BULK_HELP}
      placeholder="namespace/key = value"
      entries={entries}
      onSaved={onSaved}
      onParsed={onJumpRef}
      onWriteError={(error) => {
        const refusedEntries = error.refused ?? [];
        onConflicts(conflictLines(refusedEntries, error.conflicts, entries));
      }}
    />
  );
}

function JsonPanel({
  slug,
  issueNumber,
  canWrite,
  entries,
  onSaved,
}: {
  slug: string;
  issueNumber: number;
  canWrite: boolean;
  entries: IssueMetadataEntry[];
  onSaved: () => void;
}) {
  return (
    <MetadataEditorTab
      slug={slug}
      issueNumber={issueNumber}
      canWrite={canWrite}
      readOnly={!canWrite}
      language={metadataJsonSupport}
      serialize={serializeJsonDoc}
      parse={parseJsonDoc}
      helpText={JSON_HELP}
      placeholder={'{"namespace": {"key": "value"}}'}
      entries={entries}
      onSaved={onSaved}
    />
  );
}
