import type { Agent, Me } from "@todou/shared";
import { Login } from "@todou/shared";
import { PlusIcon } from "lucide-react";
import { useState } from "react";
import { displayNameOf, UserChip } from "@/components/shared/user-chip.tsx";
import { Input } from "@/components/ui/input";

/**
 * "Which of my accounts is this for?" — asked by `todou login`'s two
 * authorization flows and by the access-request page (T-280).
 *
 * The candidates are only ever accounts the viewer holds: the agents they
 * own, plus themselves wherever the flow hands over `me`. That is not a UI
 * simplification but the whole security argument of the access page — a link
 * may suggest a login, and the account the write lands on still comes from
 * this list. `todou login` offers the viewer themselves, because minting a
 * token for your own machine is what that page is for; the access-request
 * page passes no `me`, so a grant there never lands on whoever opened it
 * (T-301).
 */

/** Who the minted token, or the new membership, will belong to. */
export type AuthTarget =
  | { kind: "me" }
  | { kind: "agent"; id: number }
  | { kind: "new"; login: string };

export type Selection =
  | { kind: "me" }
  | { kind: "agent"; id: number }
  | { kind: "new" }
  | null;

const LAST_AGENT_KEY = "todou.cli-auth.last-agent";

/** localStorage can be unavailable (private mode, blocked storage). */
export function readLastAgentId(): number | null {
  try {
    const id = Number(window.localStorage.getItem(LAST_AGENT_KEY));
    return Number.isInteger(id) && id > 0 ? id : null;
  } catch {
    return null;
  }
}

export function rememberLastAgent(id: number): void {
  try {
    window.localStorage.setItem(LAST_AGENT_KEY, String(id));
  } catch {
    // Best-effort — the next authorization just won't be preselected.
  }
}

/**
 * The last authorized agent wins, then a sole agent; among several with no
 * history the user must pick explicitly. No agents at all lands on the
 * create form — the common case when setting up a brand-new machine.
 */
export function defaultSelection(
  agents: Agent[],
  lastAgentId: number | null,
): Selection {
  if (agents.length === 0) return { kind: "new" };
  if (lastAgentId !== null && agents.some((a) => a.id === lastAgentId)) {
    return { kind: "agent", id: lastAgentId };
  }
  return agents.length === 1 ? { kind: "agent", id: agents[0].id } : null;
}

/**
 * Picking who gets the token is the same question in every flow.
 *
 * `initial` overrides the default rule for a flow that knows better: the
 * access page is told which account hit the wall, and has no create form for
 * `defaultSelection`'s no-agents fallback to land on.
 */
export function useTargetSelection(
  agents: Agent[],
  lastAgentId: number | null,
  initial?: Selection,
) {
  // Disabled agents cannot receive tokens (the server refuses), so they are
  // not offered at all.
  const candidates = agents.filter((a) => a.disabled_at === null);
  const [selection, setSelection] = useState<Selection>(() =>
    initial === undefined ? defaultSelection(candidates, lastAgentId) : initial,
  );
  const [newLogin, setNewLogin] = useState("");
  const newLoginValid = Login.safeParse(newLogin).success;
  const target: AuthTarget | null =
    selection === null
      ? null
      : selection.kind !== "new"
        ? selection
        : newLoginValid
          ? { kind: "new", login: newLogin }
          : null;
  return {
    candidates,
    selection,
    setSelection,
    newLogin,
    setNewLogin,
    newLoginValid,
    target,
  };
}

export type TargetSelection = ReturnType<typeof useTargetSelection>;

const rowClass =
  "flex cursor-pointer items-center gap-3 px-3 py-2.5 hover:bg-muted/50 has-[:checked]:bg-muted";

export function AuthTargetFieldset({
  /** Left out where the viewer may not be the target at all (T-301). */
  me,
  picker,
  legend = "Authorize as",
  /** Left out where creating an account is not part of the flow (T-280). */
  allowNew = true,
}: {
  me?: Me;
  picker: TargetSelection;
  legend?: string;
  allowNew?: boolean;
}) {
  const { candidates, selection, setSelection, newLogin, setNewLogin } = picker;
  return (
    <fieldset>
      <legend className="mb-2 text-sm font-medium">{legend}</legend>
      <div className="divide-y overflow-hidden rounded-lg border">
        {candidates.map((agent) => (
          <label key={agent.id} className={rowClass}>
            <input
              type="radio"
              name="cli-auth-target"
              className="accent-primary"
              aria-label={`${displayNameOf(agent)} @${agent.login}`}
              checked={selection?.kind === "agent" && selection.id === agent.id}
              onChange={() => setSelection({ kind: "agent", id: agent.id })}
            />
            <UserChip user={agent} />
            {/* Which account a token ends up belonging to is the whole
                question on this page, so the login is never optional. */}
            <span className="truncate text-sm text-muted-foreground">
              @{agent.login}
            </span>
          </label>
        ))}
        {allowNew ? (
          <label className={rowClass}>
            <input
              type="radio"
              name="cli-auth-target"
              className="accent-primary"
              aria-label="New agent"
              checked={selection?.kind === "new"}
              onChange={() => setSelection({ kind: "new" })}
            />
            <span className="inline-flex items-center gap-1.5 text-sm whitespace-nowrap">
              <PlusIcon className="size-4 text-muted-foreground" aria-hidden />
              New agent
            </span>
            <Input
              value={newLogin}
              onChange={(e) => {
                setNewLogin(e.target.value);
                setSelection({ kind: "new" });
              }}
              onFocus={() => setSelection({ kind: "new" })}
              placeholder="agent-login"
              aria-label="New agent login"
              className="h-7 flex-1"
              maxLength={64}
            />
          </label>
        ) : null}
        {me === undefined ? null : (
          <label className={rowClass}>
            <input
              type="radio"
              name="cli-auth-target"
              className="accent-primary"
              aria-label={`${displayNameOf(me)} (yourself)`}
              checked={selection?.kind === "me"}
              onChange={() => setSelection({ kind: "me" })}
            />
            <UserChip user={me} />
            <span className="text-sm text-muted-foreground">yourself</span>
          </label>
        )}
      </div>
      {selection?.kind === "new" && newLogin !== "" && !picker.newLoginValid ? (
        <p className="mt-1.5 text-xs text-destructive">
          Logins are lowercase letters, digits, and dashes.
        </p>
      ) : null}
    </fieldset>
  );
}
