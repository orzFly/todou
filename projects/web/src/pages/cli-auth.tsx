import { useMutation } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { api } from "@/api/queries.ts";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

export type CliAuthRequest = { port: number; state: string; name: string };

/** Reject anything malformed up front; the page renders an error instead. */
export function parseCliAuthSearch(
  search: Record<string, unknown>,
): CliAuthRequest | null {
  const port =
    typeof search.port === "number" ? search.port : Number(search.port);
  const state = typeof search.state === "string" ? search.state : "";
  if (!Number.isInteger(port) || port < 1 || port > 65535 || state === "") {
    return null;
  }
  const name =
    typeof search.name === "string" && search.name.trim() !== ""
      ? search.name
      : "todou CLI";
  return { port, state, name: name.slice(0, 100) };
}

export function callbackUrl(request: CliAuthRequest, token: string): string {
  const url = new URL(`http://127.0.0.1:${request.port}/callback`);
  url.searchParams.set("token", token);
  url.searchParams.set("state", request.state);
  return url.toString();
}

export function CliAuthCard({
  request,
  onCancel,
  mint = (name) => api.createMyToken({ name }),
  deliver = (url) => window.location.assign(url),
}: {
  request: CliAuthRequest;
  onCancel: () => void;
  /** Test seams; production uses the real API and a top-level navigation. */
  mint?: (name: string) => Promise<{ token: string }>;
  deliver?: (url: string) => void;
}) {
  const authorize = useMutation({
    mutationFn: () => mint(request.name),
    onSuccess: (created) => deliver(callbackUrl(request, created.token)),
  });

  return (
    <div className="mx-auto max-w-lg px-4 py-20">
      <Card>
        <CardContent className="flex flex-col items-center gap-4 pt-6 text-center">
          <span className="text-4xl" aria-hidden>
            🥔
          </span>
          <h1 className="text-lg font-semibold">Authorize todou CLI</h1>
          <p className="text-sm text-muted-foreground">
            <span className="font-medium text-foreground">{request.name}</span>{" "}
            is asking for a personal access token. It will be delivered to a
            local process listening on port {request.port} of this machine.
          </p>
          {authorize.isError ? (
            <p className="text-sm text-destructive">
              Could not issue the token: {authorize.error.message}
            </p>
          ) : null}
          <div className="flex gap-2">
            <Button
              onClick={() => authorize.mutate()}
              disabled={authorize.isPending || authorize.isSuccess}
            >
              {authorize.isSuccess ? "Delivered" : "Authorize"}
            </Button>
            <Button variant="outline" onClick={onCancel}>
              Cancel
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

export function CliAuthPage() {
  const search = useSearch({ strict: false }) as Record<string, unknown>;
  const navigate = useNavigate();
  const request = parseCliAuthSearch(search);
  if (!request) {
    return (
      <div className="mx-auto max-w-lg px-4 py-20 text-center text-destructive">
        Invalid CLI authorization request. Re-run `todou login` and follow the
        link it prints.
      </div>
    );
  }
  return (
    <CliAuthCard
      request={request}
      onCancel={() => navigate({ to: "/projects" })}
    />
  );
}
