import { useMutation, useQuery } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import type { Agent, Me } from "@todou/shared";
import { Login } from "@todou/shared";
import { PlusIcon } from "lucide-react";
import { useState } from "react";
import { agentsQuery, api, meQuery } from "@/api/queries.ts";
import { UserChip } from "@/components/shared/user-chip.tsx";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";

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

/** Who the minted token will belong to. */
export type AuthTarget =
  | { kind: "me" }
  | { kind: "agent"; id: number }
  | { kind: "new"; login: string };

type Selection =
  | { kind: "me" }
  | { kind: "agent"; id: number }
  | { kind: "new" }
  | null;

const LAST_AGENT_KEY = "todou.cli-auth.last-agent";

/** localStorage can be unavailable (private mode, blocked storage). */
export function readLastAgentId(): number | null {
  try {
    const id = Number(window.localStorage.getItem(LAST_AGENT_KEY));
    return Number.isInteger(id) && id > 0 ? id : null;
  } catch {
    return null;
  }
}

export function rememberLastAgent(id: number): void {
  try {
    window.localStorage.setItem(LAST_AGENT_KEY, String(id));
  } catch {
    // Best-effort — the next authorization just won't be preselected.
  }
}

/**
 * The last authorized agent wins, then a sole agent; among several with no
 * history the user must pick explicitly. No agents at all lands on the
 * create form — the common case when setting up a brand-new machine.
 */
export function defaultSelection(
  agents: Agent[],
  lastAgentId: number | null,
): Selection {
  if (agents.length === 0) return { kind: "new" };
  if (lastAgentId !== null && agents.some((a) => a.id === lastAgentId)) {
    return { kind: "agent", id: lastAgentId };
  }
  return agents.length === 1 ? { kind: "agent", id: agents[0].id } : null;
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

const rowClass =
  "flex cursor-pointer items-center gap-3 px-3 py-2.5 hover:bg-muted/50 has-[:checked]:bg-muted";

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
  // Disabled agents cannot receive tokens (the server refuses), so they are
  // not offered at all.
  const candidates = agents.filter((a) => a.disabled_at === null);
  const [selection, setSelection] = useState<Selection>(() =>
    defaultSelection(candidates, lastAgentId),
  );
  const [newLogin, setNewLogin] = useState("");

  const authorize = useMutation({
    mutationFn: (target: AuthTarget) => mint(target, request.name),
    onSuccess: (minted, target) => {
      const agentId = target.kind === "agent" ? target.id : minted.agentId;
      if (agentId !== undefined) rememberLastAgent(agentId);
      deliver(callbackUrl(request, minted.token));
    },
  });

  const newLoginValid = Login.safeParse(newLogin).success;
  const target: AuthTarget | null =
    selection === null
      ? null
      : selection.kind !== "new"
        ? selection
        : newLoginValid
          ? { kind: "new", login: newLogin }
          : null;

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
          <fieldset>
            <legend className="mb-2 text-sm font-medium">Authorize as</legend>
            <div className="divide-y overflow-hidden rounded-lg border">
              {candidates.map((agent) => (
                <label key={agent.id} className={rowClass}>
                  <input
                    type="radio"
                    name="cli-auth-target"
                    className="accent-primary"
                    aria-label={agent.login}
                    checked={
                      selection?.kind === "agent" && selection.id === agent.id
                    }
                    onChange={() =>
                      setSelection({ kind: "agent", id: agent.id })
                    }
                  />
                  <UserChip user={agent} />
                  {agent.display_name !== agent.login && (
                    <span className="truncate text-sm text-muted-foreground">
                      {agent.display_name}
                    </span>
                  )}
                </label>
              ))}
              <label className={rowClass}>
                <input
                  type="radio"
                  name="cli-auth-target"
                  className="accent-primary"
                  aria-label="New agent"
                  checked={selection?.kind === "new"}
                  onChange={() => setSelection({ kind: "new" })}
                />
                <span className="inline-flex items-center gap-1.5 text-sm whitespace-nowrap">
                  <PlusIcon
                    className="size-4 text-muted-foreground"
                    aria-hidden
                  />
                  New agent
                </span>
                <Input
                  value={newLogin}
                  onChange={(e) => {
                    setNewLogin(e.target.value);
                    setSelection({ kind: "new" });
                  }}
                  onFocus={() => setSelection({ kind: "new" })}
                  placeholder="agent-login"
                  aria-label="New agent login"
                  className="h-7 flex-1"
                  maxLength={64}
                />
              </label>
              <label className={rowClass}>
                <input
                  type="radio"
                  name="cli-auth-target"
                  className="accent-primary"
                  aria-label={`${me.login} (yourself)`}
                  checked={selection?.kind === "me"}
                  onChange={() => setSelection({ kind: "me" })}
                />
                <UserChip user={me} />
                <span className="text-sm text-muted-foreground">yourself</span>
              </label>
            </div>
            {selection?.kind === "new" && newLogin !== "" && !newLoginValid ? (
              <p className="mt-1.5 text-xs text-destructive">
                Logins are lowercase letters, digits, and dashes.
              </p>
            ) : null}
          </fieldset>
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
                : selection?.kind === "new"
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

export function CliAuthPage() {
  const search = useSearch({ strict: false }) as Record<string, unknown>;
  const navigate = useNavigate();
  const me = useQuery(meQuery);
  const agents = useQuery(agentsQuery);
  const request = parseCliAuthSearch(search);
  if (!request) {
    return (
      <div className="mx-auto max-w-lg px-4 py-20 text-center text-destructive">
        Invalid CLI authorization request. Re-run `todou login` and follow the
        link it prints.
      </div>
    );
  }
  if (me.isPending || agents.isPending) {
    return (
      <div className="mx-auto max-w-lg space-y-3 px-4 py-20">
        <Skeleton className="h-8 w-2/3" />
        <Skeleton className="h-48 w-full" />
      </div>
    );
  }
  const failure = me.error ?? agents.error;
  if (failure || me.isError || agents.isError) {
    return (
      <div className="mx-auto max-w-lg px-4 py-20 text-center text-destructive">
        Could not load your agents: {failure?.message ?? "unknown error"}
      </div>
    );
  }
  return (
    <CliAuthCard
      request={request}
      me={me.data}
      agents={agents.data}
      lastAgentId={readLastAgentId()}
      onCancel={() => navigate({ to: "/projects" })}
    />
  );
}
