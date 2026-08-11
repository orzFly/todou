import type { AgentContext } from "@todou/shared";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

/** Small provenance marker for timeline items written by an agent. */
export function AgentContextBadge({
  context,
  className,
}: {
  context: AgentContext | null | undefined;
  className?: string;
}) {
  if (!context) return null;
  return (
    <Badge
      variant="secondary"
      className={cn(
        "min-w-0 px-1.5 py-0 text-[10px] font-normal text-muted-foreground",
        className,
      )}
      title={context.session_id ? `session ${context.session_id}` : undefined}
      data-testid="agent-context-badge"
    >
      <span className="min-w-0 truncate">
        {context.agent}
        {context.model ? ` · ${context.model}` : ""}
      </span>
    </Badge>
  );
}
