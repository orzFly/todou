import { useMutation, useQuery } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import type { Agent, CliAuthRequestInfo, Me } from "@todou/shared";
import {
  CliAuthCode,
  formatCliAuthCode,
  normalizeCliAuthCode,
} from "@todou/shared";
import {
  agentsQuery,
  api,
  cliAuthRequestQuery,
  meQuery,
} from "@/api/queries.ts";
import {
  type AuthTarget,
  AuthTargetFieldset,
  readLastAgentId,
  rememberLastAgent,
  useTargetSelection,
} from "@/components/shared/auth-target-picker.tsx";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

export type CliAuthRequest = { port: number; state: string; name: string };

/**
 * Two ways in, and they never mix: the loopback link a same-machine login
 * prints, and the one-time code a `--no-browser` login prints (T-140).
 */
export type CliAuthSearch =
  | ({ kind: "loopback" } & CliAuthRequest)
  | { kind: "code"; code: string };

/** Reject anything malformed up front; the page renders an error instead. */
export function parseCliAuthSearch(
  search: Record<string, unknown>,
): CliAuthSearch | null {
  const rawCode = typeof search.code === "string" ? search.code : "";
  if (rawCode !== "") {
    // Carrying both spellings is a broken link, not an order of preference.
    if (search.port !== undefined || search.state !== undefined) return null;
    const code = normalizeCliAuthCode(rawCode);
    return CliAuthCode.safeParse(code).success ? { kind: "code", code } : null;
  }
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
  return { kind: "loopback", port, state, name: name.slice(0, 100) };
}

export function callbackUrl(request: CliAuthRequest, token: string): string {
  const url = new URL(`http://127.0.0.1:${request.port}/callback`);
  url.searchParams.set("token", token);
  url.searchParams.set("state", request.state);
  return url.toString();
}

async function mintToken(
  target: AuthTarget,
  tokenName: string,
): Promise<{ token: string; agentId?: number }> {
  switch (target.kind) {
    case "me":
      return api.createMyToken({ name: tokenName });
    case "agent":
      return api.issueAgentToken(target.id, { name: tokenName });
    case "new": {
      const agent = await api.createAgent({
        login: target.login,
        display_name: target.login,
      });
      const minted = await api.issueAgentToken(agent.id, { name: tokenName });
      return { token: minted.token, agentId: agent.id };
    }
  }
}

function AuthShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto max-w-lg px-4 py-20">
      <Card>
        <CardContent className="flex flex-col gap-5 pt-6">
          <div className="flex flex-col items-center gap-4 text-center">
            <span className="text-4xl" aria-hidden>
              🥔
            </span>
            <h1 className="text-lg font-semibold">Authorize todou CLI</h1>
            {children}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

