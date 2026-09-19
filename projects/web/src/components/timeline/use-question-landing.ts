import { useQueryClient } from "@tanstack/react-query";
import {
  type RegisteredRouter,
  useRouter,
  useRouterState,
} from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { questionsQuery } from "@/api/questions.ts";
import {
  isQuestionLandingHash,
  selectQuestionLanding,
  UNANSWERED_QUESTIONS_HASH,
} from "@/lib/question-landing.ts";

export const QUESTION_LANDING_ROUTE_ID =
  "/authed/projects/$slug/issues/$number" satisfies keyof RegisteredRouter["routesById"];

type Landing = {
  id: number;
  pathname: string;
  phase: "reading" | "anchor" | "latest" | "failed" | "done";
  hash: string;
  error?: "read" | "unavailable" | "stalled";
  detail?: string;
};

/** One entry consumes one fresh snapshot, then hands scrolling to the timeline. */
export function useQuestionLanding(slug: string, issueNumber: number) {
  const client = useQueryClient();
  const router = useRouter();
  const location = useRouterState({ select: (s) => s.location });
  const destination = router
    .matchRoutes(location)
    .find((match) => match.routeId === QUESTION_LANDING_ROUTE_ID);
  const isCurrentCard =
    destination?.params.slug === slug &&
    Number(destination.params.number) === issueNumber;
  const sequence = useRef(0);
  const active = useRef<Landing | null>(null);
  const [landing, setLanding] = useState<Landing | null>(null);
  const [retry, setRetry] = useState(0);
  const semantic = isQuestionLandingHash(location.hash);

  // History identity and Retry are explicit new intents, even at the same URL.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reentry must reread and reveal once
  useEffect(() => {
    // A suspended route transition can keep the outgoing Timeline mounted
    // while location already names the next card. It cannot start that intent.
    if (!isCurrentCard) {
      active.current = null;
      setLanding(null);
      return;
    }
    if (!isQuestionLandingHash(location.hash)) {
      const current = active.current;
      // Our own replace transfers the same intent to its concrete destination.
      if (
        current &&
        current.pathname === location.pathname &&
        current.hash === location.hash &&
        current.phase !== "reading"
      ) {
        return;
      }
      active.current = null;
      setLanding(null);
      return;
    }
    const intent: Landing = {
      id: ++sequence.current,
      pathname: location.pathname,
      phase: "reading",
      hash: UNANSWERED_QUESTIONS_HASH,
      // Keep the failure visible and its button disabled during the retry.
      ...(active.current?.pathname === location.pathname &&
      active.current.phase === "failed"
        ? { error: active.current.error, detail: active.current.detail }
        : {}),
    };
    active.current = intent;
    setLanding(intent);
    const isCurrent = () =>
      active.current === intent &&
      router.state.location.pathname === intent.pathname &&
      isQuestionLandingHash(router.state.location.hash);
    void client
      .fetchQuery({ ...questionsQuery(slug, issueNumber), staleTime: 0 })
      .then(async (data) => {
        if (!isCurrent()) return;
        const id = selectQuestionLanding(data);
        const next: Landing = {
          ...intent,
          phase: id === null ? "latest" : "anchor",
          hash: id === null ? "" : `comment-${id}`,
          error: undefined,
          detail: undefined,
        };
        active.current = next;
        setLanding(next);
        try {
          await router.navigate({
            hash: next.hash,
            replace: true,
            resetScroll: false,
            hashScrollIntoView: false,
            // This annotates the current page; it never discards an edit.
            ignoreBlocker: true,
            state: (prev) => prev,
          });
        } catch (error) {
          if (
            active.current !== next ||
            router.state.location.pathname !== next.pathname
          )
            return;
          const failed: Landing = {
            ...intent,
            phase: "failed",
            error: "read",
            detail: error instanceof Error ? error.message : String(error),
          };
          active.current = failed;
          setLanding(failed);
        }
      })
      .catch((error: unknown) => {
        if (!isCurrent()) return;
        const failed: Landing = {
          ...intent,
          phase: "failed",
          error: "read",
          detail: error instanceof Error ? error.message : String(error),
        };
        active.current = failed;
        setLanding(failed);
      });
  }, [
    client,
    router,
    slug,
    issueNumber,
    isCurrentCard,
    location.pathname,
    location.hash,
    location.state.__TSR_key,
    retry,
  ]);

  useEffect(
    () => () => {
      active.current = null;
    },
    [],
  );

  const finish = (error?: "unavailable" | "stalled") => {
    const current = active.current;
    if (
      !current ||
      current.id !== landing?.id ||
      current.pathname !== router.state.location.pathname ||
      current.hash !== router.state.location.hash ||
      (current.phase !== "anchor" && current.phase !== "latest")
    )
      return;
    const next: Landing = {
      ...current,
      phase: error ? "failed" : "done",
      error,
    };
    active.current = next;
    setLanding(next);
  };

  return {
    // Include the first render, before the reading effect has run.
    ownsScroll:
      (semantic && landing?.phase !== "failed") ||
      landing?.phase === "anchor" ||
      landing?.phase === "latest",
    anchorRequest:
      landing &&
      landing.hash === location.hash &&
      landing.hash.startsWith("comment-")
        ? landing.id
        : undefined,
    latest: landing?.phase === "latest" && location.hash === "",
    error: landing?.error,
    detail: landing?.detail,
    retrying: landing?.phase === "reading",
    finish,
    retry: () => {
      if (semantic) {
        setRetry((value) => value + 1);
      } else {
        void router
          .navigate({
            hash: UNANSWERED_QUESTIONS_HASH,
            replace: true,
            resetScroll: false,
            hashScrollIntoView: false,
            ignoreBlocker: true,
            state: (prev) => prev,
          })
          .catch(() => {
            // Keep the failure and its Retry if the annotation cannot be made.
            setLanding(landing);
          });
      }
    },
  };
}
