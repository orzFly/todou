import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  createRootRoute,
  createRoute,
  createRouter,
  Link,
  lazyRouteComponent,
  Navigate,
  Outlet,
  useNavigate,
} from "@tanstack/react-router";
import type { Me } from "@todou/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { issueSearchSchema, newIssueSearchSchema } from "@/api/issues.ts";
import { meQuery, runtime } from "@/api/queries.ts";
import { getRuntimeQueryAdapter } from "@/api/runtime/query-adapter.ts";
import { searchPageSchema } from "@/api/search.ts";
import { userSearchParams, userSearchSchema } from "@/api/users.ts";
import { ConnectionBanner } from "@/components/connection-banner.tsx";
import {
  PagePending,
  type PageSkeletonKind,
} from "@/components/page-skeleton.tsx";
import { LoadFailure } from "@/components/shared/load-failure.tsx";
import type { BackControlKind } from "@/components/shared/return-link.tsx";
import { AppShell } from "@/components/shell.tsx";
import { TitleController } from "@/components/title-controller.tsx";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Toaster } from "@/components/ui/sonner";
import { activityDateSearchMiddleware } from "@/lib/activity-calendar-search.ts";
import { statusOf } from "@/lib/http-status.ts";
import { parseInsightsSearch } from "@/lib/insights-search.ts";
import { INBOX_TABS, type InboxTab } from "@/lib/return-view.ts";
import { parseSpecSearch } from "@/lib/spec-search.ts";
import { hasUnsavedWork } from "@/lib/unsaved-guard.ts";
import { AgentsSettingsPage } from "@/pages/agents-settings.tsx";
import { BoardPage } from "@/pages/board.tsx";
import { CliAuthPage } from "@/pages/cli-auth.tsx";
import { GrantAccessPage } from "@/pages/grant-access.tsx";
import { InboxPage } from "@/pages/inbox.tsx";
import { IssueDetailPage } from "@/pages/issue-detail.tsx";
import { IssueListPage } from "@/pages/issue-list.tsx";
import { IssueRouteError, SpecRouteError } from "@/pages/issue-route-error.tsx";
import { LoginPage } from "@/pages/login.tsx";
import { MutedPage } from "@/pages/muted.tsx";
import { NewIssuePage } from "@/pages/new-issue.tsx";
import { ProfileSettingsPage } from "@/pages/profile-settings.tsx";
import { ProjectLayout, ProjectRouteError } from "@/pages/project-layout.tsx";
import { ProjectSettingsPage } from "@/pages/project-settings.tsx";
import { ProjectsPage } from "@/pages/projects.tsx";
import { SearchPage } from "@/pages/search.tsx";
import { TokensSettingsPage } from "@/pages/tokens-settings.tsx";
import { UserProfilePage } from "@/pages/user-profile.tsx";

const rootRoute = createRootRoute({
  component: () => (
    <>
      <TitleController />
      <Outlet />
      <Toaster position="bottom-right" />
    </>
  ),
});

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/login",
  component: LoginPage,
  validateSearch: (search): { redirect?: string; error?: string } => ({
    ...(typeof search.redirect === "string"
      ? { redirect: search.redirect }
      : {}),
    // The oidc callback reports its failures as /login?error=<code>.
    ...(typeof search.error === "string" ? { error: search.error } : {}),
  }),
});

/** Everything below requires a session; 401 bounces to /login. */
const authedRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: "authed",
  component: AuthedLayout,
});

interface SessionReset {
  generation: number;
  account?: Me;
  hadUnsavedWork: boolean;
  phase: "checking" | "failed" | "lost";
  error?: Error;
}

