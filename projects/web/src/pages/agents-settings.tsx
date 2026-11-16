import {
  useMutation,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import type { Agent } from "@todou/shared";
import {
  ChevronRightIcon,
  PlusIcon,
  PowerIcon,
  PowerOffIcon,
} from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { agentsQuery, api } from "@/api/queries.ts";
import {
  AgentProjectsNotice,
  AgentProjectsSummary,
} from "@/components/shared/agent-projects.tsx";
import { UserChip } from "@/components/shared/user-chip.tsx";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";

type AgentSegment = "active" | "deactivated";

export function AgentsSettingsPage() {
  const agents = useSuspenseQuery(agentsQuery);
  // `strict: false` because the tests mount this page under a shim route tree
  // where a `from:` path does not exist (same reason as cli-auth / login).
  const search = useSearch({ strict: false }) as Record<string, unknown>;
  const navigate = useNavigate();
  const segment: AgentSegment =
    search.state === "deactivated" ? "deactivated" : "active";

  const active = agents.data.filter((a) => a.disabled_at === null);
  const deactivated = agents.data.filter((a) => a.disabled_at !== null);
  const shown = segment === "active" ? active : deactivated;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">Agents</h1>
        </div>
        <CreateAgentDialog />
      </div>
      {agents.data.length === 0 ? (
        <div className="rounded-lg border border-dashed p-10 text-center text-muted-foreground">
          No agents yet. Build one to help dig the potatoes 🤖🥔
        </div>
      ) : (
        <div className="space-y-4">
          <AgentStateSegment
            counts={{ active: active.length, deactivated: deactivated.length }}
            active={segment}
            onSelect={(next) =>
              navigate({
                to: ".",
                // Active is the default, so it maps to a clean URL.
                search: next === "active" ? {} : { state: "deactivated" },
                // Flipping a segment is a view state, not a place to go back to.
                replace: true,
              })
            }
          />
          {shown.length === 0 ? (
            <div className="rounded-lg border border-dashed p-10 text-center text-muted-foreground">
              {segment === "deactivated"
                ? "No deactivated agents. Disabling an agent revokes its tokens and moves it here."
                : "No active agents."}
            </div>
          ) : (
            <>
              <AgentProjectsNotice />
              <div className="rounded-lg border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-[45%]">Agent</TableHead>
                      <TableHead>Projects</TableHead>
                      <TableHead className="w-10" />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {shown.map((agent) => (
                      <AgentRow key={agent.id} agent={agent} />
                    ))}
                  </TableBody>
                </Table>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function AgentStateSegment({
  counts,
  active,
  onSelect,
}: {
  counts: { active: number; deactivated: number };
  active: AgentSegment;
  onSelect: (segment: AgentSegment) => void;
}) {
  const seg = (selected: boolean) =>
    cn(
      "flex h-8 cursor-pointer items-center gap-1.5 border-l px-2.5 text-sm first:border-l-0",
      selected
        ? "bg-muted font-semibold text-foreground"
        : "text-muted-foreground hover:text-foreground",
    );
  return (
    <div className="inline-flex overflow-hidden rounded-md border">
      <button
        type="button"
        className={seg(active === "active")}
        onClick={() => onSelect("active")}
      >
        <PowerIcon className="size-4" />
        Active {counts.active}
      </button>
      <button
        type="button"
        className={seg(active === "deactivated")}
        onClick={() => onSelect("deactivated")}
      >
        <PowerOffIcon className="size-4" />
        Deactivated {counts.deactivated}
      </button>
    </div>
  );
}

/**
 * The whole row goes to the agent's page. Only the first cell's link is in
 * the tab order and the accessibility tree; the other two are the same
 * destination, there so that a click or a middle-click anywhere on the row
 * behaves like one on a link.
 */
function AgentRow({ agent }: { agent: Agent }) {
  const to = "/settings/agents/$login";
  const params = { login: agent.login };
  const cellLink = "flex min-h-12 items-center px-2 py-2";
  return (
    <TableRow>
      <TableCell className="p-0">
        <Link to={to} params={params} className={cellLink}>
          <UserChip user={agent} showLogin link={false} />
        </Link>
      </TableCell>
      <TableCell className="max-w-0 p-0">
        <Link
          to={to}
          params={params}
          className={cellLink}
          tabIndex={-1}
          aria-hidden
        >
          <AgentProjectsSummary agent={agent} />
        </Link>
      </TableCell>
      <TableCell className="p-0">
        <Link
          to={to}
          params={params}
          className={cn(cellLink, "justify-end text-muted-foreground")}
          tabIndex={-1}
          aria-hidden
        >
          <ChevronRightIcon className="size-4" />
        </Link>
      </TableCell>
    </TableRow>
  );
}

function CreateAgentDialog() {
  const [open, setOpen] = useState(false);
  const [login, setLogin] = useState("");
  const [displayName, setDisplayName] = useState("");
  const queryClient = useQueryClient();

  const create = useMutation({
    mutationFn: () =>
      api.createAgent({ login, display_name: displayName || login }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["agents"] });
      setOpen(false);
      setLogin("");
      setDisplayName("");
    },
    onError: (error) => toast.error(error.message),
  });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm">
          <PlusIcon /> New agent
        </Button>
      </DialogTrigger>
      <DialogContent aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle>New agent</DialogTitle>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            create.mutate();
          }}
        >
          <div className="space-y-2">
            <Label htmlFor="agent-login">Login</Label>
            <Input
              id="agent-login"
              value={login}
              onChange={(e) => setLogin(e.target.value)}
              placeholder="review-bot"
              pattern="[a-z0-9][a-z0-9-]*"
              required
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="agent-display">Display name</Label>
            <Input
              id="agent-display"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="Review Bot"
            />
          </div>
          <DialogFooter>
            <Button type="submit" disabled={create.isPending}>
              Create agent
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
