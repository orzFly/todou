import { Button } from "@orz/ui/components/button";
import type { Agent } from "@todou/shared";
import { PlusIcon } from "lucide-react";
import { displayNameOf } from "@/components/shared/user-chip.tsx";
import { UserPicker } from "@/components/shared/user-picker.tsx";

/**
 * Picks an agent to add to a project (T-228), through the shared user picker.
 *
 * The candidate filtering lives here rather than in the caller so the component
 * can tell "you own no agents" (render nothing) apart from "they are all
 * members already" (say so), which are different things to say.
 */
export function AddAgentPicker({
  agents,
  memberIds,
  onAdd,
  busy = false,
  defaultOpen = false,
}: {
  /** Every agent the viewer owns, unfiltered. */
  agents: Agent[];
  /** User ids already on the project. */
  memberIds: ReadonlySet<number>;
  onAdd: (agent: Agent) => void;
  /** A write is pending or unavailable: disable the trigger and choices. */
  busy?: boolean;
  /** Test-only, as on LabelPicker. */
  defaultOpen?: boolean;
}) {
  if (agents.length === 0) return null;

  // listAgents has no ORDER BY, so without this the rows come back in whatever
  // order the database felt like.
  const candidates = agents
    .filter((a) => !memberIds.has(a.id) && a.disabled_at === null)
    .sort((a, b) => displayNameOf(a).localeCompare(displayNameOf(b)));

  return (
    <UserPicker
      users={candidates}
      selectedIds={[]}
      onPick={(agent) => {
        if (agent !== null) onAdd(agent);
      }}
      // Stays open on purpose: whoever needs a search box here has enough
      // agents that they are likely adding more than one.
      multiple
      // Every row is an agent, so the badge would say nothing (T-236); and a
      // pick adds rather than selects, so nothing stays checked.
      badge={false}
      check={false}
      busy={busy}
      noun="agents"
      empty="Every agent you own is already a member."
      defaultOpen={defaultOpen}
      trigger={
        <Button
          variant="outline"
          size="sm"
          aria-haspopup="listbox"
          disabled={busy}
        >
          <PlusIcon className="size-3.5" /> Add agent
        </Button>
      }
    />
  );
}
