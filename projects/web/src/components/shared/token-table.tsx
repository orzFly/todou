import type { TokenListItem } from "@todou/shared";
import { Trash2Icon } from "lucide-react";
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
  iso ? new Date(iso).toLocaleString() : "—";

/** Active-token listing shared by the personal and agent token managers. */
export function TokenTable({
  tokens,
  onRevoke,
}: {
  tokens: TokenListItem[];
  onRevoke: (id: number) => void;
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
          <TableHead>Name</TableHead>
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
            <TableCell>{token.name}</TableCell>
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
                aria-label={`revoke ${token.name}`}
                onClick={() => onRevoke(token.id)}
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
