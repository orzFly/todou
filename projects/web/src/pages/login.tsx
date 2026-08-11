import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useRef } from "react";
import { api } from "@/api/queries.ts";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

/**
 * Login is always explicit, but in single mode it needs no input — this
 * page immediately exchanges nothing for a session and moves on, so the
 * user never really sees it unless the server is unreachable.
 */
export function LoginPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const attempted = useRef(false);

  const login = useMutation({
    mutationFn: () => api.login(),
    onSuccess: (me) => {
      queryClient.setQueryData(["me"], me);
      navigate({ to: "/projects" });
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
