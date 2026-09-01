import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { InboxIcon } from "lucide-react";
import { inboxQuery } from "@/api/inbox.ts";
import { Button } from "@/components/ui/button";
import { UnreadBadge } from "@/components/unread-badge.tsx";

/**
 * Navbar inbox entry (T-97). Mounted in the shell, so the inbox query lives
 * for the whole session — the badge stays current on every page, not just
 * /inbox. Its change signal is the shell's user-level stream (T-122).
 */
export function InboxButton() {
  const inbox = useQuery(inboxQuery);
  const count = inbox.data?.items.length ?? 0;
  const label = count > 0 ? `Inbox — ${count} unread` : "Inbox";

  return (
    <Button
      asChild
      variant="ghost"
      size="sm"
      className="relative"
      aria-label={label}
      title={label}
    >
      <Link to="/inbox">
        <InboxIcon />
        <UnreadBadge count={count} className="absolute top-0.5 right-0.5" />
      </Link>
    </Button>
  );
}
