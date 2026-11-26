import { Button } from "@orz/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@orz/ui/components/dialog";
import { Input } from "@orz/ui/components/input";
import { Label } from "@orz/ui/components/label";
import {
  useMutation,
  useQuery,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import type { Agent, AgentUpdateInput, TokenCreated } from "@todou/shared";
import {
  ArrowLeftIcon,
  PencilIcon,
  PlusIcon,
  PowerIcon,
  PowerOffIcon,
} from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { agentsQuery, api, myTokensQuery } from "@/api/queries.ts";
import { AgentProjectsSection } from "@/components/shared/agent-projects.tsx";
import { AvatarEditor } from "@/components/shared/avatar-editor.tsx";
import {
  LoadFailure,
  RefreshFailure,
} from "@/components/shared/load-failure.tsx";
import {
  expiresAtFrom,
  TokenExpirySelect,
} from "@/components/shared/token-expiry-select.tsx";
import { TokenReveal } from "@/components/shared/token-reveal.tsx";
import { TokenTable } from "@/components/shared/token-table.tsx";
import { UserAvatar } from "@/components/shared/user-chip.tsx";
import { useReadFailure } from "@/lib/use-read-failure.ts";

/**
 * One agent's own page (T-704): its projects, its tokens and switching it
 * off, all on one screen instead of behind three dialogs per list row.
 */
export function AgentSettingsPage() {
  const { login } = useParams({ from: "/authed/settings/agents/$login" });
  return <AgentSettings login={login} />;
}

/** The page below its route, so the tests can mount it without one. */
export function AgentSettings({ login }: { login: string }) {
  const agents = useSuspenseQuery(agentsQuery);
  const navigate = useNavigate();
  const agent = agents.data.find((a) => a.login === login);

  if (agent === undefined) {
    return (
      <div className="space-y-4">
        <BackToAgents deactivated={false} />
        <div className="rounded-lg border border-dashed p-10 text-center text-muted-foreground">
          You have no agent called @{login}.
        </div>
      </div>
    );
  }

  const disabled = agent.disabled_at !== null;
  return (
    <div className="max-w-2xl space-y-8">
      <div className="space-y-4">
        <BackToAgents deactivated={disabled} />
        <div className="flex min-w-0 items-center gap-3.5">
          <UserAvatar user={agent} badge className="size-10 shrink-0" />
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-xl font-semibold">
              <Link
                to="/users/$ref"
                params={{ ref: agent.login }}
                className="hover:underline"
              >
                {agent.display_name}
              </Link>
            </h1>
            <div className="truncate text-sm text-muted-foreground">
              @{agent.login}
            </div>
          </div>
          <EditAgentDialog
            agent={agent}
            // The URL is the login, so a rename has to carry the page along
            // or the next render finds no agent here.
            onRenamed={(next) =>
              navigate({
                to: "/settings/agents/$login",
                params: { login: next },
                replace: true,
              })
            }
          />
          {disabled && <EnableAgentButton agent={agent} />}
        </div>
      </div>

      <AgentProjectsSection agent={agent} />

      {!disabled && (
        <>
          <AgentTokensSection key={agent.id} agent={agent} />
          <DisableAgentRow agent={agent} />
        </>
      )}
    </div>
  );
}

function BackToAgents({ deactivated }: { deactivated: boolean }) {
  return (
    <Link
      to="/settings/agents"
      search={deactivated ? { state: "deactivated" } : {}}
      className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
    >
      <ArrowLeftIcon className="size-4" aria-hidden />
      Agents
    </Link>
  );
}

function DisableAgentRow({ agent }: { agent: Agent }) {
  const queryClient = useQueryClient();
  const disable = useMutation({
    mutationFn: () => api.disableAgent(agent.id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["agents"] });
      toast.success(`${agent.login} disabled; its tokens were revoked.`);
    },
    onError: (error) => toast.error(error.message),
  });
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 rounded-lg border border-destructive/35 py-3 pr-3 pl-4">
      <p className="text-sm text-muted-foreground">
        Disabling revokes every token at once. Re-enabling does not bring them
        back.
      </p>
      <Button
        variant="outline"
        size="sm"
        className="text-destructive"
        disabled={disable.isPending}
        onClick={() => disable.mutate()}
      >
        <PowerOffIcon className="size-3.5" /> Disable
      </Button>
    </div>
  );
}

function EnableAgentButton({ agent }: { agent: Agent }) {
  const queryClient = useQueryClient();
  const enable = useMutation({
    mutationFn: () => api.enableAgent(agent.id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["agents"] });
      toast.success(
        `${agent.login} re-enabled. Old tokens stay revoked — issue a new one.`,
      );
    },
    onError: (error) => toast.error(error.message),
  });
  return (
    <Button
      variant="outline"
      size="sm"
      disabled={enable.isPending}
      onClick={() => enable.mutate()}
    >
      <PowerIcon className="size-3.5" /> Enable
    </Button>
  );
}

