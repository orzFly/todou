import type { EditorView } from "@codemirror/view";
import { useQuery } from "@tanstack/react-query";
import type { IssueMetadataWriteEntry } from "@todou/shared";
import { type ComponentProps, useRef, useState } from "react";
import { toast } from "sonner";
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
import type { CodeEditorHandle } from "@/components/shared/code-editor.tsx";
import { LoadFailure } from "@/components/shared/load-failure.tsx";
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
import {
  applyWrite,
  type ConflictLine,
  conflictLines,
  diffMetadata,
  docRows,
  type ParseError,
  readDocument,
} from "@/lib/metadata-diff.ts";
import { parseJsonDoc, serializeJsonDoc } from "@/lib/metadata-json.ts";
import { useDirtySource } from "@/lib/unsaved-guard.ts";

type TabName = "browse" | "bulk" | "json";

type EditSession = {
  /** The server's shape when the session opened; every if_match reads from here. */
  snapshot: Map<string, string>;
  /** The draft carried across tab switches; panels render their text from it. */
  doc: Map<string, string>;
  /**
   * Provenance for the whole session, not one panel: once the reader has
   * changed the document anywhere in the session, the gate may hold their
   * unparseable text and Browse may refuse the draft. Lives here because
   * panels remount on every switch — a per-panel flag would forget an
   * edit the moment the draft moved to the other tab.
   */
  edited: boolean;
};

/**
 * The session-bearing props both panel wrappers forward; the wrappers pin
 * only the tab's syntax.
 */
type PanelProps = ComponentProps<typeof MetadataEditorTab>;

const PARSERS = { bulk: parseBulk, json: parseJsonDoc } as const;

const BULK_HELP =
  "One ns/key = value per line · # comments · heredoc <<MARK for multiline";
const JSON_HELP = "Formatted JSON: one object per namespace, string values.";

