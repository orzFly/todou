import type { Extension } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import type { IssueMetadataWriteEntry } from "@todou/shared";
import { type RefObject, useState } from "react";
import {
  conflictsOf,
  type MetadataConflict,
  type MetadataWriteVars,
  useWriteIssueMetadata,
} from "@/api/metadata.ts";
import {
  CodeEditor,
  type CodeEditorHandle,
} from "@/components/shared/code-editor.tsx";
import { Button } from "@/components/ui/button";
import {
  diffMetadata,
  METADATA_ENTRIES_PER_WRITE,
  type ParseError,
  precheck,
} from "@/lib/metadata-diff.ts";

/** What a 409 hands up to the shell: the refused write and the server's report. */
export type WriteConflict = {
  refused: IssueMetadataWriteEntry[];
  conflicts: MetadataConflict[];
};

/**
 * One editable tab of the metadata dialog (Bulk or JSON). The panel is
 * generic — the tab supplies how to turn text back into entries (`parse`)
 * and the editor's language — because both tabs share the whole save
 * pipeline: parse, precheck, diff against the snapshot, write.
 *
 * The draft and the snapshot no longer live here: the shell owns the edit
 * session (one document, two spellings) and hands down the text to open
 * with plus the snapshot the saves must be issued against. The panel only
 * holds the text between keystrokes, via the editor handle the shell gave
 * back.
 *
 * Errors split in two: a 409 goes to `onConflict` so the shell can pair the
 * refused entries with the server's report and offer the retry; everything
 * else (network, 500) renders right here, next to the Save the reader
 * pressed.
 */
export function MetadataEditorTab({
  slug,
  issueNumber,
  canWrite,
  readOnly,
  language,
  parse,
  helpText,
  placeholder,
  initialText,
  snapshot,
  editorRef,
  gate,
  onDirty,
  onDiscard,
  onView,
  onSaved,
  onConflict,
}: {
  slug: string;
  issueNumber: number;
  canWrite: boolean;
  readOnly: boolean;
  language: Extension;
  parse: (
    text: string,
  ) =>
    | { ok: true; entries: Map<string, string> }
    | { ok: false; errors: ParseError[] };
  helpText: string;
  placeholder?: string;
  /** The document as rendered for this tab — read once, at mount. */
  initialText: string;
  /** The session snapshot saves are issued against; owned by the shell. */
  snapshot: Map<string, string>;
  /** The shell reads the current text through this handle (gate, guard). */
  editorRef: RefObject<CodeEditorHandle | null>;
  /** The tab-switch gate's rejection, rendered above the panel's own errors. */
  gate: { message: string; errors: ParseError[] } | null;
  /** A keystroke landed; the shell clears a stale gate rejection. */
  onDirty: () => void;
  /** Drop the draft and reopen the session from the server's current values. */
  onDiscard: () => void;
  /** The mounted EditorView, once it exists; null after unmount. */
  onView?: (view: EditorView | null) => void;
  onSaved?: (written: IssueMetadataWriteEntry[]) => void;
  /** A 409 arrived: the shell renders the conflict notice from it. */
  onConflict?: (payload: WriteConflict) => void;
}) {
  const [errors, setErrors] = useState<ParseError[]>([]);
  const [saveError, setSaveError] = useState<string | null>(null);
  const write = useWriteIssueMetadata();

  const doSave = () => {
    const current = editorRef.current?.getValue() ?? initialText;
    const parsed = parse(current);
    if (!parsed.ok) {
      setErrors(parsed.errors);
      return;
    }
    const limitErrors = precheck(parsed.entries);
    if (limitErrors.length > 0) {
      setErrors(limitErrors);
      return;
    }
    const diff = diffMetadata(snapshot, parsed.entries);
    if (diff.length > METADATA_ENTRIES_PER_WRITE) {
      setErrors([
        {
          line: 0,
          message: `this would write ${diff.length} entries — one write carries at most ${METADATA_ENTRIES_PER_WRITE}`,
        },
      ]);
      return;
    }
    setErrors([]);
    setSaveError(null);
    write.mutate(
      { slug, issueNumber, entries: diff } satisfies MetadataWriteVars,
      {
        onSuccess: () => {
          onSaved?.(diff);
        },
        onError: (error) => {
          // A 409 is fully explained by the shell's conflict notice, and
          // the retry is the shell's to run — reporting it here too would
          // duplicate the message and survive the retry, since the retry
          // goes through the shell's mutation, which cannot clear this
          // panel's error. Everything else (network, 500) shows here,
          // next to the Save the reader pressed.
          const conflicts = conflictsOf(error);
          if (conflicts !== null && onConflict !== undefined) {
            onConflict({ refused: diff, conflicts });
            return;
          }
          setSaveError((error as Error).message);
        },
      },
    );
  };

  return (
    <div className="space-y-2" data-testid="metadata-editor-tab">
      {gate !== null && (
        <div className="space-y-0.5 rounded-md bg-destructive/10 p-2 text-xs text-destructive">
          <p>{gate.message}</p>
          {gate.errors.map((error) => (
            <p key={`${error.line}:${error.message}`}>
              {error.line > 0 ? `line ${error.line}: ` : ""}
              {error.message}
            </p>
          ))}
        </div>
      )}
      {errors.length > 0 && (
        <div className="space-y-0.5 rounded-md bg-destructive/10 p-2 text-xs text-destructive">
          {errors.map((error) => (
            <p key={`${error.line}:${error.message}`}>
              {error.line > 0 ? `line ${error.line}: ` : ""}
              {error.message}
            </p>
          ))}
        </div>
      )}
      {saveError !== null && write.isError && (
        <p className="text-sm text-destructive">{saveError}</p>
      )}
      <CodeEditor
        ref={editorRef}
        initialValue={initialText}
        placeholder={placeholder}
        readOnly={readOnly}
        onView={onView}
        onChange={() => {
          onDirty();
        }}
        language={language}
        extensions={EMPTY_EXTENSIONS}
        className="min-h-40 max-h-[50vh]"
      />
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">{helpText}</p>
        {canWrite && (
          <span className="flex gap-2">
            <Button size="sm" variant="outline" onClick={onDiscard}>
              Discard
            </Button>
            <Button size="sm" onClick={doSave} disabled={write.isPending}>
              Save
            </Button>
          </span>
        )}
      </div>
    </div>
  );
}

/** Stable identity, so CodeEditor's extensions effect does not churn per render. */
const EMPTY_EXTENSIONS: Extension[] = [];
