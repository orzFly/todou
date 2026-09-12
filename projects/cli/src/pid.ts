/**
 * Signal 0 checks for a process without touching it. EPERM counts as alive:
 * the pid is in use by somebody, which is all this asks.
 *
 * Two callers ask it about files named after a pid, and they pay for a wrong
 * answer in opposite directions. A pid recycled by an unrelated process reads
 * as alive and costs a leftover file, which the next run in that directory
 * collects. A wrong "dead" unlinks the socket of a watch that is still
 * listening, and that watch loses every receipt it had coming — so the two
 * clauses that make the check conservative, `EPERM` and the recycled pid, are
 * what keep the expensive mistake off the table.
 */
export function alive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
