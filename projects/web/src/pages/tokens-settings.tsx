import {
  useMutation,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query";
import { Link, useSearch } from "@tanstack/react-router";
import type { TokenCreated, TokenListItem } from "@todou/shared";
import { PlusIcon } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { agentsQuery, api, meQuery, myTokensQuery } from "@/api/queries.ts";
import {
  expiresAtFrom,
  TokenExpirySelect,
} from "@/components/shared/token-expiry-select.tsx";
import { TokenReveal } from "@/components/shared/token-reveal.tsx";
import { TokenTable } from "@/components/shared/token-table.tsx";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";

type HolderFilter = "user" | "agents" | "all";

const SEGMENTS: [HolderFilter, string][] = [
  ["user", "User"],
  ["agents", "Agents"],
  ["all", "All"],
];

const DESCRIPTIONS: Record<HolderFilter, string> = {
  user:
    "Tokens act as you over the REST API — for the CLI, scripts, and " +
    "anything else that can't use a browser session.",
  agents:
    "Each token acts as its agent, not as you — what it does is recorded " +
    "under the agent's name.",
  all: "Each token acts as its holder over the REST API.",
};

/**
 * Personal access tokens for the signed-in user, and for the agents they own
 * (T-560). Revoking and issuing for an agent go through the agent token
 * endpoints, so the owner check stays where it already is.
 */
export function TokensSettingsPage() {
  const me = useSuspenseQuery(meQuery).data;
  const tokens = useSuspenseQuery(myTokensQuery).data;
  const agents = useSuspenseQuery(agentsQuery).data.filter(
    (agent) => agent.disabled_at === null,
  );
  // `strict: false` for the same shim-route reason as the Agents page.
  const { holder } = useSearch({ strict: false }) as { holder?: unknown };

  const byFilter: Record<HolderFilter, TokenListItem[]> = {
    user: tokens.filter((token) => token.holder.id === me.id),
    agents: tokens.filter((token) => token.holder.id !== me.id),
    all: tokens,
  };
  // Without agents the segments could only ever say "Agents 0".
  const hasAgents = agents.length > 0 || byFilter.agents.length > 0;
  const filter: HolderFilter =
    hasAgents && (holder === "agents" || holder === "all") ? holder : "user";

  const [issueFor, setIssueFor] = useState(String(me.id));
  const [name, setName] = useState("");
  const [expiry, setExpiry] = useState("never");
  const [created, setCreated] = useState<{
    token: TokenCreated;
    holder: string | null;
  } | null>(null);
  const queryClient = useQueryClient();
  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: myTokensQuery.queryKey });
    // The Agents page's per-agent Tokens dialog caches under this prefix.
    queryClient.invalidateQueries({ queryKey: ["agent-tokens"] });
  };

  const issue = useMutation({
    mutationFn: async () => {
      const input = { name, expires_at: expiresAtFrom(expiry) };
      const agent = agents.find((a) => String(a.id) === issueFor);
      return {
        token: agent
          ? await api.issueAgentToken(agent.id, input)
          : await api.createMyToken(input),
        holder: agent ? agent.login : null,
      };
    },
    onSuccess: (result) => {
      setCreated(result);
      setName("");
      setExpiry("never");
      invalidate();
    },
    onError: (error) => toast.error(error.message),
  });
  const revoke = useMutation({
    mutationFn: (token: TokenListItem) =>
      token.holder.id === me.id
        ? api.revokeMyToken(token.id)
        : api.revokeAgentToken(token.holder.id, token.id),
    onSuccess: invalidate,
    onError: (error) => toast.error(error.message),
  });

  const seg = (selected: boolean) =>
    cn(
      "flex h-8 items-center gap-1.5 border-l px-2.5 text-sm first:border-l-0",
      selected
        ? "bg-muted font-semibold text-foreground"
        : "text-muted-foreground hover:text-foreground",
    );

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold">Personal access tokens</h1>
        <p className="text-sm text-muted-foreground">
          {DESCRIPTIONS[filter] ?? DESCRIPTIONS.user}
        </p>
      </div>

      <form
        className="flex flex-wrap items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim()) issue.mutate();
        }}
      >
        {agents.length > 0 && (
          <Select value={issueFor} onValueChange={setIssueFor}>
            <SelectTrigger className="w-44" aria-label="Issue for">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={String(me.id)}>You (@{me.login})</SelectItem>
              {agents.map((agent) => (
                <SelectItem key={agent.id} value={String(agent.id)}>
                  @{agent.login}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Token name (e.g. cli, ci)"
          className="w-56"
          required
        />
        <TokenExpirySelect value={expiry} onChange={setExpiry} />
        <Button type="submit" size="sm" disabled={issue.isPending}>
          <PlusIcon className="size-3.5" /> Issue token
        </Button>
      </form>

      {hasAgents && (
        <div className="inline-flex overflow-hidden rounded-md border">
          {SEGMENTS.map(([value, label]) => (
            <Link
              key={value}
              to="/settings/tokens"
              search={value === "user" ? {} : { holder: value }}
              // Exact, or User ({}) would match every holder as a subset.
              activeOptions={{ exact: true }}
              // The router compares against the raw URL, so an unknown
              // ?holder= would leave no segment current while User is shown.
              aria-current={filter === value ? "page" : undefined}
              className={seg(filter === value)}
            >
              {label} {(byFilter[value] ?? []).length}
            </Link>
          ))}
        </div>
      )}

      <div className="rounded-lg border">
        <TokenTable
          tokens={byFilter[filter] ?? byFilter.user}
          showHolder={filter !== "user"}
          onRevoke={(token) => revoke.mutate(token)}
        />
      </div>

      <Dialog
        open={created !== null}
        onOpenChange={(open) => {
          if (!open) setCreated(null);
        }}
      >
        <DialogContent aria-describedby={undefined}>
          <DialogHeader>
            <DialogTitle>
              {created?.holder
                ? `Token created for @${created.holder}`
                : "Token created"}
            </DialogTitle>
          </DialogHeader>
          {created && <TokenReveal token={created.token} />}
        </DialogContent>
      </Dialog>
    </div>
  );
}
