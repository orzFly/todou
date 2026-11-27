import { cn } from "@orz/ui";
import { InfoPopover } from "@orz/ui/components/info-popover";
import { useQuery } from "@tanstack/react-query";
import { versionQuery } from "@/api/queries.ts";
import { REPO_URL, WEB_VERSION } from "@/lib/version.ts";

/**
 * A mismatch is the normal, transient state of a half-finished deploy
 * (static assets updated but the server not yet restarted, or the reverse),
 * so it changes color only — no border, no icon, no toast — and says why
 * behind an (i), which a touch screen can open where a `title` never showed.
 * While the server version is unknown (old server, request in flight,
 * offline) the footer shows just the web version rather than alarming anyone.
 */
export function VersionFooter() {
  const server = useQuery(versionQuery);
  const serverVersion = server.data?.version;
  const mismatch = serverVersion !== undefined && serverVersion !== WEB_VERSION;
  return (
    <footer className="mx-auto flex max-w-6xl items-center justify-center gap-1 px-4 pb-6 text-xs">
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
      {mismatch && (
        <InfoPopover label="About the version mismatch">
          web and server versions differ — normal while a deploy is in progress;
          they converge once both sides are restarted
        </InfoPopover>
      )}
    </footer>
  );
}
