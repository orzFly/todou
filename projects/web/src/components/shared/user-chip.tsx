import { Link } from "@tanstack/react-router";
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
 * What a second line has to be indented by to start under a chip's name
 * instead of under its avatar: the `ps-5` the chip reserves for the avatar
 * plus the `ml-1.5` in front of the name. It lives beside those two rather
 * than beside the header that indents by it (T-445), because nothing in that
 * second line holds it in place — resize the avatar without moving this and
 * the two lines go ragged with no other symptom.
 */
export const USER_CHIP_NAME_INDENT = "1.625rem";

/**
 * Uniform user rendering across the app. Machine users get a bot badge and
 * an ownership tooltip so agents are always visually distinct from humans.
 */
export function UserChip({
  user,
  compact = false,
  showLogin = false,
  nameClassName,
  link = true,
}: {
  user: UserRef;
  compact?: boolean;
  /** Add the secondary `@login` — for places where two people may share a name. */
  showLogin?: boolean;
  nameClassName?: string;
  /**
   * Defaults on: the user page was reachable from nothing but an @mention
   * before it did, and a display that quietly forgets to link is an omission
   * nobody ever notices (T-391). Turn it off where the chip only echoes a
   * control's current value — inside a `DropdownMenuItem`, a `<label>`
   * carrying a radio, or a `<button>` — because there an anchor either
   * steals the click the control wanted or is invalid content outright.
   */
  link?: boolean;
}) {
  const body = (
    <>
      {compact ? (
        <UserAvatar user={user} badge />
      ) : (
        // Out of flow, so that the chip's box is the name's line box and
        // nothing else. In flow the avatar decided two things it has no
        // business deciding: `align-middle` put its centre half an x-height
        // above the baseline, 1.3px below the centre of the name beside it,
        // and its 20px box made the chip taller than the text, which is what
        // carried a comment header's baseline 2px off where the header's own
        // text puts it (T-487). Centred here against that box, so the rule is
        // "the avatar's centre is the name's centre" and not an offset that
        // happens to come out right at one font size.
        <span className="absolute inset-y-0 start-0 flex items-center">
          <UserAvatar user={user} badge />
        </span>
      )}
      {!compact && (
        // Everything the chip is willing to lose, in one box that clips
        // (T-486). The clip is here and not on the chip because the chip also
        // holds the avatar, whose badge hangs outside its box on purpose: a
        // chip that clipped would be clipping that badge, and T-416 grades the
        // badge against the event row's summary span by walking out from it to
        // the first box that clips. Nothing hangs out of this one, so it needs
        // no clip margin either.
        <span className="block overflow-clip text-ellipsis">
          <span className={cn("ml-1.5 text-sm", nameClassName)}>
            {displayNameOf(user)}
          </span>
          {showLogin && (
            <span className="ml-1.5 text-muted-foreground text-sm">
              @{user.login}
            </span>
          )}
        </span>
      )}
    </>
  );

  // Not a flex container, because one takes its baseline from its first flex
  // item — here the avatar. Showing an image that box has no text baseline to
  // give, so the chip sat on the line's own baseline and carried the name 5px
  // above the sentence around it, then jumped the moment the image replaced
  // the initials, which do have one.
  //
  // The anchor takes these classes rather than sitting outside them: the chip
  // is a flex item in the comment header, the event row and the board's meta
  // row, and wrapping it would hand that slot to an element with rules of its
  // own, in exactly the dense rows the chip is used in.
  //
  // Whether the chip may narrow is decided by whether it has anything to give
  // up. Only an avatar, and it is 20px of pure identity: `shrink-0`, because a
  // dense row squeezing that buys nothing and there is no text to ellipsise.
  // With a name, the name is the slack — a legal 32-character one used to take
  // the issue header to 445px of chip inside a 390px viewport, because the box
  // refused to narrow by any amount and the timestamp beside it was the only
  // thing that could (T-486). What the name gives up it gives up in the box
  // around it, above; this one only stops refusing.
  //
  // `max-w-full` is the same bargain for a chip that is *not* a flex item. In
  // a sentence an inline-block is sized shrink-to-fit with no upper bound, and
  // `whitespace-nowrap` leaves the line nothing to break, so an event row's
  // author simply ran off the side: 455px of chip ending 85px past a 390px
  // viewport (T-501). A percentage cap resolves against the line's own
  // containing block, which hands the name the same ellipsis it gets under
  // flex pressure. It is a bound and not a layout, so at any width where the
  // chip already fits it changes nothing — measured identical at 700px, where
  // the row is flex and the chip was never the thing overflowing.
  //
  // `text-sm` restates the name's own size on the box the avatar is centred
  // in. Inherited instead, a hover card's `text-base` would give the chip a
  // 24px strut and hang the avatar 2px below the 14px name it belongs to.
  // `ps-5` is the width the out-of-flow avatar no longer claims, and `min-w-5`
  // is that same width as a floor: the avatar is positioned against this box,
  // so a chip allowed past it would leave its own avatar hanging outside it.
  const box = cn(
    "inline-block whitespace-nowrap",
    compact ? "shrink-0" : "relative max-w-full min-w-5 ps-5 text-sm",
  );

  // The avatar's `alt` is empty and the fallback only carries initials, so a
  // compact chip reaching for a name of its own has none to find.
  const label = compact ? displayNameOf(user) : undefined;

  const chip = link ? (
    <Link
      to="/users/$ref"
      params={{ ref: user.login }}
      className={cn(box, "hover:underline")}
      aria-label={label}
      title={label}
    >
      {body}
    </Link>
  ) : (
    <span className={box}>{body}</span>
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
