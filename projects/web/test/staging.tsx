import { QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import {
  type StagedFiles,
  StagedFileTray,
  StagedFileUploadButton,
  useStagedFiles,
} from "../src/components/issue/staged-files.tsx";
import { MarkdownEditor } from "../src/components/shared/markdown-editor.tsx";
import { cmDropFiles, cmGetValue, cmPasteFiles, cmView } from "./cm.ts";
import { testQueryClient } from "./render.tsx";

/** An editor wired to the hook the way every input box wires it. */
export function mountStaging(
  options: {
    initialValue?: string;
    autoFocus?: boolean;
    ownerManagedDirty?: boolean;
  } = {},
) {
  let latest: StagedFiles | null = null;
  function Harness() {
    const staging = useStagedFiles();
    latest = staging;
    return (
      <>
        <MarkdownEditor
          initialValue={options.initialValue}
          autoFocus={options.autoFocus}
          ownerManagedDirty={options.ownerManagedDirty}
          staging={staging.editor}
        />
        <StagedFileTray staged={staging.staged} onRemove={staging.remove} />
        <StagedFileUploadButton onFiles={staging.stage} />
      </>
    );
  }
  const view = render(
    <QueryClientProvider client={testQueryClient()}>
      <Harness />
    </QueryClientProvider>,
  );
  const root = view.container;
  return {
    root,
    hook: () => latest as StagedFiles,
    cm: () => cmView(root),
    text: () => cmGetValue(root),
    unmount: view.unmount,
  };
}

export type MountedStaging = ReturnType<typeof mountStaging>;

export function pasteFiles(mounted: MountedStaging, ...files: File[]): Event {
  return cmPasteFiles(mounted.root, files);
}

export function dropFiles(mounted: MountedStaging, ...files: File[]): Event {
  return cmDropFiles(mounted.root, files);
}
