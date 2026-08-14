import type { AgentContext } from "@todou/shared";
import { Bot } from "lucide-react";
import type { CSSProperties } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { harnessMeta } from "@/lib/harness";
import { cn } from "@/lib/utils";

/* FNV-1a over the full session id: one-char differences must land on
   unrelated colors, and this must match across page loads (no Math.random). */
function fnv1a(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/* Three independent 10-bit hash slices → hues, plus blob anchor positions.
   The second FNV stream (reversed input) keeps the third hue and the anchors
   uncorrelated with the first two slices. L/C live in styles.css per theme. */
function sessionStyle(sessionId: string): CSSProperties {
  const h1 = fnv1a(sessionId);
  const h2 = fnv1a(`${[...sessionId].reverse().join("")}#2`);
  const px = 20 + (h2 & 63);
  const py = 20 + ((h2 >>> 6) & 63);
  return {
    "--agent-h1": ((h1 & 1023) * 360) / 1024,
    "--agent-h2": (((h1 >>> 10) & 1023) * 360) / 1024,
    "--agent-h3": (((h2 >>> 4) & 1023) * 360) / 1024,
    "--agent-bx1": `${px}%`,
    "--agent-by1": py > 50 ? "15%" : "85%",
    "--agent-bx2": `${100 - px}%`,
    "--agent-by2": `${py}%`,
  } as CSSProperties;
}

/* The mark is decorative — the badge spells the harness out in text beside it.
   `title=""` is what removes the brand <title> the upstream SVG ships with
   (vite.config.ts makes it a prop for exactly this); left in, it would join the
   badge's textContent and shadow the badge's own tooltip. */
function HarnessIcon({ agent }: { agent: string }) {
  const Logo = harnessMeta(agent)?.logo;
  if (!Logo) return <Bot aria-hidden data-testid="harness-icon-unknown" />;
  return <Logo aria-hidden title="" data-testid={`harness-icon-${agent}`} />;
}

/**
 * Small provenance marker for timeline items written by an agent.
 * With a session id the badge is a button that copies the resume command.
 */
export function AgentContextBadge({
  context,
  className,
}: {
  context: AgentContext | null | undefined;
  className?: string;
}) {
  if (!context) return null;
  const sessionId = context.session_id;
  const content = (
    <>
      <HarnessIcon agent={context.agent} />
      <span className="min-w-0 truncate">{context.model ?? context.agent}</span>
    </>
  );
  // Badge's base class pins shrink-0; in narrow flex rows (comment and
  // body headers on phones) the badge is the only member allowed to give
  // way, else the row's fixed items push the edit button off-screen and
  // the whole page gains a horizontal scrollbar.
  const baseClass = cn(
    "min-w-0 px-1.5 py-0 text-[10px] font-normal max-sm:shrink",
    className,
  );

  if (!sessionId) {
    return (
      <Badge
        variant="secondary"
        className={baseClass}
        title={context.agent}
        data-testid="agent-context-badge"
      >
        {content}
      </Badge>
    );
  }

  const resume = harnessMeta(context.agent)?.resume;
  const copyText = resume ? resume(sessionId) : sessionId;
  const copyLabel = resume ? "the resume command" : "the session id";
  return (
    <Badge
      variant="secondary"
      asChild
      className={cn(baseClass, "agent-session-badge cursor-pointer")}
    >
      <button
        type="button"
        style={sessionStyle(sessionId)}
        title={`${context.agent} · session ${sessionId} — click to copy ${copyLabel}`}
        onClick={async (e) => {
          // The badge sits inside timeline rows with their own click targets.
          e.stopPropagation();
          try {
            await navigator.clipboard.writeText(copyText);
            toast.success(`Copied "${copyText}"`);
          } catch {
            toast.error("Clipboard is unavailable in this browser");
          }
        }}
        data-testid="agent-context-badge"
      >
        {content}
      </button>
    </Badge>
  );
}
