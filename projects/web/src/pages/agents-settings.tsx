import {
  useMutation,
  useQuery,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query";
import type { Agent, TokenCreated } from "@todou/shared";
import { KeyIcon, PlusIcon, PowerIcon, PowerOffIcon } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { agentsQuery, api } from "@/api/queries.ts";
import { TokenReveal } from "@/components/shared/token-reveal.tsx";
import { TokenTable } from "@/components/shared/token-table.tsx";
import { UserChip } from "@/components/shared/user-chip.tsx";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

export function AgentsSettingsPage() {
  const agents = useSuspenseQuery(agentsQuery);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">Agents</h1>
          <p className="text-sm text-muted-foreground">
            Machine users you own. They authenticate with personal access tokens
            and act like regular members in projects.
          </p>
        </div>
        <CreateAgentDialog />
      </div>
      {agents.data.length === 0 ? (
        <div className="rounded-lg border border-dashed p-10 text-center text-muted-foreground">
          No agents yet. 造一个帮你挖土豆的机器人吧 🤖🥔
        </div>
      ) : (
        <div className="rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Agent</TableHead>
                <TableHead>Display name</TableHead>
                <TableHead className="w-28">State</TableHead>
                <TableHead className="w-56" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {agents.data.map((agent) => (
                <AgentRow key={agent.id} agent={agent} />
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}

function AgentRow({ agent }: { agent: Agent }) {
  const queryClient = useQueryClient();
  const disable = useMutation({
    mutationFn: () => api.disableAgent(agent.id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["agents"] });
      toast.success(`${agent.login} disabled; its tokens were revoked.`);
    },
    onError: (error) => toast.error(error.message),
  });
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

  const disabled = agent.disabled_at !== null;
  return (
    <TableRow className={disabled ? "opacity-50" : undefined}>
      <TableCell>
        <UserChip user={agent} />
      </TableCell>
      <TableCell>{agent.display_name}</TableCell>
      <TableCell>
        {disabled ? (
          <span className="text-xs text-destructive">disabled</span>
        ) : (
          <span className="text-xs text-green-600">active</span>
        )}
      </TableCell>
      <TableCell>
        <div className="flex justify-end gap-2">
          {disabled ? (
            <Button variant="outline" size="sm" onClick={() => enable.mutate()}>
              <PowerIcon className="size-3.5" /> Enable
            </Button>
          ) : (
            <>
              <AgentTokensDialog agent={agent} />
              <Button
                variant="outline"
                size="sm"
                onClick={() => disable.mutate()}
              >
                <PowerOffIcon className="size-3.5" /> Disable
              </Button>
            </>
          )}
        </div>
      </TableCell>
    </TableRow>
  );
}

function CreateAgentDialog() {
  const [open, setOpen] = useState(false);
  const [login, setLogin] = useState("");
  const [displayName, setDisplayName] = useState("");
  const queryClient = useQueryClient();

  const create = useMutation({
    mutationFn: () =>
      api.createAgent({ login, display_name: displayName || login }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["agents"] });
      setOpen(false);
      setLogin("");
      setDisplayName("");
    },
    onError: (error) => toast.error(error.message),
  });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm">
          <PlusIcon /> New agent
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New agent</DialogTitle>
          <DialogDescription>
            Creates a machine user owned by you.
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            create.mutate();
          }}
        >
          <div className="space-y-2">
            <Label htmlFor="agent-login">Login</Label>
            <Input
              id="agent-login"
              value={login}
              onChange={(e) => setLogin(e.target.value)}
              placeholder="review-bot"
              pattern="[a-z0-9][a-z0-9-]*"
              required
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="agent-display">Display name</Label>
            <Input
              id="agent-display"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="Review Bot"
            />
          </div>
          <DialogFooter>
            <Button type="submit" disabled={create.isPending}>
              Create agent
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function AgentTokensDialog({ agent }: { agent: Agent }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [created, setCreated] = useState<TokenCreated | null>(null);
  const queryClient = useQueryClient();

  const tokens = useQuery({
    queryKey: ["agent-tokens", agent.id],
    queryFn: () => api.listAgentTokens(agent.id),
    enabled: open,
  });
  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: ["agent-tokens", agent.id] });

  const issue = useMutation({
    mutationFn: () => api.issueAgentToken(agent.id, { name }),
    onSuccess: (token) => {
      setCreated(token);
      setName("");
      invalidate();
    },
    onError: (error) => toast.error(error.message),
  });
  const revoke = useMutation({
    mutationFn: (tokenId: number) => api.revokeAgentToken(agent.id, tokenId),
    onSuccess: invalidate,
    onError: (error) => toast.error(error.message),
  });

  function reset(next: boolean) {
    setOpen(next);
    if (!next) {
      // The plaintext exists only inside this dialog — closing forgets it.
      setCreated(null);
      setName("");
    }
  }

  return (
    <Dialog open={open} onOpenChange={reset}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          <KeyIcon className="size-3.5" /> Tokens
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Tokens for {agent.login}</DialogTitle>
          <DialogDescription>
            New tokens are shown exactly once — copy them before closing.
          </DialogDescription>
        </DialogHeader>

        {tokens.isPending ? (
          <p className="py-3 text-sm text-muted-foreground">loading…</p>
        ) : tokens.isError ? (
          <p className="py-3 text-sm text-destructive">
            {tokens.error.message}
          </p>
        ) : (
          <TokenTable
            tokens={tokens.data}
            onRevoke={(id) => revoke.mutate(id)}
          />
        )}

        {created && <TokenReveal token={created} />}

        <form
          className="flex items-center gap-2"
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
            className="w-56"
            required
          />
          <Button type="submit" size="sm" disabled={issue.isPending}>
            <PlusIcon className="size-3.5" /> Issue
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
