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
import {
  LoadFailure,
  RefreshFailure,
} from "@/components/shared/load-failure.tsx";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { classifyReadFailure } from "@/lib/http-status.ts";
import { useReadFailure } from "@/lib/use-read-failure.ts";

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
  refreshFailure,
  deliver = (url) => window.location.assign(url),
}: {
  request: CliAuthRequest;
  me: Me;
  agents: Agent[];
  lastAgentId?: number | null;
  onCancel: () => void;
  /** Test seams; production uses the real API and a top-level navigation. */
  refreshFailure?: React.ReactNode;
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
          {refreshFailure}
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
  refreshFailures,
}: {
  request: CliAuthRequestInfo;
  me: Me;
  agents: Agent[];
  lastAgentId?: number | null;
  /** Test seams; production talks to the API. */
  refreshFailures?: React.ReactNode;
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
          {refreshFailures}
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
  const meData = me.data;
  const agentsData = agents.data;
  const hasContent = meData !== undefined && agentsData !== undefined;
  const failure = me.error ?? agents.error;
  const { replace, notice } = useReadFailure(failure, hasContent);
  const retry = () => void Promise.all([me.refetch(), agents.refetch()]);
  const retrying = me.isFetching || agents.isFetching;

  if (replace) {
    return (
      <PageError>
        <LoadFailure
          message={`Could not load your agents: ${replace}`}
          detail={replace}
          onRetry={retry}
          retrying={retrying}
          className="justify-center"
        />
      </PageError>
    );
  }
  if (!hasContent) return <LoadingCard />;
  return (
    <CliAuthCard
      request={request}
      me={meData}
      agents={agentsData}
      lastAgentId={readLastAgentId()}
      onCancel={onCancel}
      refreshFailure={
        notice ? (
          <RefreshFailure
            what="your agents"
            detail={notice}
            onRetry={retry}
            retrying={retrying}
            className="justify-center"
          />
        ) : null
      }
    />
  );
}

function CodeFlow({ code }: { code: string }) {
  const me = useQuery(meQuery);
  const agents = useQuery(agentsQuery);
  const request = useQuery(cliAuthRequestQuery(code));
  const requestData = request.data;
  const meData = me.data;
  const agentsData = agents.data;
  const hasRequest = requestData !== undefined;
  const requestError = request.isError ? request.error : null;
  const requestFailure = useReadFailure(requestError, hasRequest);
  const hasAgents = meData !== undefined && agentsData !== undefined;
  const agentsFailure = useReadFailure(me.error ?? agents.error, hasAgents);
  const retryRequest = () => void request.refetch();
  const retryAgents = () => void Promise.all([me.refetch(), agents.refetch()]);
  const retryingAgents = me.isFetching || agents.isFetching;

  if (
    requestError !== null &&
    classifyReadFailure(requestError) === "refused"
  ) {
    return (
      <PageError>
        This authorization request is unknown or has expired. Re-run `todou
        login --no-browser` in your terminal for a fresh code.
      </PageError>
    );
  }
  if (requestFailure.replace) {
    return (
      <PageError>
        <LoadFailure
          message={`Could not load this request: ${requestFailure.replace}`}
          detail={requestFailure.replace}
          onRetry={retryRequest}
          retrying={request.isFetching}
          className="justify-center"
        />
      </PageError>
    );
  }
  if (agentsFailure.replace) {
    return (
      <PageError>
        <LoadFailure
          message={`Could not load your agents: ${agentsFailure.replace}`}
          detail={agentsFailure.replace}
          onRetry={retryAgents}
          retrying={retryingAgents}
          className="justify-center"
        />
      </PageError>
    );
  }
  if (!hasRequest || !hasAgents) return <LoadingCard />;
  return (
    <CliAuthCodeCard
      request={requestData}
      me={meData}
      agents={agentsData}
      lastAgentId={readLastAgentId()}
      refreshFailures={
        <>
          {requestFailure.notice ? (
            <RefreshFailure
              what="this request"
              detail={requestFailure.notice}
              onRetry={retryRequest}
              retrying={request.isFetching}
              className="justify-center"
            />
          ) : null}
          {agentsFailure.notice ? (
            <RefreshFailure
              what="your agents"
              detail={agentsFailure.notice}
              onRetry={retryAgents}
              retrying={retryingAgents}
              className="justify-center"
            />
          ) : null}
        </>
      }
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
