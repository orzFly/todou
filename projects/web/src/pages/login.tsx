import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { useEffect, useRef } from "react";
import { api } from "@/api/queries.ts";
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

/**
 * Login is always explicit, but in single mode it needs no input — this
 * page immediately exchanges nothing for a session and moves on, so the
 * user never really sees it unless the server is unreachable.
 */
export function LoginPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const search = useSearch({ strict: false }) as Record<string, unknown>;
  const attempted = useRef(false);

  const login = useMutation({
    mutationFn: () => api.login(),
    onSuccess: (me) => {
      queryClient.setQueryData(["me"], me);
      const redirect = safeRedirect(search.redirect);
      if (redirect) {
        // A plain href, not a typed route (it carries arbitrary search
        // params like /cli-auth?port=…); a full navigation is fine here.
        window.location.assign(redirect);
      } else {
        navigate({ to: "/projects" });
      }
    },
  });

  useEffect(() => {
    if (!attempted.current) {
      attempted.current = true;
      login.mutate();
    }
  }, [login.mutate]);

  return (
    <div className="flex min-h-dvh items-center justify-center bg-background">
      <Card className="w-80">
        <CardContent className="flex flex-col items-center gap-4 pt-6">
          <span className="text-4xl" aria-hidden>
            🥔
          </span>
          {login.isError ? (
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
