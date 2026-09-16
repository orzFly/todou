import type { UserKind, UserRef } from "@todou/shared";
import { BotIcon } from "lucide-react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

/**
 * The name to show a human for a user. `?.` is not paranoia: the client casts
 * responses instead of parsing them, so a server older than `display_name`
 * would otherwise render the string "undefined".
 */
export function displayNameOf(user: {
  display_name?: string;
  login: string;
}): string {
  return user.display_name?.trim() || user.login;
}

export function initialsOf(displayName: string): string {
  return displayName
    .split(/\s+/)
    .map((p) => p[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();
}

/**
 * Separate from UserChip so a row that lays out its own name still takes the
 * chip's avatar size from here instead of picking one of its own.
 */
export function UserAvatar({
  user,
  className,
  badge = false,
  ...props
}: {
  user: {
    display_name?: string;
    login: string;
    avatar_url?: string | null;
    kind?: UserKind;
  };
  /**
   * Mark machine users with the bot badge. Off by default: a list that holds
   * nothing but agents gains no information from it (T-236).
   */
  badge?: boolean;
} & React.ComponentProps<typeof Avatar>) {
  const avatar = (
    <Avatar
      className={cn("inline-flex size-5 align-middle", className)}
      {...props}
    >
      {user.avatar_url && <AvatarImage src={user.avatar_url} alt="" />}
      <AvatarFallback className="text-[10px]">
        {initialsOf(displayNameOf(user))}
      </AvatarFallback>
    </Avatar>
  );

  if (!badge || user.kind !== "machine") return avatar;
  // The badge is absolutely positioned, so these two offsets put it 6px past
  // the right edge and 4px past the bottom edge of the chip's own box, and
  // that overhang is not part of any element's width. A container that clips
  // has to reserve the space itself, or the badge gets cut. The board's meta
  // row reserves it from these same two numbers, in board.tsx (T-361).
  return (
    <span className="relative inline-flex align-middle">
      {avatar}
      <BotIcon
        aria-label="agent"
        className="absolute -right-1.5 -bottom-1 size-3 rounded-full bg-background text-muted-foreground"
      />
    </span>
  );
}

/**
 * Uniform user rendering across the app. Machine users get a bot badge and
 * an ownership tooltip so agents are always visually distinct from humans.
 */
export function UserChip({
  user,
  compact = false,
  showLogin = false,
  nameClassName,
}: {
  user: UserRef;
  compact?: boolean;
  /** Add the secondary `@login` — for places where two people may share a name. */
  showLogin?: boolean;
  nameClassName?: string;
}) {
  // Not a flex container, because one takes its baseline from its first flex
  // item — here the avatar. Showing an image that box has no text baseline to
  // give, so the chip sat on the line's own baseline and carried the name 5px
  // above the sentence around it, then jumped the moment the image replaced
  // the initials, which do have one. For the same reason UserAvatar's
  // `align-middle` only bites out here: a flex item would ignore it.
  const chip = (
    <span className="inline-block shrink-0 whitespace-nowrap">
      <UserAvatar user={user} badge />
      {!compact && (
        <span className={cn("ml-1.5 text-sm", nameClassName)}>
          {displayNameOf(user)}
        </span>
      )}
      {!compact && showLogin && (
        <span className="ml-1.5 text-muted-foreground text-sm">
          @{user.login}
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
