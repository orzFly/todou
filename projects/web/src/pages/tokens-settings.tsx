import {
  queryOptions,
  useMutation,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query";
import type { TokenCreated } from "@todou/shared";
import { PlusIcon } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { api } from "@/api/queries.ts";
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
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";

export const myTokensQuery = queryOptions({
  queryKey: ["my-tokens"],
  queryFn: () => api.listMyTokens(),
});

/** Personal access tokens for the signed-in user (human or not). */
export function TokensSettingsPage() {
  const tokens = useSuspenseQuery(myTokensQuery);
  const [name, setName] = useState("");
  const [expiry, setExpiry] = useState("never");
  const [created, setCreated] = useState<TokenCreated | null>(null);
  const queryClient = useQueryClient();
  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: ["my-tokens"] });

  const issue = useMutation({
    mutationFn: () =>
      api.createMyToken({ name, expires_at: expiresAtFrom(expiry) }),
    onSuccess: (token) => {
      setCreated(token);
      setName("");
      setExpiry("never");
      invalidate();
    },
    onError: (error) => toast.error(error.message),
  });
  const revoke = useMutation({
    mutationFn: (id: number) => api.revokeMyToken(id),
    onSuccess: invalidate,
    onError: (error) => toast.error(error.message),
  });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold">Personal access tokens</h1>
        <p className="text-sm text-muted-foreground">
          Tokens act as you over the REST API (`Authorization: Bearer …`) — for
          the CLI, scripts, and anything else that can't use a browser session.
        </p>
      </div>

      <form
        className="flex items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim()) issue.mutate();
        }}
      >
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

      <div className="rounded-lg border">
        <TokenTable tokens={tokens.data} onRevoke={(id) => revoke.mutate(id)} />
      </div>

      <Dialog
        open={created !== null}
        onOpenChange={(open) => {
          if (!open) setCreated(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Token created</DialogTitle>
            <DialogDescription>
              Shown exactly once — copy it before closing.
            </DialogDescription>
          </DialogHeader>
          {created && <TokenReveal token={created} />}
        </DialogContent>
      </Dialog>
    </div>
  );
}
