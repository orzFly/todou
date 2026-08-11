import type { TokenCreated } from "@todou/shared";
import { CheckIcon, CopyIcon } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";

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
      <p className="text-xs text-muted-foreground">
        Store it somewhere safe — only the prefix “{token.prefix}…” will be
        shown from now on.
      </p>
    </div>
  );
}
