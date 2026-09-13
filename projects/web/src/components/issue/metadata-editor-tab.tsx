import type { Extension } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import type {
  IssueMetadataEntry,
  IssueMetadataWriteEntry,
} from "@todou/shared";
import { useRef, useState } from "react";
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
import { useDirtySource } from "@/lib/unsaved-guard.ts";

/**
 * One editable tab of the metadata dialog (Bulk or JSON). The panel is
 * generic — the tab supplies how to turn entries into text (`serialize`)
 * and text back into entries (`parse`), plus the editor's language —
 * because both tabs share the whole save pipeline: parse, precheck, diff
 * against the snapshot, write.
 *
 * The snapshot is the entries the text was rendered from, captured when the
 * panel mounts. A background refetch does not rewrite the editor once the
 * reader has typed anything — and the expectations a save sends are read
 * from the snapshot, not from whatever the server says now (S2).
 */
export function MetadataEditorTab({
  slug,
  issueNumber,
  canWrite,
  readOnly,
  language,
  serialize,
  parse,
  helpText,
  placeholder,
  onParsed,
  onSaved,
  onWriteError,
  entries,
}: {
  slug: string;
  issueNumber: number;
  canWrite: boolean;
  readOnly: boolean;
  language: Extension;
  serialize: (entries: IssueMetadataEntry[]) => string;
  parse: (
    text: string,
  ) =>
    | { ok: true; entries: Map<string, string> }
    | { ok: false; errors: ParseError[] };
  helpText: string;
  placeholder?: string;
  /** The mounted editor, once it exists; null after unmount. */
  onParsed?: (view: EditorView | null) => void;
  onSaved?: () => void;
  /** A 409 arrived: the shell renders the conflict notice from it. */
  onWriteError?: (error: {
    refused: IssueMetadataWriteEntry[];
    conflicts: MetadataConflict[];
  }) => void;
  entries: IssueMetadataEntry[];
}) {
  const [text, setText] = useState(() => serialize(entries));
  const dirty = useRef(false);
  const [errors, setErrors] = useState<ParseError[]>([]);
  const write = useWriteIssueMetadata();
  const handleRef = useRef<CodeEditorHandle | null>(null);

  // Captured once, at mount: the snapshot is "what was on screen when this
  // editor opened". A background refetch replaces the server's data but
  // must not move the expectations this editor will save with — that is
  // the whole point of capturing them (S2). Unmounting the tab (switching
  // away) is what legitimately resets it.
  const snapshot = useRef(
    new Map(entries.map((e) => [`${e.namespace}/${e.key}`, e.value])),
  );

  useDirtySource(() => dirty.current);

  const doSave = () => {
    const current = handleRef.current?.getValue() ?? text;
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
    const diff = diffMetadata(snapshot.current, parsed.entries);
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
    write.mutate(
      { slug, issueNumber, entries: diff } satisfies MetadataWriteVars,
      {
        onSuccess: () => {
          dirty.current = false;
          onSaved?.();
        },
        onError: (error) => {
          const failed = conflictsOf(error);
          if (failed !== null && onWriteError !== undefined) {
            onWriteError({
              refused: diff,
              conflicts: failed,
            });
          }
        },
      },
    );
  };

  return (
    <div className="space-y-2" data-testid="metadata-editor-tab">
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
      <CodeEditor
        ref={handleRef}
        initialValue={serialize(entries)}
        placeholder={placeholder}
        readOnly={readOnly}
        onView={onParsed}
        onChange={(value) => {
          dirty.current = true;
          setText(value);
        }}
        language={language}
        extensions={[]}
        className="min-h-40 max-h-[50vh]"
      />
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">{helpText}</p>
        {canWrite && (
          <Button size="sm" onClick={doSave} disabled={write.isPending}>
            Save
          </Button>
        )}
      </div>
    </div>
  );
}
