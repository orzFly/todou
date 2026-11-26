import { Button } from "@orz/ui/components/button";
import { ACT_AS_HEADER, type TokenCreated } from "@todou/shared";
import { CheckIcon, CopyIcon } from "lucide-react";
import { useState } from "react";

/** One-time plaintext display — the value is gone once the dialog closes. */
export function TokenReveal({ token }: { token: TokenCreated }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="space-y-3">
      <div
        className="rounded-md border bg-muted/40 p-3 font-mono text-sm break-all"
        data-testid="token-plaintext"
      >
        {token.token}
      </div>
      <Button
        size="sm"
        onClick={async () => {
          await navigator.clipboard.writeText(token.token);
          setCopied(true);
        }}
      >
        {copied ? (
          <>
            <CheckIcon className="size-4" /> Copied
          </>
        ) : (
          <>
            <CopyIcon className="size-4" /> Copy token
          </>
        )}
      </Button>
      {token.scopes.includes("agents:act") && (
        <p className="text-xs text-muted-foreground">
          Send <code>{ACT_AS_HEADER}: &lt;agent login&gt;</code> to act as an
          agent.
        </p>
      )}
      <p className="text-xs text-muted-foreground">
        Store it somewhere safe — only the prefix “{token.prefix}…” will be
        shown from now on.
      </p>
    </div>
  );
}
