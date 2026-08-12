import type { UserRef } from "@todou/shared";
import { BotIcon } from "lucide-react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

export function initialsOf(displayName: string): string {
  return displayName
    .split(/\s+/)
    .map((p) => p[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();
}

/**
 * Uniform user rendering across the app. Machine users get a bot badge and
 * an ownership tooltip so agents are always visually distinct from humans.
 */
export function UserChip({
  user,
  compact = false,
  nameClassName,
}: {
  user: UserRef;
  compact?: boolean;
  nameClassName?: string;
}) {
  const initials = initialsOf(user.display_name);

  const chip = (
    <span className="inline-flex shrink-0 items-center gap-1.5">
      <span className="relative inline-flex">
        <Avatar className="size-5">
          {user.avatar_url && <AvatarImage src={user.avatar_url} alt="" />}
          <AvatarFallback className="text-[10px]">{initials}</AvatarFallback>
        </Avatar>
        {user.kind === "machine" && (
          <BotIcon
            aria-label="agent"
            className="absolute -right-1.5 -bottom-1 size-3 rounded-full bg-background text-muted-foreground"
          />
        )}
      </span>
      {!compact && (
        <span className={cn("text-sm whitespace-nowrap", nameClassName)}>
          {user.login}
        </span>
      )}
    </span>
  );

  if (user.kind !== "machine") return chip;
  return (
    <TooltipProvider delayDuration={300}>
      <Tooltip>
        <TooltipTrigger asChild>{chip}</TooltipTrigger>
        <TooltipContent>
          agent{user.owner ? ` · belongs to @${user.owner.login}` : ""}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
