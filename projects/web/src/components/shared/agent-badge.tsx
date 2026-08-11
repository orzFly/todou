import type { AgentContext } from "@todou/shared";
import { Badge } from "@/components/ui/badge";

/** Small provenance marker for timeline items written by an agent. */
export function AgentContextBadge({
  context,
}: {
  context: AgentContext | null | undefined;
}) {
  if (!context) return null;
  return (
    <Badge
      variant="secondary"
      className="px-1.5 py-0 text-[10px] font-normal"
      title={context.session_id ? `session ${context.session_id}` : undefined}
      data-testid="agent-context-badge"
    >
      {context.agent}
      {context.model ? ` · ${context.model}` : ""}
    </Badge>
  );
}
