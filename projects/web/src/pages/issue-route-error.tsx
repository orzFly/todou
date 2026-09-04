import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { GoneError, MovedError } from "@todou/shared";
import { useEffect, useState } from "react";
import { api } from "@/api/queries.ts";
import { Button } from "@/components/ui/button.tsx";
import { parseTimelineAnchor } from "@/lib/timeline-anchors.ts";

/**
 * What the issue route shows when the card is not where the URL says.
 *
 * A move is a redirect the router has to perform itself: the address is
 * still a perfectly good link someone pasted, and landing on an error page
 * would make every one of those links dead the moment a card is tidied into
 * another project.
 */
export function IssueRouteError({ error }: { error: Error }) {
  if (error instanceof MovedError) return <FollowMove error={error} />;
  if (error instanceof GoneError) return <MovedAwayPage error={error} />;
  if ((error as { status?: number }).status !== 404) throw error;
  return (
    <Empty>
      <p className="text-muted-foreground">
        This issue does not exist, or you do not have access to it.
      </p>
    </Empty>
  );
}

function FollowMove({ error }: { error: MovedError }) {
  const navigate = useNavigate();
  const { slug: from } = useParams({ from: "/authed/projects/$slug" });
  const [hash, setHash] = useState<string | null>(null);
  const anchor =
    typeof window === "undefined" || window.location.hash === ""
      ? null
      : parseTimelineAnchor(window.location.hash);

  useEffect(() => {
    // A `#comment-N` in the URL names an id that only existed in the old
    // project, so the anchor has to be translated before the jump — landing
    // on the new card and scrolling nowhere is the failure this avoids.
    if (anchor?.kind !== "comment") {
      setHash(anchor === null ? "" : window.location.hash);
      return;
    }
    // Asked of the project the link came FROM: the id in the URL only ever
    // existed there, and its alias is what knows the new one.
    let cancelled = false;
    api
      .locateComment(from, anchor.id)
      .then((located) => {
        if (!cancelled) setHash(`#comment-${located.comment.id}`);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        const moved =
          cause instanceof MovedError ? cause.movedTo.comment_id : undefined;
        setHash(moved === undefined ? "" : `#comment-${moved}`);
      });
    return () => {
      cancelled = true;
    };
  }, [anchor, from]);

  useEffect(() => {
    if (hash === null) return;
    void navigate({
      to: "/projects/$slug/issues/$number",
      params: {
        slug: error.movedTo.slug,
        number: String(error.movedTo.number),
      },
      replace: true,
      ...(hash === "" ? {} : { hash: hash.replace(/^#/, "") }),
    });
  }, [hash, navigate, error.movedTo]);

  return (
    <Empty>
      <p className="text-muted-foreground">Taking you to the new address…</p>
    </Empty>
  );
}

/**
 * The same answer for the spec route, which is a sibling of the issue route
 * rather than a child — so `IssueRouteError` never sees its errors, and an
 * old spec deep link used to reach the router's generic crash screen.
 */
export function SpecRouteError({ error }: { error: Error }) {
  if (error instanceof MovedError) return <FollowMoveToSpec error={error} />;
  if (error instanceof GoneError) return <MovedAwayPage error={error} />;
  if ((error as { status?: number }).status !== 404) throw error;
  return (
    <Empty>
      <p className="text-muted-foreground">
        This spec does not exist, or you do not have access to it.
      </p>
    </Empty>
  );
}

/**
 * Nothing to translate on the way, unlike `FollowMove` above: everything the
 * spec page keeps in the URL lives in the search (`file`, `v`, `compare`,
 * `view`), and not one of those is scoped to a project — a move preserves
 * spec version numbers and leaves file paths alone — while the page never
 * reads `location.hash` at all. Hence no `useParams` and no `useSearch`
 * either: the destination is all in `error.movedTo`, and reading the search
 * through the route it belongs to would bind this component to the very
 * route whose error boundary it is sitting in.
 */
function FollowMoveToSpec({ error }: { error: MovedError }) {
  const navigate = useNavigate();

  useEffect(() => {
    void navigate({
      to: "/projects/$slug/issues/$number/spec",
      params: {
        slug: error.movedTo.slug,
        number: String(error.movedTo.number),
      },
      search: (prev) => prev,
      replace: true,
    });
  }, [navigate, error.movedTo]);

  return (
    <Empty>
      <p className="text-muted-foreground">Taking you to the new address…</p>
    </Empty>
  );
}

/** No link and no destination: the reader may not know where it went. */
function MovedAwayPage({ error }: { error: GoneError }) {
  return (
    <Empty>
      {error.body.title === undefined ? null : (
        <p className="font-medium">{error.body.title}</p>
      )}
      <p className="mt-1 text-muted-foreground">
        This issue moved to a project you do not have access to.
      </p>
    </Empty>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed p-10 text-center">
      {children}
      <Button asChild size="sm" variant="outline" className="mt-4">
        <Link to="/projects">All projects</Link>
      </Button>
    </div>
  );
}