/**
 * The whole metadata surface for one card: Browse to read, Bulk and JSON to
 * edit. The three panels are radix Tabs — the non-active panel is not
 * mounted. What changed from "a switch drops the draft": the edit session
 * (snapshot + one parsed document) lives here in the shell, so Bulk and
 * JSON are two spellings of one draft, and a switch re-renders the document
 * in the target tab's syntax instead of destroying it.
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
  restoreFocusTo?: () => HTMLElement | null;
}) {
  const metadata = useQuery(issueMetadataQuery(slug, issueNumber));
  const canWrite = useCan(slug, "metadata.write");
  const write = useWriteIssueMetadata();
  const entries = metadata.data?.entries ?? [];
  const groups = groupMetadata(entries);
  const [tab, setTab] = useState<TabName>("browse");
  /** One draft, two spellings: open on leaving Browse, closed on returning. */
  const [session, setSession] = useState<EditSession | null>(null);
  /** Bumped on Discard so the panel remounts and re-reads its initial text. */
  const [sessionSeq, setSessionSeq] = useState(0);
  /** The write a 409 refused, kept so it can be re-sent against what is there now. */
  const [refused, setRefused] = useState<IssueMetadataWriteEntry[] | null>(
    null,
  );
  const [conflictNotice, setConflictNotice] = useState<ConflictLine[]>([]);
  /** The tab-switch gate's rejection; cleared by an edit, a switch, or a save. */
  const [gate, setGate] = useState<{
    message: string;
    errors: ParseError[];
  } | null>(null);
  const bulkView = useRef<EditorView | null>(null);
  const pendingJump = useRef<((view: EditorView) => void) | null>(null);
  const editorRef = useRef<CodeEditorHandle | null>(null);
  // useDirtySource's effect deps are empty — its closure froze at the first
  // render — so the session and the active tab are read through refs kept
  // in step on every render.
  const sessionRef = useRef(session);
  sessionRef.current = session;
  const tabRef = useRef(tab);
  tabRef.current = tab;

  // The guard must follow the session, not the panel: once the draft rides
  // a tab switch, the target editor's own baseline IS the draft, and a
  // panel-local check would call that unsaved work clean.
  useDirtySource(() => {
    const s = sessionRef.current;
    const t = tabRef.current;
    if (s === null || t === "browse") return false;
    // Same provenance judge as the gate: editor-internal rewrites (mount
    // normalization) are not unsaved work, so the flag rides the session
    // and ORs in the current panel's userChanged().
    const edited = s.edited || (editorRef.current?.userChanged() ?? false);
    if (!edited) return false;
    const read = readDocument(editorRef.current?.getValue() ?? "", PARSERS[t]);
    return !read.ok || diffMetadata(s.snapshot, read.doc).length > 0;
  });

  const conflicts = conflictsOf(write.error) ?? [];

  const reset = () => {
    setRefused(null);
    setConflictNotice([]);
    setGate(null);
    setSession(null);
    setTab("browse");
    write.reset();
  };

  /**
   * Every successful write lands here — panel saves, Browse deletes, the
   * 409 retry. Folding the written entries back into the session snapshot
   * is what lets the next save expect the values this one just put there;
   * with no session (Browse deletes) there is nothing to fold into.
   */
  const onWriteSucceeded = (written: IssueMetadataWriteEntry[]) => {
    setSession((s) =>
      s === null ? s : { ...s, snapshot: applyWrite(s.snapshot, written) },
    );
    setRefused(null);
    setConflictNotice([]);
    setGate(null);
    toast.success(
      `Saved ${written.length} ${written.length === 1 ? "entry" : "entries"}`,
    );
  };

  const submit = (writeEntries: IssueMetadataWriteEntry[]) => {
    setRefused(writeEntries);
    write.mutate(
      { slug, issueNumber, entries: writeEntries } satisfies MetadataWriteVars,
      {
        onSuccess: () => {
          onWriteSucceeded(writeEntries);
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
    // The 409's report of "what is there now" travels on the notice lines,
    // whatever panel the refused write came from — the dialog's own
    // mutation only knows about Browse-path writes.
    const now = new Map(
      conflictNotice.map((line) => [
        `${line.namespace}/${line.key}`,
        line.current,
      ]),
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

  /**
   * A keystroke after a gate rejection means the reader is acting on it;
   * the ref keeps this from re-rendering on every keystroke when no gate
   * stands.
   */
  const gateRef = useRef(gate);
  gateRef.current = gate;
  const clearGate = () => {
    if (gateRef.current !== null) setGate(null);
  };
  /**
   * The tab-switch gate. The gate holds a reader who changed the text into
   * something that cannot parse, and holds a dirty document away from
   * Browse; a document the reader never touched is always allowed to
   * leave — refusing to render it is not worth trapping someone in a tab
   * they cannot leave.
   *
   * "Changed" is provenance, not byte-equality against what the shell
   * rendered: CodeMirror rewrites its own text (line-ending normalization
   * at mount) and each tab spells the document differently, so a
   * screen-vs-rendered comparison flags work the reader never did. The
   * judge lives on the session: at every gate evaluation the current
   * panel's userChanged() is OR-ed in, so an edit stays remembered across
   * any number of switches — a per-panel flag would forget the draft the
   * moment it moved tabs.
   */
  const onValueChange = (value: string) => {
    const next = value as TabName;
    if (session !== null && tab !== "browse") {
      const read = readDocument(
        editorRef.current?.getValue() ?? "",
        PARSERS[tab],
      );
      const edited =
        session.edited || (editorRef.current?.userChanged() ?? false);
      if (!read.ok && edited) {
        // The reader changed the text into a state that cannot parse: hold
        // them here with the reasons. Unedited unparseable text — e.g. a
        // server-stored value that renders as an unterminated heredoc —
        // gets no such gate: the escape below keeps the switch alive,
        // exactly as a pre-gate switch behaved.
        setGate({
          message: "Cannot switch tabs while the document has errors.",
          errors: read.errors,
        });
        return;
      }
      if (read.ok) {
        if (next === "browse") {
          // The Browse lock is also conditional on provenance: a document
          // the reader never edited cannot hold unsaved work, even when an
          // editor-internal rewrite (CRLF normalization) makes the parsed
          // doc differ from the literal snapshot — without this, Discard
          // could not rescue it either.
          if (edited && diffMetadata(session.snapshot, read.doc).length > 0) {
            setGate({
              message:
                "Browse cannot show unsaved edits — save or discard them first.",
              errors: [],
            });
            return;
          }
          setSession(null);
        } else {
          setSession({ ...session, doc: read.doc, edited });
        }
      } else if (!edited) {
        // Unparseable but untouched: the switch is a re-render escape. The
        // draft is the snapshot — there is nothing else to carry — and the
        // session stays open in case the reader comes back to edit.
        setSession({ ...session, doc: session.snapshot });
      }
    } else if (next !== "browse") {
      const base = new Map(
        entries.map((e) => [`${e.namespace}/${e.key}`, e.value]),
      );
      setSession({ snapshot: base, doc: base, edited: false });
    }
    setGate(null);
    write.reset();
    setConflictNotice([]);
    setTab(next);
  };

  /** Drop the draft and reopen the session from what the server has now. */
  const onDiscard = () => {
    const base = new Map(
      entries.map((e) => [`${e.namespace}/${e.key}`, e.value]),
    );
    setSession({ snapshot: base, doc: base, edited: false });
    setSessionSeq((n) => n + 1);
    setGate(null);
    setRefused(null);
    setConflictNotice([]);
  };

  const openSessionAtBulk = () => {
    const base = new Map(
      entries.map((e) => [`${e.namespace}/${e.key}`, e.value]),
    );
    setSession({ snapshot: base, doc: base, edited: false });
  };

  const jumpToBulk = (jump: (view: EditorView) => void) => {
    write.reset();
    setConflictNotice([]);
    openSessionAtBulk();
    setTab("bulk");
    pendingJump.current = jump;
    // A view may already be live (the tab was open before this click);
    // the deferred flush below runs the jump against whatever view
    // survives this render.
    schedulePendingJumpFlush();
  };

  /**
   * Run the pending jump against the view that is mounted *after* React
   * has finished mounting and discarding views (StrictMode double-mount,
   * Suspense fallbacks, fast refresh). Two invariants make this safe:
   *
   * - `bulkView.current` is always the newest view — `onView(null)` on a
   *   destroyed instance clears it, and every mount overwrites it.
   * - an animation frame fires only after React's synchronous effect
   *   phase, so by flush time the surviving view owns `bulkView.current`.
   *
   * The jump runs against `bulkView.current`, never against the instance
   * a particular mount happened to hold, so a discarded view cannot take
   * the jump with it.
   */
  const flushPendingJump = () => {
    const view = bulkView.current;
    const jump = pendingJump.current;
    if (view === null || jump === null) return;
    pendingJump.current = null;
    jump(view);
  };

  const schedulePendingJumpFlush = () => {
    requestAnimationFrame(flushPendingJump);
  };

  const onBulkView = (view: EditorView | null) => {
    bulkView.current = view;
    if (view !== null && pendingJump.current !== null) {
      schedulePendingJumpFlush();
    }
  };

  const nsCount = groups.length;
  const keyCount = entries.length;
  // A failed read establishes nothing: the counts are numbers the query
  // never produced, and the empty-card sentence is a claim it never made.
  // Same query as the sidebar, so one Retry turns both faces back over.
  const failed = metadata.isError && entries.length === 0;
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
          const trigger = restoreFocusTo?.() ?? null;
          // Null once the surface that opened this is itself gone. Radix then
          // preventDefaults and focuses a DialogTrigger these plain buttons
          // never had, leaving focus on body — with nothing left on screen to
          // hand it to, there is no landing to prefer over that (T-430).
          if (trigger === null) return;
          // Radix takes the focus back after this handler runs, so handing it
          // over synchronously here would be overwritten; a frame later the
          // dialog is gone and the trigger keeps it.
          event.preventDefault();
          // Bare focus can scroll the trigger into view via html scroll-padding (T-388).
          requestAnimationFrame(() => trigger.focus({ preventScroll: true }));
        }}
      >
        <DialogHeader>
          <DialogTitle>Metadata</DialogTitle>
        </DialogHeader>

        <div className="flex items-center justify-between">
          <Tabs value={tab} onValueChange={onValueChange} className="w-full">
            <div className="flex items-center justify-between gap-2">
              <TabsList>
                <TabsTrigger value="browse">Browse</TabsTrigger>
                <TabsTrigger value="bulk">Bulk</TabsTrigger>
                <TabsTrigger value="json">JSON</TabsTrigger>
              </TabsList>
              {failed ? null : (
                <span
                  className="text-xs text-muted-foreground"
                  data-testid="metadata-counts"
                >
                  {nsCount} {nsCount === 1 ? "namespace" : "namespaces"} ·{" "}
                  {keyCount} {keyCount === 1 ? "key" : "keys"}
                </span>
              )}
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
                failure={
                  failed ? (
                    <LoadFailure
                      message="Failed to load metadata."
                      detail={metadata.error.message}
                      onRetry={() => metadata.refetch()}
                      retrying={metadata.isFetching}
                    />
                  ) : undefined
                }
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

            {session !== null && (
              <>
                <TabsContent value="bulk" className="mt-3">
                  <BulkPanel
                    slug={slug}
                    issueNumber={issueNumber}
                    canWrite={canWrite}
                    key={`bulk-${sessionSeq}`}
                    initialText={serializeBulk(docRows(session.doc))}
                    snapshot={session.snapshot}
                    editorRef={editorRef}
                    gate={gate}
                    onDirty={clearGate}
                    onDiscard={onDiscard}
                    onView={onBulkView}
                    onConflict={(payload) => {
                      setRefused(payload.refused);
                      setConflictNotice(
                        conflictLines(
                          payload.refused,
                          payload.conflicts,
                          entries,
                        ),
                      );
                    }}
                    onSaved={onWriteSucceeded}
                  />
                </TabsContent>

                <TabsContent value="json" className="mt-3">
                  <JsonPanel
                    slug={slug}
                    issueNumber={issueNumber}
                    canWrite={canWrite}
                    key={`json-${sessionSeq}`}
                    initialText={serializeJsonDoc(docRows(session.doc))}
                    snapshot={session.snapshot}
                    editorRef={editorRef}
                    onDirty={clearGate}
                    gate={gate}
                    onDiscard={onDiscard}
                    onConflict={(payload) => {
                      setRefused(payload.refused);
                      setConflictNotice(
                        conflictLines(
                          payload.refused,
                          payload.conflicts,
                          entries,
                        ),
                      );
                    }}
                    onSaved={onWriteSucceeded}
                  />
                </TabsContent>
              </>
            )}
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

/** The wrappers pin the tab's syntax and derive readOnly from canWrite. */

function BulkPanel(
  props: Omit<
    PanelProps,
    "language" | "parse" | "helpText" | "placeholder" | "readOnly"
  >,
) {
  return (
    <MetadataEditorTab
      {...props}
      readOnly={!props.canWrite}
      language={metadataBulkSupport}
      parse={parseBulk}
      helpText={BULK_HELP}
      placeholder="namespace/key = value"
    />
  );
}

function JsonPanel(
  props: Omit<
    PanelProps,
    "language" | "parse" | "helpText" | "placeholder" | "readOnly"
  >,
) {
  return (
    <MetadataEditorTab
      {...props}
      readOnly={!props.canWrite}
      language={metadataJsonSupport}
      parse={parseJsonDoc}
      helpText={JSON_HELP}
      placeholder={'{"namespace": {"key": "value"}}'}
    />
  );
}