export function CliAuthCard({
  request,
  me,
  agents,
  lastAgentId = null,
  onCancel,
  mint = mintToken,
  deliver = (url) => window.location.assign(url),
}: {
  request: CliAuthRequest;
  me: Me;
  agents: Agent[];
  lastAgentId?: number | null;
  onCancel: () => void;
  /** Test seams; production uses the real API and a top-level navigation. */
  mint?: (
    target: AuthTarget,
    tokenName: string,
  ) => Promise<{ token: string; agentId?: number }>;
  deliver?: (url: string) => void;
}) {
  const picker = useTargetSelection(agents, lastAgentId);

  const authorize = useMutation({
    mutationFn: (target: AuthTarget) => mint(target, request.name),
    onSuccess: (minted, target) => {
      const agentId = target.kind === "agent" ? target.id : minted.agentId;
      if (agentId !== undefined) rememberLastAgent(agentId);
      deliver(callbackUrl(request, minted.token));
    },
  });

  const { target } = picker;

  return (
    <div className="mx-auto max-w-lg px-4 py-20">
      <Card>
        <CardContent className="flex flex-col gap-5 pt-6">
          <div className="flex flex-col items-center gap-4 text-center">
            <span className="text-4xl" aria-hidden>
              🥔
            </span>
            <h1 className="text-lg font-semibold">Authorize todou CLI</h1>
            <p className="text-sm text-muted-foreground">
              <span className="font-medium text-foreground">
                {request.name}
              </span>{" "}
              is asking for a personal access token. It will be delivered to a
              local process listening on port {request.port} of this machine.
            </p>
          </div>
          <AuthTargetFieldset me={me} picker={picker} />
          {authorize.isError ? (
            <p className="text-center text-sm text-destructive">
              Could not issue the token: {authorize.error.message}
            </p>
          ) : null}
          <div className="flex justify-center gap-2">
            <Button
              onClick={() => target !== null && authorize.mutate(target)}
              disabled={
                target === null || authorize.isPending || authorize.isSuccess
              }
            >
              {authorize.isSuccess
                ? "Delivered"
                : picker.selection?.kind === "new"
                  ? "Create & authorize"
                  : "Authorize"}
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

/**
 * The `--no-browser` half: this browser and the waiting terminal never talk
 * to each other, so the one-time code is the only thing tying them together
 * — shown large, because comparing it against the terminal is what stops a
 * stranger's authorization request from being approved here.
 */
export function CliAuthCodeCard({
  request,
  me,
  agents,
  lastAgentId = null,
  approve = (id, target) => api.approveCliAuthRequest(id, { target }),
  refuse = (id) => api.denyCliAuthRequest(id),
}: {
  request: CliAuthRequestInfo;
  me: Me;
  agents: Agent[];
  lastAgentId?: number | null;
  /** Test seams; production talks to the API. */
  approve?: (
    id: number,
    target: AuthTarget,
  ) => Promise<{ agent_id: number | null }>;
  refuse?: (id: number) => Promise<void>;
}) {
  const picker = useTargetSelection(agents, lastAgentId);

  const authorize = useMutation({
    mutationFn: (target: AuthTarget) => approve(request.id, target),
    onSuccess: (result, target) => {
      const agentId = target.kind === "agent" ? target.id : result.agent_id;
      if (agentId !== null && agentId !== undefined) rememberLastAgent(agentId);
    },
  });
  const deny = useMutation({ mutationFn: () => refuse(request.id) });

  if (authorize.isSuccess) {
    return (
      <AuthShell>
        <p className="text-sm text-muted-foreground">
          Approved — return to the terminal, which now has its token.
        </p>
      </AuthShell>
    );
  }
  if (deny.isSuccess) {
    return (
      <AuthShell>
        <p className="text-sm text-muted-foreground">
          Denied. Nothing was issued, and the terminal has been told.
        </p>
      </AuthShell>
    );
  }

  const { target } = picker;
  const busy = authorize.isPending || deny.isPending;

  return (
    <div className="mx-auto max-w-lg px-4 py-20">
      <Card>
        <CardContent className="flex flex-col gap-5 pt-6">
          <div className="flex flex-col items-center gap-4 text-center">
            <span className="text-4xl" aria-hidden>
              🥔
            </span>
            <h1 className="text-lg font-semibold">Authorize todou CLI</h1>
            <div className="flex flex-col items-center gap-1">
              <p className="text-xs uppercase tracking-wide text-muted-foreground">
                One-time code
              </p>
              <p className="font-mono text-3xl tracking-widest">
                {formatCliAuthCode(request.code)}
              </p>
            </div>
            <p className="text-sm text-muted-foreground">
              <span className="font-medium text-foreground">
                {request.name}
              </span>{" "}
              is asking for a personal access token. The token goes to whichever
              terminal holds this code — approve only if it matches the code
              your own terminal is showing.
            </p>
          </div>
          <AuthTargetFieldset me={me} picker={picker} />
          {authorize.isError || deny.isError ? (
            <p className="text-center text-sm text-destructive">
              Could not issue the token:{" "}
              {(authorize.error ?? deny.error)?.message}
            </p>
          ) : null}
          <div className="flex justify-center gap-2">
            <Button
              onClick={() => target !== null && authorize.mutate(target)}
              disabled={target === null || busy}
            >
              {picker.selection?.kind === "new"
                ? "Create & authorize"
                : "Authorize"}
            </Button>
            <Button
              variant="outline"
              onClick={() => deny.mutate()}
              disabled={busy}
            >
              Deny
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function LoadingCard() {
  return (
    <div className="mx-auto max-w-lg space-y-3 px-4 py-20">
      <Skeleton className="h-8 w-2/3" />
      <Skeleton className="h-48 w-full" />
    </div>
  );
}

function PageError({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto max-w-lg px-4 py-20 text-center text-destructive">
      {children}
    </div>
  );
}

function LoopbackFlow({
  request,
  onCancel,
}: {
  request: CliAuthRequest;
  onCancel: () => void;
}) {
  const me = useQuery(meQuery);
  const agents = useQuery(agentsQuery);
  if (me.isPending || agents.isPending) return <LoadingCard />;
  const failure = me.error ?? agents.error;
  if (failure || me.isError || agents.isError) {
    return (
      <PageError>
        Could not load your agents: {failure?.message ?? "unknown error"}
      </PageError>
    );
  }
  return (
    <CliAuthCard
      request={request}
      me={me.data}
      agents={agents.data}
      lastAgentId={readLastAgentId()}
      onCancel={onCancel}
    />
  );
}

function CodeFlow({ code }: { code: string }) {
  const me = useQuery(meQuery);
  const agents = useQuery(agentsQuery);
  const request = useQuery(cliAuthRequestQuery(code));
  if (me.isPending || agents.isPending || request.isPending) {
    return <LoadingCard />;
  }
  if (request.isError) {
    return (
      <PageError>
        This authorization request is unknown or has expired. Re-run `todou
        login --no-browser` in your terminal for a fresh code.
      </PageError>
    );
  }
  const failure = me.error ?? agents.error;
  if (failure || me.isError || agents.isError) {
    return (
      <PageError>
        Could not load your agents: {failure?.message ?? "unknown error"}
      </PageError>
    );
  }
  return (
    <CliAuthCodeCard
      request={request.data}
      me={me.data}
      agents={agents.data}
      lastAgentId={readLastAgentId()}
    />
  );
}

export function CliAuthPage() {
  const search = useSearch({ strict: false }) as Record<string, unknown>;
  const navigate = useNavigate();
  const parsed = parseCliAuthSearch(search);
  if (!parsed) {
    return (
      <PageError>
        Invalid CLI authorization request. Re-run `todou login` and follow the
        link it prints.
      </PageError>
    );
  }
  return parsed.kind === "code" ? (
    <CodeFlow code={parsed.code} />
  ) : (
    <LoopbackFlow
      request={parsed}
      onCancel={() => navigate({ to: "/projects" })}
    />
  );
}
