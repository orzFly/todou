import { cn } from "@orz/ui";
import { useQuery } from "@tanstack/react-query";
import { versionQuery } from "@/api/queries.ts";
import { REPO_URL, WEB_VERSION } from "@/lib/version.ts";

/**
 * A mismatch is the normal, transient state of a half-finished deploy
 * (static assets updated but the server not yet restarted, or the reverse),
 * so it changes color only — no border, no icon, no toast. While the server
 * version is unknown (old server, request in flight, offline) the footer
 * shows just the web version rather than alarming anyone.
 *
 * No explanation beside or behind it — no (i), no `title`: the user turned
 * both down (T-809). AGENTS.md, "Interface text says what the screen cannot".
 */
export function VersionFooter() {
  const server = useQuery(versionQuery);
  const serverVersion = server.data?.version;
  const mismatch = serverVersion !== undefined && serverVersion !== WEB_VERSION;
  return (
    <footer className="mx-auto max-w-6xl px-4 pb-6 text-center text-xs">
      <a
        href={REPO_URL}
        target="_blank"
        rel="noreferrer"
        className={cn(
          "hover:underline",
          mismatch ? "text-warning" : "text-muted-foreground",
        )}
      >
        {mismatch
          ? `todou web ${WEB_VERSION} · server ${serverVersion}`
          : `todou ${WEB_VERSION}`}
      </a>
    </footer>
  );
}
