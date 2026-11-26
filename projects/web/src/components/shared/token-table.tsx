import { Badge } from "@orz/ui/components/badge";
import { Button } from "@orz/ui/components/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@orz/ui/components/table";
import type { TokenListItem } from "@todou/shared";
import { Trash2Icon } from "lucide-react";
import { UserChip } from "@/components/shared/user-chip.tsx";

const when = (iso: string | null) =>
  iso ? <time dateTime={iso}>{new Date(iso).toLocaleString()}</time> : "—";

/*
 * Below @xl the table cannot fit its columns (a 390px phone showed Name and
 * Prefix, then cut Created in half and hid revoke), so each row restacks into
 * an entry: the cells run down the left, revoke stays top right, and the
 * header row is hidden — so the date cells name themselves. One DOM for both
 * shapes keeps every row, cell and button name the same.
 */
const narrowRow =
  "@max-xl:grid @max-xl:grid-cols-[1fr_auto] @max-xl:gap-x-3 @max-xl:gap-y-1 @max-xl:px-3 @max-xl:py-2.5";
const narrowCell = "@max-xl:col-start-1 @max-xl:p-0 @max-xl:whitespace-normal";
const narrowMeta = `${narrowCell} @max-xl:before:mr-1.5 @max-xl:before:text-foreground/70`;

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
    <div className="@container">
      <Table className="@max-xl:block">
        <TableHeader className="@max-xl:hidden">
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
        <TableBody className="@max-xl:block">
          {tokens.map((token) => (
            <TableRow key={token.id} className={narrowRow}>
              {showHolder && (
                <TableCell className={narrowCell}>
                  <UserChip user={token.holder} />
                </TableCell>
              )}
              <TableCell className={`${narrowCell} @max-xl:font-medium`}>
                {token.name}
              </TableCell>
              {showScopes && (
                <TableCell className={`${narrowCell} @max-xl:empty:hidden`}>
                  {/* Printed as sent, so a scope this build does not know
                    yet still shows up rather than vanishing. */}
                  {token.scopes.length > 0 && (
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
                  )}
                </TableCell>
              )}
              <TableCell className={`${narrowCell} font-mono text-xs`}>
                {token.prefix}…
              </TableCell>
              <TableCell
                className={`${narrowMeta} text-xs text-muted-foreground @max-xl:before:content-['Created']`}
              >
                {when(token.created_at)}
              </TableCell>
              <TableCell
                className={`${narrowMeta} text-xs text-muted-foreground @max-xl:before:content-['Last_used']`}
              >
                {when(token.last_used_at)}
              </TableCell>
              <TableCell
                className={`${narrowMeta} text-xs text-muted-foreground @max-xl:before:content-['Expires']`}
              >
                {when(token.expires_at)}
              </TableCell>
              <TableCell className="@max-xl:col-start-2 @max-xl:row-start-1 @max-xl:p-0">
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
    </div>
  );
}
