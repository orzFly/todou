import type { Member } from "@todou/shared";
import { CheckIcon } from "lucide-react";
import type { ReactNode } from "react";
import { PICKER_ROW } from "@/components/issue/picker-row.ts";
import { displayNameOf, UserAvatar } from "@/components/shared/user-chip.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

/**
 * The Edit assignees menu, shared by the card page and the new-card page so
 * the two cannot drift apart. `selectedIds` rather than the assignees
 * themselves: one caller holds `issue.assignees`, the other only ids.
 */
export function AssigneePicker({
  members,
  selectedIds,
  onToggle,
  trigger,
  defaultOpen = false,
}: {
  members: Member[];
  selectedIds: number[];
  onToggle: (userId: number) => void;
  trigger: ReactNode;
  /** Test-only, as on LabelPicker. */
  defaultOpen?: boolean;
}) {
  return (
    <DropdownMenu defaultOpen={defaultOpen}>
      <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
      {/* Name plus login needs more room than the trigger's width, which
          is what the menu defaults to. */}
      {/* Floating UI positions with roundByDPR = Math.round(value * dpr) / dpr.
          At DPR 1, rounding the 144.5px menu's half-pixel position right
          reduces the shared 8px collision padding to 7.5px of real clearance.
          The extra 0.5px bounds the rightward rounding error for DPR >= 1
          and preserves the overlay's measured 8px edge contract. Below DPR 1
          that bound does not hold: DPR 0.5 has a 2px rounding grid, so even
          padding 8.5 can leave 7.5px clearance. The smoke measures DPR 1. */}
      <DropdownMenuContent className="w-auto" collisionPadding={8.5}>
        {members.map((member) => {
          const active = selectedIds.includes(member.user.id);
          return (
            <DropdownMenuItem
              key={member.user.id}
              className={PICKER_ROW}
              // Radix keyboard typeahead reads textContent, where the initials
              // fallback appears only for users with no avatar — which letter
              // jumps to a row would otherwise depend on who uploaded one.
              textValue={`${displayNameOf(member.user)} @${member.user.login}`}
              onSelect={(e) => {
                // Assigning several people in a row beats closing after each.
                e.preventDefault();
                onToggle(member.user.id);
              }}
            >
              {/* Decorative: the initials fallback would otherwise be read out
                  glued to the name this row already carries. The badge keeps
                  its own label — humans and agents are mixed in here, and it
                  is the only thing telling them apart. */}
              <UserAvatar user={member.user} badge aria-hidden />
              <span className="whitespace-nowrap">
                {displayNameOf(member.user)}
              </span>
              <span className="whitespace-nowrap text-muted-foreground">
                @{member.user.login}
              </span>
              {/* Kept in the layout unchecked, unlike the leading slot this
                  replaced (T-458): the menu sizes itself to its widest row, so
                  a check that only occupies space once picked would widen the
                  whole menu under the pointer that just clicked it. */}
              <span className="ml-auto w-4 shrink-0">
                {active && <CheckIcon className="size-4" />}
              </span>
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
