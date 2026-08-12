import { MultiFileDiff } from "@pierre/diffs/react";
import { useSuspenseQuery } from "@tanstack/react-query";
import { Link, useParams, useSearch } from "@tanstack/react-router";
import type { SpecFile, SpecInfo } from "@todou/shared";
import { ArrowLeftIcon, FileTextIcon } from "lucide-react";
import { useMemo } from "react";
import { specFilesQuery, specQuery } from "@/api/spec.ts";
import { SpecStatusBadge } from "@/components/issue/spec-block.tsx";
import { MarkdownView } from "@/components/shared/markdown-view.tsx";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils.ts";

export type SpecViewSearch = {
  /** Selected file path; defaults to the first file of the version. */
  file?: string;
  /** Viewed version; defaults to the current one. */
  v?: number;
  /** When set, show the diff `compare → v` instead of the rendered file. */
  compare?: number;
};

export function parseSpecViewSearch(
  search: Record<string, unknown>,
): SpecViewSearch {
  const num = (v: unknown): number | undefined => {
    const n = Number(v);
    return Number.isInteger(n) && n > 0 ? n : undefined;
  };
  return {
    file: typeof search.file === "string" ? search.file : undefined,
    v: num(search.v),
    compare: num(search.compare),
  };
}

export function SpecViewPage() {
  const { slug, number: numberParam } = useParams({
    from: "/authed/projects/$slug/issues/$number/spec",
  });
  const issueNumber = Number(numberParam);
  const spec = useSuspenseQuery(specQuery(slug, issueNumber));

  if (spec.data === null) {
    return (
      <div className="mx-auto max-w-lg py-20 text-center text-muted-foreground">
        <p>This issue has no spec yet.</p>
        <Button asChild variant="link">
          <Link
            to="/projects/$slug/issues/$number"
            params={{ slug, number: numberParam }}
          >
            Back to #{numberParam}
          </Link>
        </Button>
      </div>
    );
  }
  return (
    <SpecViewBody slug={slug} issueNumber={issueNumber} spec={spec.data} />
  );
}

function SpecViewBody({
  slug,
  issueNumber,
  spec,
}: {
  slug: string;
  issueNumber: number;
  spec: SpecInfo;
}) {
  const search = useSearch({
    from: "/authed/projects/$slug/issues/$number/spec",
  });
  const version = search.v ?? spec.current_version;
  const compare = search.compare;
  const files = useSuspenseQuery(specFilesQuery(slug, issueNumber, version));
  const selectedPath = search.file ?? files.data.files[0]?.path;
  const selected = files.data.files.find((f) => f.path === selectedPath);
  const params = { slug, number: String(issueNumber) };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Button asChild size="sm" variant="ghost">
          <Link to="/projects/$slug/issues/$number" params={params}>
            <ArrowLeftIcon className="size-4" />#{issueNumber}
          </Link>
        </Button>
        <span className="font-semibold">Spec</span>
        <SpecStatusBadge status={spec.review_status} />
        <span className="mx-2 h-4 w-px bg-border" aria-hidden />
        {spec.versions.map((v) => (
          <Link
            key={v.number}
            to="/projects/$slug/issues/$number/spec"
            params={params}
            search={{ file: search.file, v: v.number }}
            title={v.message ?? undefined}
            className={cn(
              "rounded-full border px-2.5 py-0.5 font-mono text-xs",
              v.number === version && compare === undefined
                ? "border-foreground bg-foreground text-background"
                : "text-muted-foreground hover:border-foreground/50",
            )}
          >
            v{v.number}
          </Link>
        ))}
        {version > 1 && (
          <Link
            to="/projects/$slug/issues/$number/spec"
            params={params}
            search={{ file: search.file, v: version, compare: version - 1 }}
            className={cn(
              "rounded-full border px-2.5 py-0.5 text-xs",
              compare !== undefined
                ? "border-foreground bg-foreground text-background"
                : "text-muted-foreground hover:border-foreground/50",
            )}
          >
            diff v{version - 1}…v{version}
          </Link>
        )}
      </div>

      {compare !== undefined ? (
        <SpecDiff
          slug={slug}
          issueNumber={issueNumber}
          fromVersion={compare}
          toFiles={files.data.files}
          toVersion={version}
        />
      ) : (
        <div className="grid gap-6 lg:grid-cols-[220px_1fr]">
          <aside className="space-y-1">
            {files.data.files.map((file) => (
              <Link
                key={file.path}
                to="/projects/$slug/issues/$number/spec"
                params={params}
                search={{ file: file.path, v: search.v }}
                className={cn(
                  "flex items-center gap-2 rounded-md px-2 py-1.5 text-sm",
                  file.path === selectedPath
                    ? "bg-muted font-medium"
                    : "text-muted-foreground hover:bg-muted/50",
                )}
              >
                <FileTextIcon className="size-4 shrink-0" />
                <span className="truncate font-mono text-xs">{file.path}</span>
              </Link>
            ))}
          </aside>
          <main className="min-w-0 rounded-lg border px-5 py-4">
            {selected === undefined ? (
              <p className="text-sm text-muted-foreground italic">
                File not found in v{version}.
              </p>
            ) : (
              <MarkdownView slug={slug} issueNumber={issueNumber}>
                {selected.body}
              </MarkdownView>
            )}
          </main>
        </div>
      )}
    </div>
  );
}

// Module-scope per the library's props-stability guidance.
const DIFF_OPTIONS = {
  theme: { dark: "pierre-dark", light: "pierre-light" },
  diffStyle: "unified",
} as const;

/** All file pairs that differ between two versions, one diff per file. */
function SpecDiff({
  slug,
  issueNumber,
  fromVersion,
  toFiles,
  toVersion,
}: {
  slug: string;
  issueNumber: number;
  fromVersion: number;
  toFiles: SpecFile[];
  toVersion: number;
}) {
  const from = useSuspenseQuery(specFilesQuery(slug, issueNumber, fromVersion));
  const pairs = useMemo(() => {
    const before = new Map(from.data.files.map((f) => [f.path, f.body]));
    const after = new Map(toFiles.map((f) => [f.path, f.body]));
    const paths = [...new Set([...before.keys(), ...after.keys()])].sort();
    return paths
      .map((path) => ({
        path,
        oldFile: { name: path, contents: before.get(path) ?? "" },
        newFile: { name: path, contents: after.get(path) ?? "" },
      }))
      .filter((p) => p.oldFile.contents !== p.newFile.contents);
  }, [from.data.files, toFiles]);

  if (pairs.length === 0) {
    return (
      <p className="py-10 text-center text-sm text-muted-foreground">
        v{fromVersion} and v{toVersion} are identical.
      </p>
    );
  }
  return (
    <div className="space-y-4">
      {pairs.map((pair) => (
        <div key={pair.path} className="overflow-hidden rounded-lg border">
          <div className="border-b bg-muted/40 px-3 py-1.5 font-mono text-xs">
            {pair.path}
          </div>
          <MultiFileDiff
            oldFile={pair.oldFile}
            newFile={pair.newFile}
            options={DIFF_OPTIONS}
          />
        </div>
      ))}
    </div>
  );
}
