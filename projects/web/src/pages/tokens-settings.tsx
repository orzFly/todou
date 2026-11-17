import {
  useMutation,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query";
import { Link, useSearch } from "@tanstack/react-router";
import {
  TOKEN_SCOPES,
  type TokenCreated,
  type TokenListItem,
  type TokenScope,
} from "@todou/shared";
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
import { displayNameOf } from "@/components/shared/user-chip.tsx";
import {
  UserPicker,
  UserSelectTrigger,
} from "@/components/shared/user-picker.tsx";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
 * What each scope grants, the one thing its name does not say. Iterated in
 * `TOKEN_SCOPES` order, so a new scope only needs its line here.
 */
function scopeDescription(scope: TokenScope): string {
  switch (scope) {
    case "agents:act":
      return "Make requests as one of your agents by sending x-todou-act-as.";
    case "agents:create":
      return "Create the agent you name, owned by you, if no account has that login yet.";
    default:
      return "";
  }
}

/**
 * Creating an agent is only reachable by acting as it, so the two move
 * together: one ticks the other on, the other takes it off.
 */
function toggleScope(
  current: TokenScope[],
  scope: TokenScope,
  on: boolean,
): TokenScope[] {
  const next = new Set(current);
  if (on) {
    next.add(scope);
    if (scope === "agents:create") next.add("agents:act");
  } else {
    next.delete(scope);
    if (scope === "agents:act") next.delete("agents:create");
  }
  return TOKEN_SCOPES.filter((s) => next.has(s));
}

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
  const holderPicked = [me, ...agents].find((u) => String(u.id) === issueFor);
  const [expiry, setExpiry] = useState("never");
  const [scopes, setScopes] = useState<TokenScope[]>([]);
  const issuingForMe = issueFor === String(me.id);
  const [created, setCreated] = useState<{
    token: TokenCreated;
    holder: string | null;
  } | null>(null);
  const queryClient = useQueryClient();
  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: myTokensQuery.queryKey });
    // Each agent's page lists its tokens under this prefix.
    queryClient.invalidateQueries({ queryKey: ["agent-tokens"] });
  };

  const issue = useMutation({
    mutationFn: async () => {
      const input = { name, expires_at: expiresAtFrom(expiry) };
      const agent = agents.find((a) => String(a.id) === issueFor);
      return {
        token: agent
          ? await api.issueAgentToken(agent.id, input)
          : await api.createMyToken({ ...input, scopes }),
        holder: agent ? agent.login : null,
      };
    },
    onSuccess: (result) => {
      setCreated(result);
      setName("");
      setExpiry("never");
      setScopes([]);
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
    <div className="space-y-10">
      <section className="space-y-4">
        <div>
          <h1 className="text-xl font-semibold">Personal access tokens</h1>
          <p className="text-sm text-muted-foreground">
            {DESCRIPTIONS[filter] ?? DESCRIPTIONS.user}
          </p>
        </div>

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
            showScopes
            onRevoke={(token) => revoke.mutate(token)}
          />
        </div>
      </section>

      <section className="space-y-4" aria-labelledby="new-token-heading">
        <h2 id="new-token-heading" className="text-lg font-semibold">
          New token
        </h2>
        <form
          className="max-w-xl space-y-5"
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim()) issue.mutate();
          }}
        >
          <div className="grid gap-4 sm:grid-cols-2">
            {agents.length > 0 && (
              <div className="space-y-2 sm:col-span-2">
                <Label asChild>
                  <span>Issue for</span>
                </Label>
                <UserPicker
                  users={[me, ...agents]}
                  selectedIds={[Number(issueFor)]}
                  onPick={(user) => {
                    if (user === null) return;
                    setIssueFor(String(user.id));
                    // An agent's token can never carry scopes.
                    if (user.id !== me.id) setScopes([]);
                  }}
                  trigger={
                    <UserSelectTrigger
                      user={holderPicked}
                      placeholder="Issue for"
                      className="w-full sm:w-64"
                      aria-label={`Issue for ${displayNameOf(holderPicked ?? me)}`}
                    />
                  }
                />
              </div>
            )}
            <div className="space-y-2">
              <Label htmlFor="new-token-name">Name</Label>
              <Input
                id="new-token-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Token name (e.g. cli, ci)"
                required
              />
            </div>
            <div className="space-y-2">
              <Label asChild>
                <span>Expiration</span>
              </Label>
              <TokenExpirySelect
                value={expiry}
                onChange={setExpiry}
                className="w-full"
              />
            </div>
          </div>

          {issuingForMe && (
            <fieldset className="space-y-2">
              <legend className="mb-2 text-sm font-medium">Scopes</legend>
              <div className="divide-y rounded-lg border">
                {TOKEN_SCOPES.map((scope) => (
                  <label
                    key={scope}
                    htmlFor={`scope-${scope}-box`}
                    className="flex cursor-pointer items-start gap-3 px-3 py-2.5 hover:bg-muted/40"
                  >
                    {/* The margin sits outside the box: on the input itself
                        it would push the box off its own tick. */}
                    <span className="mt-0.5 flex">
                      <Checkbox
                        id={`scope-${scope}-box`}
                        aria-labelledby={`scope-${scope}`}
                        aria-describedby={`scope-${scope}-grants`}
                        checked={scopes.includes(scope)}
                        onChange={(e) =>
                          setScopes(
                            toggleScope(scopes, scope, e.target.checked),
                          )
                        }
                      />
                    </span>
                    <span className="min-w-0 space-y-0.5">
                      <span
                        id={`scope-${scope}`}
                        className="block font-mono text-sm"
                      >
                        {scope}
                      </span>
                      <span
                        id={`scope-${scope}-grants`}
                        className="block text-sm text-muted-foreground"
                      >
                        {scopeDescription(scope)}
                      </span>
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>
          )}

          <Button type="submit" size="sm" disabled={issue.isPending}>
            <PlusIcon className="size-3.5" /> Issue token
          </Button>
        </form>
      </section>

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