function AuthedLayout() {
  const queryClient = useQueryClient();
  const [sessionReset, setSessionReset] = useState<SessionReset | null>(null);
  // The 15s retry interval is what retires the warm-state banner without
  // user action: meQuery only refetches on window focus otherwise, so the
  // banner would outlive the outage by minutes. 401 is excluded — a dead
  // session stays dead, and retrying it only multiplies the 401s.
  const me = useQuery({
    ...meQuery,
    enabled: sessionReset === null,
    refetchInterval: (query) =>
      query.state.status === "error" && statusOf(query.state.error) !== 401
        ? 15_000
        : false,
  });

  const resetRef = useRef<SessionReset | null>(null);
  const resetGeneration = useRef(0);
  const accountRef = useRef(me.data);
  if (sessionReset === null) accountRef.current = me.data;

  const dropPrivateQueries = useCallback(
    () =>
      queryClient.removeQueries({
        predicate: (query) =>
          !["me", "auth-mode", "server-version"].includes(
            String(query.queryKey[0]),
          ),
      }),
    [queryClient],
  );

  const verifySession = useCallback(
    async (reset: SessionReset) => {
      // Cancel the page's old waiter before starting a new online identity
      // check. The bridge independently fences late results from its epoch.
      await queryClient.cancelQueries({ queryKey: meQuery.queryKey });
      if (reset.generation !== resetGeneration.current) return;
      try {
        // Verify outside the QueryClient: a different account must never be
        // published into the old editor's ['me'] query before it can leave.
        const verified = await runtime.bootstrap();
        if (reset.generation !== resetGeneration.current) return;
        const changedAccount =
          reset.account !== undefined && reset.account.id !== verified.id;
        if (changedAccount && reset.hadUnsavedWork) {
          // Keep the old editor and account together. The new identity cannot
          // resume mirrors until the user actually leaves this draft.
          const lost = { ...reset, phase: "lost" as const };
          resetRef.current = lost;
          setSessionReset(lost);
          return;
        }
        if (changedAccount) dropPrivateQueries();
        queryClient.setQueryData(meQuery.queryKey, verified);
        await getRuntimeQueryAdapter(queryClient)?.resumeSession();
        if (reset.generation !== resetGeneration.current) return;
        accountRef.current = verified;
        resetRef.current = null;
        setSessionReset(null);
      } catch (error) {
        if (reset.generation !== resetGeneration.current) return;
        const failure =
          error instanceof Error ? error : new Error(String(error));
        const failed: SessionReset = {
          ...reset,
          phase: statusOf(failure) === 401 ? "lost" : "failed",
          error: failure,
        };
        resetRef.current = failed;
        setSessionReset(failed);
      }
    },
    [queryClient, dropPrivateQueries],
  );

  useEffect(() => {
    const unsubscribe = runtime.onSessionReset((reason) => {
      const previous = resetRef.current;
      const reset: SessionReset = {
        generation: ++resetGeneration.current,
        account: previous?.account ?? accountRef.current,
        hadUnsavedWork: previous?.hadUnsavedWork ?? hasUnsavedWork(),
        phase: "checking",
      };
      resetRef.current = reset;
      setSessionReset(reset);
      // BEGIN must revoke immediately, but verifying while this page holds
      // the auth lock could wait on its own transition. END/FAILED emits
      // auth-settled and starts the required online check.
      if (reason !== "auth-transition") void verifySession(reset);
    });
    return () => {
      unsubscribe();
      resetGeneration.current++;
      if (resetRef.current !== null) {
        // A cancelled leave never unmounts this gate. Only the committed
        // navigation can retire the old private cache. The next verified
        // account, after login, can release the mirror pause.
        dropPrivateQueries();
        queryClient.removeQueries({ queryKey: meQuery.queryKey });
      }
    };
  }, [queryClient, verifySession, dropPrivateQueries]);

  useEffect(() => {
    if (sessionReset === null && me.isSuccess) {
      void getRuntimeQueryAdapter(queryClient)?.resumeSession();
    }
  }, [queryClient, sessionReset, me.isSuccess]);

  useEffect(() => {
    if (sessionReset?.phase !== "failed") return;
    const timer = setInterval(() => {
      const checking = { ...sessionReset, phase: "checking" as const };
      resetRef.current = checking;
      setSessionReset(checking);
      void verifySession(checking);
    }, 15_000);
    return () => clearInterval(timer);
  }, [sessionReset, verifySession]);

  const retryIdentity = () => {
    const reset = resetRef.current;
    if (reset === null) return me.refetch();
    const checking = { ...reset, phase: "checking" as const };
    resetRef.current = checking;
    setSessionReset(checking);
    return verifySession(checking);
  };

  // Read once, on the render the 401 arrived in: this is the last moment the
  // content is known to still exist (T-317's premise). Later renders reuse
  // it — re-reading would flip a kept page into a Navigate the moment the
  // user cleared their draft, destroying what the dialog promised to protect.
  // Derived during render, not in an effect: the 401 branch below redirects
  // on the very render the error arrives in, and an effect would only run
  // after that render has replaced the tree — the recorded entry would never
  // get a chance to exist.
  const [sessionLoss, setSessionLoss] = useState<{
    hadUnsavedWork: boolean;
    announced: boolean;
  } | null>(null);
  const errored401 = me.isError && statusOf(me.error) === 401;
  const sessionEnded = errored401 || sessionReset?.phase === "lost";
  if (sessionEnded && sessionLoss === null) {
    setSessionLoss({
      hadUnsavedWork: sessionReset?.hadUnsavedWork ?? hasUnsavedWork(),
      announced: false,
    });
  } else if (
    !sessionEnded &&
    sessionReset === null &&
    me.isSuccess &&
    sessionLoss !== null
  ) {
    // The session came back (re-login in another tab): back to a clean
    // slate, so a later loss can be announced again.
    setSessionLoss(null);
  }

  // Latched, because the panel below has to outlive its own refetch. With no
  // cached account, query-core resets the query to pending the instant a
  // fetch starts (query.js, `fetchState`), so `me.isError` drops and
  // `me.error` goes null for the length of every attempt. Read live, the
  // condition would therefore be false exactly while a retry is running, and
  // the whole failure screen would flip to page skeletons and back — every
  // 15s unattended, and again under the click of the Retry button the user is
  // aiming at. Derived during render for the same reason `sessionLoss` is.
  const [coldStartFailure, setColdStartFailure] = useState<string | null>(null);
  if (me.isError && !errored401 && me.data === undefined) {
    if (me.error.message !== coldStartFailure) {
      setColdStartFailure(me.error.message);
    }
  } else if (me.data !== undefined && coldStartFailure !== null) {
    // The account arrived, so the latch is what retires the panel — and the
    // only thing that does. Reading `me.data === undefined` at the branch
    // below as well would put two guards on one condition, each passing the
    // suite with the other deleted; one of them has to be the guard. Delete
    // this branch and "drops the panel when a retry finally brings the
    // account" goes red.
    setColdStartFailure(null);
  }

  if (sessionReset !== null && !sessionReset.hadUnsavedWork && !sessionEnded) {
    // A recovered page cannot mount private descendants from its old local
    // cache while online verification is pending or has failed.
    return (
      <AppShell accountUnavailable={sessionReset.error !== undefined}>
        {sessionReset.error !== undefined ? (
          <main className="mx-auto max-w-lg px-4 py-20 text-center">
            <LoadFailure
              message={`Failed to reach the todou server: ${sessionReset.error?.message}`}
              detail={sessionReset.error?.message}
              onRetry={retryIdentity}
              retrying={sessionReset.phase === "checking"}
              className="justify-center"
            />
          </main>
        ) : (
          <PagePending />
        )}
      </AppShell>
    );
  }

  if (coldStartFailure !== null && !sessionEnded) {
    // Cold-start failure: there is no cached account, so nothing to keep —
    // but the shell still frames the answer, and the account slot says
    // "unavailable" instead of spinning a skeleton forever.
    return (
      <AppShell accountUnavailable>
        <main className="mx-auto max-w-lg px-4 py-20 text-center">
          <LoadFailure
            message={`Failed to reach the todou server: ${coldStartFailure}`}
            detail={coldStartFailure}
            onRetry={retryIdentity}
            retrying={me.isFetching}
            className="justify-center"
          />
        </main>
      </AppShell>
    );
  }

  if (sessionEnded && sessionLoss?.hadUnsavedWork) {
    // Session lost with unsaved work on screen: keep the page mounted (the
    // guard stays armed; writes fail their own way) and explain instead of
    // throwing the draft away. One dialog per lost session — window-focus
    // refetches keep failing and must not re-open it.
    const here = window.location.pathname + window.location.search;
    return (
      <>
        <AppShell me={sessionReset?.account ?? me.data}>
          <Outlet />
        </AppShell>
        <Dialog
          open={!sessionLoss.announced}
          onOpenChange={(open) => {
            if (!open) setSessionLoss({ ...sessionLoss, announced: true });
          }}
        >
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Your session has ended</DialogTitle>
              <DialogDescription>
                The server no longer accepts this session, so nothing on this
                page can be submitted right now. Copy anything you need, or keep
                working and sign in elsewhere — the page stays as it is.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button
                variant="outline"
                onClick={() =>
                  setSessionLoss({ ...sessionLoss, announced: true })
                }
              >
                Stay on this page
              </Button>
              {/* A real link (resolved at render), styled as a button —
                  middle-click and the status-bar preview keep working. Going
                  to /login still crosses the unsaved-changes guard, which
                  asks once more: deliberately, because that prompt is the
                  one thing standing between the draft and a discarded tab. */}
              <Button asChild>
                <Link
                  to="/login"
                  search={here === "/" ? {} : { redirect: here }}
                >
                  Go to login
                </Link>
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </>
    );
  }

  if (sessionEnded) {
    // Carry the interrupted location (e.g. /cli-auth?...) through login.
    // Read window.location (the last COMMITTED url), never live router
    // state: that updates mid-transition, so Navigate would re-fire with
    // an ever-nesting redirect param and wedge the main thread.
    const here = window.location.pathname + window.location.search;
    return (
      <Navigate to="/login" search={here === "/" ? {} : { redirect: here }} />
    );
  }

  const warmFailure =
    sessionReset?.phase === "failed" ||
    (me.isError && statusOf(me.error) !== 401);
  return (
    <AppShell
      me={sessionReset?.account ?? me.data}
      notice={
        warmFailure ? (
          <ConnectionBanner
            message={
              sessionReset?.error?.message ??
              me.error?.message ??
              "network error"
            }
            onRetry={retryIdentity}
          />
        ) : undefined
      }
    >
      {/* Deliberately not `<Outlet/>` while the account is in flight (T-265).
          Mounting the page here would fire its queries alongside /api/me, and
          a visitor without a session can take the page's 401 first — long
          enough to flash that route's errorComponent before <Navigate> sends
          them to /login. The cost is that first-paint fetching stays serial. */}
      {me.isPending && !sessionReset?.hadUnsavedWork ? (
        <PagePending />
      ) : (
        <Outlet />
      )}
    </AppShell>
  );
}

const indexRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: "/",
  component: () => <Navigate to="/projects" />,
});

const projectsRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: "/projects",
  component: ProjectsPage,
  // ?new=1 (from the switcher footer) opens the create-project dialog.
  validateSearch: (search): { new?: boolean } =>
    search.new === true || search.new === 1 || search.new === "1"
      ? { new: true }
      : {},
  staticData: { pageSkeleton: "sections" },
});

const projectRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: "/projects/$slug",
  component: ProjectLayout,
  errorComponent: ProjectRouteError,
});

const projectIndexRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: "/",
  component: IssueListPage,
  validateSearch: (search) => issueSearchSchema.parse(search),
  staticData: { pageSkeleton: "list", backControl: "projects" },
});

declare module "@tanstack/react-router" {
  interface StaticDataRouteOption {
    /** The page is handed `<main>` as a flex box holding the height left
     * under the header and the full width, instead of the centred max-width
     * column; the shell appends no flow content (the version footer) below
     * it. */
    fillsViewport?: boolean;
    /** This route's own boundary answers when the project lookup misses: a
     * card's old address outlives the reader's access to the project that
     * once held it, and only this route knows where the card went. */
    resolvesProjectMiss?: boolean;
    /**
     * Which shape `AppShell` draws inside `<main>` while this route's data is
     * in flight. A declaration rather than a `pendingComponent` on purpose —
     * see the note over `createRouter` (T-265).
     */
    pageSkeleton?: PageSkeletonKind;
    /**
     * Which back control the header wears on a phone, where no page has a
     * gutter or a heading to hang one beside (T-461).
     *
     * The *kind* is static; the destination is not. A card's back goes
     * wherever this history entry was opened from, which only
     * `ReturnViewProvider` knows — so the control named here resolves that
     * itself, exactly as it does on the page.
     */
    backControl?: BackControlKind;
  }
}

const projectBoardRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: "board",
  component: BoardPage,
  staticData: {
    fillsViewport: true,
    pageSkeleton: "board",
    backControl: "projects",
  },
});

const projectInsightsRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: "insights",
  component: lazyRouteComponent(
    () => import("@/pages/insights.tsx"),
    "InsightsPage",
  ),
  validateSearch: parseInsightsSearch,
  search: { middlewares: [activityDateSearchMiddleware] },
  staticData: { pageSkeleton: "insights", backControl: "projects" },
});

const projectSearchRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: "search",
  component: SearchPage,
  validateSearch: (search) => searchPageSchema.parse(search),
  staticData: { backControl: "project" },
});

// Registered before issues/$number so the static segment wins the match.
const newIssueRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: "issues/new",
  component: NewIssuePage,
  validateSearch: (search) => newIssueSearchSchema.parse(search),
  staticData: { pageSkeleton: "sections", backControl: "project" },
});

const issueRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: "issues/$number",
  component: IssueDetailPage,
  errorComponent: IssueRouteError,
  staticData: {
    resolvesProjectMiss: true,
    pageSkeleton: "detail",
    backControl: "issue",
  },
});

// Lazy: the spec view drags @pierre/diffs and the annotation layer along —
// none of which the rest of the app needs on first paint (T-24 direction).
// The search parser lives in its own module so the page stays unreachable
// from the route table.
const specViewRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: "issues/$number/spec",
  component: lazyRouteComponent(
    () => import("@/pages/spec-view.tsx"),
    "SpecViewPage",
  ),
  validateSearch: parseSpecSearch,
  // Not lazy, unlike the component above: an error boundary that arrived in
  // the spec page's own chunk could not answer for a spec that is not here.
  errorComponent: SpecRouteError,
  staticData: { pageSkeleton: "spec", backControl: "spec" },
});

const projectSettingsRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: "settings",
  component: ProjectSettingsPage,
  staticData: { pageSkeleton: "sections", backControl: "projects" },
});

const inboxRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: "/inbox",
  component: InboxPage,
  validateSearch: (search): { tab?: InboxTab } => {
    const tab = INBOX_TABS.find((key) => key === search.tab);
    return tab && tab !== "all" ? { tab } : {};
  },
});

const mutedRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: "/inbox/muted",
  component: MutedPage,
});

// One path, two spellings: `$ref` all-digits is the permanent id form
// stored text links on, anything else is a login. The page component
// dispatches; the id half redirects to the login half after one lookup.
const userRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: "/users/$ref",
  component: UserPage,
  validateSearch: userSearchSchema,
  search: { middlewares: [activityDateSearchMiddleware] },
});

function UserPage() {
  const { ref } = userRoute.useParams();
  // TanStack merges raw search into validated search. Reparse to derive
  // notice metadata exclusively from date fields, never a supplied flag.
  const search = userSearchSchema(userRoute.useSearch());
  const { role = "any", state = "open" } = search;
  const navigate = useNavigate();
  // T-414: keep one userQuery subscriber for either address spelling. A
  // separate numeric-address observer mounting this page after a failed read
  // makes retryOnMount alternate pending/error and repeatedly remount it.
  // The same page owns the read and redirects once the account resolves.
  return (
    <UserProfilePage
      ref={ref}
      redirectToLogin={/^\d{1,15}$/.test(ref)}
      role={role}
      state={state}
      activity_day={search.activity_day}
      activity_invalid={search.activity_invalid}
      onActivityDateChange={(next, options) =>
        void navigate({
          to: "/users/$ref",
          params: { ref },
          search: userSearchParams({
            ...search,
            ...next,
          }),
          replace: options?.replace ?? false,
        })
      }
      // Filter controls rewriting their own page's search params: the case
      // AGENTS.md leaves to navigate() rather than requiring a link.
      onFilters={(next) =>
        void navigate({
          to: "/users/$ref",
          params: { ref },
          // Defaults and validation metadata stay out of shared addresses.
          search: userSearchParams({
            ...search,
            role: next.role ?? role,
            state: next.state ?? state,
          }),
          replace: true,
        })
      }
    />
  );
}

const profileSettingsRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: "/settings/profile",
  component: ProfileSettingsPage,
  staticData: { pageSkeleton: "sections" },
});

const agentsSettingsRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: "/settings/agents",
  component: AgentsSettingsPage,
  // ?state=deactivated selects the Deactivated segment; Active is the default
  // and stays out of the URL.
  validateSearch: (search): { state?: "deactivated" } =>
    search.state === "deactivated" ? { state: "deactivated" } : {},
  staticData: { pageSkeleton: "sections" },
});

const tokensSettingsRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: "/settings/tokens",
  component: TokensSettingsPage,
  staticData: { pageSkeleton: "sections" },
});

const cliAuthRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: "/cli-auth",
  component: CliAuthPage,
});

// Under the authed layout, so a visitor without a session is sent to /login
// and back (T-280) — the page's whole answer depends on who is asking.
const grantAccessRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: "/grant-access",
  component: GrantAccessPage,
});

const routeTree = rootRoute.addChildren([
  loginRoute,
  authedRoute.addChildren([
    indexRoute,
    inboxRoute,
    mutedRoute,
    projectsRoute,
    projectRoute.addChildren([
      projectIndexRoute,
      projectBoardRoute,
      projectInsightsRoute,
      projectSearchRoute,
      newIssueRoute,
      issueRoute,
      specViewRoute,
      projectSettingsRoute,
    ]),
    profileSettingsRoute,
    agentsSettingsRoute,
    tokensSettingsRoute,
    cliAuthRoute,
    grantAccessRoute,
    userRoute,
  ]),
]);

/**
 * Do not add `pendingComponent` to a route here, and do not add
 * `defaultPendingComponent` to this call. Either one makes the router build a
 * Suspense boundary of its own per route (`Match.js:39`, v1.170.25), nested
 * deeper than the one `AppShell` draws inside `<main>` and therefore the one
 * that actually catches — with the route's fallback, not the shell's. Which
 * of the two wins then takes reading the router's source to work out. An
 * app-drawn boundary above the page (the shell's own, inside `<main>`)
 * plus `staticData.pageSkeleton` leaves exactly one possible behaviour
 * (T-265). The router's root-route one (`Match.js:144`) wraps the
 * `<Outlet/>` and outranks anything declared here.
 */
export const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
