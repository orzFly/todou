import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { useEffect, useRef } from "react";
import { api, authModeQuery } from "@/api/queries.ts";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

/** Only same-site paths may be resumed after login (no open redirects). */
export function safeRedirect(value: unknown): string | undefined {
  return typeof value === "string" &&
    value.startsWith("/") &&
    !value.startsWith("//")
    ? value
    : undefined;
}

/** Human-readable face of the oidc callback's ?error= codes. */
export function oidcErrorText(code: string): string {
  switch (code) {
    case "state_mismatch":
      return "The sign-in attempt expired or was tampered with. Try again.";
    case "exchange_failed":
      return "The identity provider rejected the sign-in. Try again, and check the server logs if it persists.";
    case "claim_missing":
      return "The identity provider sent no usable username. Check the login_claim configuration.";
    case "provision_denied":
      return "Signed in, but no account exists here for that identity (and auto-creation is off).";
    case "login_conflict":
      return "Signed in, but the username is already taken by a different account here.";
    default:
      return "Sign-in failed. Try again.";
  }
}

export function oidcLoginUrl(redirect: string | undefined): string {
  const url = new URL("/api/auth/login", window.location.origin);
  if (redirect) url.searchParams.set("redirect", redirect);
  return url.toString();
}

/**
 * Login is always explicit, but never interactive: single mode exchanges
 * nothing for a session, oidc navigates to the IdP. The page only really
 * shows itself on errors — or in forward mode, where reaching it at all
 * means the proxy did not do its job.
 */
export function LoginPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const search = useSearch({ strict: false }) as Record<string, unknown>;
  const attempted = useRef(false);
  const mode = useQuery(authModeQuery);

  const redirect = safeRedirect(search.redirect);
  const oidcError = typeof search.error === "string" ? search.error : null;

  const login = useMutation({
    mutationFn: () => api.login(),
    onSuccess: (me) => {
      queryClient.setQueryData(["me"], me);
      if (redirect) {
        // A plain href, not a typed route (it carries arbitrary search
        // params like /cli-auth?port=…); a full navigation is fine here.
        window.location.assign(redirect);
      } else {
        navigate({ to: "/projects" });
      }
    },
  });

  const modeName = mode.data?.mode;
  useEffect(() => {
    if (attempted.current || modeName === undefined) return;
    attempted.current = true;
    if (modeName === "single") {
      login.mutate();
    } else if (modeName === "oidc" && !oidcError) {
      window.location.assign(oidcLoginUrl(redirect));
    }
  }, [modeName, oidcError, redirect, login.mutate]);

  return (
    <div className="flex min-h-dvh items-center justify-center bg-background">
      <Card className="w-80">
        <CardContent className="flex flex-col items-center gap-4 pt-6">
          <span className="text-4xl" aria-hidden>
            🥔
          </span>
          {mode.isError ? (
            <>
              <p className="text-center text-sm text-destructive">
                Could not reach the server: {mode.error.message}
              </p>
              <Button onClick={() => mode.refetch()}>Try again</Button>
            </>
          ) : modeName === "forward" ? (
            <p className="text-center text-sm text-destructive">
              The reverse proxy did not send an identity header. Check the
              forward-auth setup (auth.forward.user_header and
              http.trusted_proxies).
            </p>
          ) : modeName === "oidc" && oidcError ? (
            <>
              <p className="text-center text-sm text-destructive">
                {oidcErrorText(oidcError)}
              </p>
              <Button
                onClick={() => window.location.assign(oidcLoginUrl(redirect))}
              >
                Try again
              </Button>
            </>
          ) : login.isError ? (
            <>
              <p className="text-center text-sm text-destructive">
                Could not sign in: {login.error.message}
              </p>
              <Button onClick={() => login.mutate()}>Try again</Button>
            </>
          ) : (
            <p className="text-sm text-muted-foreground">
              Signing in to todou…
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
