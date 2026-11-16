import type { TokenListItem } from "@todou/shared";
import { Trash2Icon } from "lucide-react";
import { UserChip } from "@/components/shared/user-chip.tsx";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

const when = (iso: string | null) =>
  iso ? <time dateTime={iso}>{new Date(iso).toLocaleString()}</time> : "—";

/** Active-token listing shared by the personal and agent token managers. */
export function TokenTable({
  tokens,
  showHolder = false,
  showScopes = false,
  onRevoke,
}: {
  tokens: TokenListItem[];
  showHolder?: boolean;
  /** Only where tokens can carry scopes; an agent's never do. */
  showScopes?: boolean;
  onRevoke: (token: TokenListItem) => void;
}) {
  if (tokens.length === 0) {
    return (
      <p className="py-3 text-sm text-muted-foreground">No active tokens.</p>
    );
  }
  return (
    <Table>
      <TableHeader>
        <TableRow>
          {showHolder && <TableHead>Holder</TableHead>}
          <TableHead>Name</TableHead>
          {showScopes && <TableHead>Scopes</TableHead>}
          <TableHead>Prefix</TableHead>
          <TableHead>Created</TableHead>
          <TableHead>Last used</TableHead>
          <TableHead>Expires</TableHead>
          <TableHead className="w-12" />
        </TableRow>
      </TableHeader>
      <TableBody>
        {tokens.map((token) => (
          <TableRow key={token.id}>
            {showHolder && (
              <TableCell>
                <UserChip user={token.holder} />
              </TableCell>
            )}
            <TableCell>{token.name}</TableCell>
            {showScopes && (
              <TableCell>
                {/* Printed as sent, so a scope this build does not know
                    yet still shows up rather than vanishing. */}
                <span className="flex flex-wrap gap-1">
                  {token.scopes.map((scope) => (
                    <Badge
                      key={scope}
                      variant="outline"
                      className="font-mono font-normal"
                    >
                      {scope}
                    </Badge>
                  ))}
                </span>
              </TableCell>
            )}
            <TableCell className="font-mono text-xs">{token.prefix}…</TableCell>
            <TableCell className="text-xs text-muted-foreground">
              {when(token.created_at)}
            </TableCell>
            <TableCell className="text-xs text-muted-foreground">
              {when(token.last_used_at)}
            </TableCell>
            <TableCell className="text-xs text-muted-foreground">
              {when(token.expires_at)}
            </TableCell>
            <TableCell>
              <Button
                variant="ghost"
                size="icon-sm"
                // Two holders may each have a token called "cli".
                aria-label={
                  showHolder
                    ? `revoke ${token.name} of ${token.holder.login}`
                    : `revoke ${token.name}`
                }
                onClick={() => onRevoke(token)}
              >
                <Trash2Icon className="size-4" />
              </Button>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
