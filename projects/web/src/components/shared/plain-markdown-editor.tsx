import { cn } from "@orz/ui";
import { Textarea } from "@orz/ui/components/textarea";
import {
  forwardRef,
  type KeyboardEvent,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import type {
  MarkdownEditorHandle,
  MarkdownEditorProps,
  StagingSurface,
} from "@/components/shared/markdown-editor.tsx";
import { isApplePlatform } from "@/lib/platform.ts";
import { STAGED_TOKEN_TYPE } from "@/lib/staged-tokens.ts";
import { useDirtySource } from "@/lib/unsaved-guard.ts";

/**
 * `MarkdownEditor` for a browser that turned CodeMirror off (T-709): the
 * same handle, submit and cancel keys, and file staging, on a native
 * textarea. What exists only as CodeMirror extensions — completion, paste
 * conversion, token chips, line commands — is absent, which is the point:
 * the phone keyboard talks to an element it already knows.
 */
export const PlainMarkdownEditor = forwardRef<
  MarkdownEditorHandle,
  MarkdownEditorProps
>(function PlainMarkdownEditor(
  {
    initialValue = "",
    placeholder,
    ariaLabel,
    autoFocus = false,
    readOnly = false,
    ownerManagedDirty = false,
    onSubmit,
    onCancel,
    onChange,
    staging,
    className,
  },
  ref,
) {
  const area = useRef<HTMLTextAreaElement>(null);
  // Read once, like the CodeMirror editor: the textarea owns the document
  // from then on, so it is uncontrolled.
  const [baseline] = useState(initialValue);
  const userChanged = useRef(false);
  const handlers = useRef({
    onSubmit,
    onCancel,
    onChange,
    staging,
    ownerManagedDirty,
    readOnly,
  });
  handlers.current = {
    onSubmit,
    onCancel,
    onChange,
    staging,
    ownerManagedDirty,
    readOnly,
  };
  // Set while `change` writes, so the input events its execCommand calls
  // fire are reported once, after the last of them.
  const applying = useRef(false);
  const surfaceRef = useRef<StagingSurface | null>(null);

  useDirtySource(
    () =>
      !handlers.current.ownerManagedDirty &&
      !handlers.current.readOnly &&
      (area.current?.value ?? baseline).trim() !== baseline.trim(),
  );

  function changed(value: string) {
    handlers.current.staging?.sync(value);
    handlers.current.onChange?.(value);
  }

  /**
   * Through execCommand while the box has focus, so the browser's own undo
   * can take the change back; setRangeText otherwise, which it cannot.
   */
  function replace(
    el: HTMLTextAreaElement,
    from: number,
    to: number,
    insert: string,
  ) {
    if (from === to && insert === "") return;
    el.setSelectionRange(from, to);
    if (
      document.activeElement === el &&
      typeof document.execCommand === "function" &&
      document.execCommand(
        insert === "" ? "delete" : "insertText",
        false,
        insert,
      )
    ) {
      return;
    }
    el.setRangeText(insert, from, to, "end");
  }

  // Mount-only, like CodeMirrorMarkdownEditor's: staging is read when the box
  // first exists, and the surface reads the element live.
  // biome-ignore lint/correctness/useExhaustiveDependencies: mount-only by design.
  useEffect(() => {
    const el = area.current;
    if (el === null) return;
    const surface: StagingSurface = {
      dom: el,
      doc: () => el.value,
      selection: () => ({
        from: el.selectionStart,
        to: el.selectionEnd,
        head:
          el.selectionDirection === "backward"
            ? el.selectionStart
            : el.selectionEnd,
      }),
      // A textarea has no API for this; the caret stands in.
      posAtCoords: () => null,
      change: ({ changes, cursor }) => {
        applying.current = true;
        try {
          // Last first, so the earlier positions still hold.
          for (const c of [...changes].sort((a, b) => b.from - a.from)) {
            replace(el, c.from, c.to, c.insert ?? "");
          }
          if (cursor !== undefined) el.setSelectionRange(cursor, cursor);
        } finally {
          applying.current = false;
        }
        userChanged.current = true;
        changed(el.value);
      },
    };
    surfaceRef.current = surface;
    handlers.current.staging?.bind(surface);
    if (autoFocus) el.focus();
    return () => {
      surfaceRef.current = null;
      handlers.current.staging?.bind(null);
    };
  }, []);

  useImperativeHandle(ref, () => ({
    getValue: () => area.current?.value ?? "",
    setValue: (value: string) => {
      const el = area.current;
      if (el === null) return;
      el.value = value;
      changed(value);
    },
    append: (text: string) => {
      const el = area.current;
      if (el === null) return;
      const at = el.value.length;
      el.setRangeText(text, at, at, "end");
      el.scrollTop = el.scrollHeight;
      userChanged.current = true;
      changed(el.value);
    },
    focus: () => area.current?.focus(),
    userChanged: () => userChanged.current,
    // No completion panel to close.
    dismissCompletion: () => false,
  }));

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    // An IME's Enter confirms the composition; it is not a submit.
    if (event.nativeEvent.isComposing) return;
    const mod = isApplePlatform() ? event.metaKey : event.ctrlKey;
    if (event.key === "Enter" && mod) {
      // Swallowed whether or not anyone listens, as in the CodeMirror editor.
      event.preventDefault();
      handlers.current.onSubmit?.(event.currentTarget.value);
      return;
    }
    if (event.key === "Escape" && handlers.current.onCancel !== undefined) {
      event.preventDefault();
      handlers.current.onCancel();
    }
  }

  return (
    <Textarea
      ref={area}
      data-slot="markdown-editor"
      data-plain-text=""
      data-read-only={readOnly ? "true" : undefined}
      defaultValue={baseline}
      placeholder={placeholder}
      aria-label={ariaLabel}
      readOnly={readOnly}
      autoCapitalize="sentences"
      className={cn(
        "min-h-0 overflow-auto",
        readOnly && "opacity-50",
        className,
      )}
      onInput={(event) => {
        if (applying.current) return;
        userChanged.current = true;
        changed(event.currentTarget.value);
      }}
      onKeyDown={onKeyDown}
      onPaste={(event) => {
        const surface = surfaceRef.current;
        if (surface !== null) staging?.paste(event.nativeEvent, surface);
      }}
      onDrop={(event) => {
        const surface = surfaceRef.current;
        if (staging !== undefined) {
          if (surface !== null) staging.drop(event.nativeEvent, surface);
          return;
        }
        // A tray's token means nothing to an editor that stages no files.
        if (event.dataTransfer.types.includes(STAGED_TOKEN_TYPE)) {
          event.preventDefault();
        }
      }}
      onDragOver={(event) => staging?.dragOver(event.nativeEvent)}
    />
  );
});
