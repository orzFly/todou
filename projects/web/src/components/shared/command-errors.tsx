/**
 * The block a composer shows above its editor when a recognized command line
 * names something that does not exist. Shared by the comment composer and the
 * new-issue page (T-307), which offer overlapping command sets and must
 * explain a broken one the same way.
 */
export function CommandErrors({
  broken,
}: {
  broken: { line: string; reason: string }[];
}) {
  return (
    <>
      {broken.map((entry) => (
        <p
          key={entry.line}
          role="alert"
          className="rounded-md border border-destructive/40 px-3 py-1.5 text-sm text-destructive"
        >
          <span className="font-mono">{entry.line}</span> — {entry.reason}
        </p>
      ))}
    </>
  );
}