function EditAgentDialog({
  agent,
  onRenamed,
}: {
  agent: Agent;
  onRenamed: (login: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [login, setLogin] = useState(agent.login);
  const [displayName, setDisplayName] = useState(agent.display_name);
  const queryClient = useQueryClient();

  // The agent's identity is denormalized into issue/timeline payloads
  // everywhere — drop the whole cache instead of chasing keys.
  const applyUpdate = () => queryClient.invalidateQueries();

  const save = useMutation({
    mutationFn: () => {
      const patch: AgentUpdateInput = {};
      if (login !== agent.login) patch.login = login;
      if (displayName !== agent.display_name) {
        patch.display_name = displayName;
      }
      return api.updateAgent(agent.id, patch);
    },
    onSuccess: (updated) => {
      applyUpdate();
      setOpen(false);
      toast.success("Agent profile updated.");
      if (updated.login !== agent.login) onRenamed(updated.login);
    },
    onError: (error) => toast.error(error.message),
  });
  const upload = useMutation({
    mutationFn: (file: File) => api.uploadAgentAvatar(agent.id, file),
    onSuccess: () => {
      applyUpdate();
      toast.success("Avatar updated.");
    },
    onError: (error) => toast.error(error.message),
  });
  const removeAvatar = useMutation({
    mutationFn: () => api.deleteAgentAvatar(agent.id),
    onSuccess: () => {
      applyUpdate();
      toast.success("Avatar removed.");
    },
    onError: (error) => toast.error(error.message),
  });

  const dirty = login !== agent.login || displayName !== agent.display_name;

  function reset(next: boolean) {
    setOpen(next);
    if (next) {
      setLogin(agent.login);
      setDisplayName(agent.display_name);
    }
  }

  return (
    <Dialog open={open} onOpenChange={reset}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          <PencilIcon className="size-3.5" /> Edit
        </Button>
      </DialogTrigger>
      <DialogContent className="grid-cols-1 max-h-[calc(100dvh-2rem)] overflow-y-auto">
        <DialogHeader className="min-w-0 pr-7">
          <DialogTitle className="min-w-0 leading-normal [overflow-wrap:anywhere]">
            Edit {agent.login}
          </DialogTitle>
          <DialogDescription>
            Renames apply everywhere immediately; scripts using the old login by
            hand (e.g. --assignee) need updating.
          </DialogDescription>
        </DialogHeader>
        <div className="min-w-0 space-y-4">
          <AvatarEditor
            subject={{
              name: agent.display_name,
              imageUrl: agent.avatar_url,
            }}
            onUpload={(file) => upload.mutate(file)}
            onRemove={() => removeAvatar.mutate()}
            pending={upload.isPending || removeAvatar.isPending}
          />
          <form
            className="min-w-0 space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              if (dirty) save.mutate();
            }}
          >
            <div className="space-y-2">
              <Label htmlFor="agent-edit-login">Login</Label>
              <Input
                id="agent-edit-login"
                value={login}
                onChange={(e) => setLogin(e.target.value)}
                pattern="[a-z0-9][a-z0-9-]*"
                maxLength={64}
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="agent-edit-display">Display name</Label>
              <Input
                id="agent-edit-display"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                maxLength={200}
                required
              />
            </div>
            <DialogFooter>
              <Button type="submit" disabled={!dirty || save.isPending}>
                Save changes
              </Button>
            </DialogFooter>
          </form>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Keyed by the agent's id at the call site: an issued token's plaintext and
 * a latched refresh failure belong to one agent and must not survive a move
 * to another one's page.
 */
export function AgentTokensSection({ agent }: { agent: Agent }) {
  const [name, setName] = useState("");
  const [expiry, setExpiry] = useState("never");
  // The plaintext exists only on this page — leaving it forgets it.
  const [created, setCreated] = useState<TokenCreated | null>(null);
  const queryClient = useQueryClient();
  const tokenQueryKey = ["agent-tokens", agent.id] as const;

  const tokens = useQuery({
    queryKey: tokenQueryKey,
    queryFn: () => api.listAgentTokens(agent.id),
  });
  const { replace, notice } = useReadFailure(
    [tokens.isError ? tokens.error : null],
    tokens.data !== undefined,
    tokenQueryKey,
  );
  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: tokenQueryKey });
    // Personal tokens lists this agent's tokens as well (T-560).
    queryClient.invalidateQueries({ queryKey: myTokensQuery.queryKey });
  };

  const issue = useMutation({
    mutationFn: () =>
      api.issueAgentToken(agent.id, {
        name,
        expires_at: expiresAtFrom(expiry),
      }),
    onSuccess: (token) => {
      setCreated(token);
      setName("");
      setExpiry("never");
      invalidate();
    },
    onError: (error) => toast.error(error.message),
  });
  const revoke = useMutation({
    mutationFn: (tokenId: number) => api.revokeAgentToken(agent.id, tokenId),
    onSuccess: invalidate,
    onError: (error) => toast.error(error.message),
  });

  return (
    <section aria-label={`Tokens for ${agent.login}`} className="space-y-3">
      <h2 className="text-base font-semibold">Tokens</h2>
      {replace !== null ? (
        <LoadFailure
          message={replace}
          detail={replace}
          onRetry={() => tokens.refetch()}
          retrying={tokens.isFetching}
        />
      ) : tokens.data === undefined ? (
        <p className="text-sm text-muted-foreground">loading…</p>
      ) : (
        <>
          {notice !== null && (
            <RefreshFailure
              what={`tokens for ${agent.login}`}
              detail={notice}
              onRetry={() => tokens.refetch()}
              retrying={tokens.isFetching}
            />
          )}
          <TokenTable
            tokens={tokens.data}
            onRevoke={(token) => revoke.mutate(token.id)}
          />
        </>
      )}

      {created && <TokenReveal token={created} />}

      <form
        className="flex min-w-0 flex-col items-stretch gap-2 sm:flex-row sm:items-center"
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim()) issue.mutate();
        }}
      >
        <Label htmlFor="token-name" className="sr-only">
          Token name
        </Label>
        <Input
          id="token-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="New token name (e.g. ci)"
          className="w-full sm:w-56"
          required
        />
        <TokenExpirySelect
          value={expiry}
          onChange={setExpiry}
          className="w-full sm:w-36"
        />
        <Button
          type="submit"
          size="sm"
          className="w-full sm:w-auto"
          disabled={issue.isPending}
        >
          <PlusIcon className="size-3.5" /> Issue
        </Button>
      </form>
    </section>
  );
}
