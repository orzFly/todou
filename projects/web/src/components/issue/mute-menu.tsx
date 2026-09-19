import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { IssueMuteMode } from "@todou/shared";
import { BellOffIcon, BellRingIcon, CheckIcon } from "lucide-react";
import {
  issueMuteLabels,
  muteLabelOf,
  muteOf,
  mutesQuery,
  useMuteIssue,
  useUnmuteIssue,
} from "@/api/mutes.ts";
import { SidebarSection } from "@/components/issue/sidebar-section.tsx";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

/**
 * The card's notification control (T-372): one dropdown, three settings —
 * always notifying, quiet until new activity relights the card, or quiet
 * until unmuted by hand.
 *
 * Reads its current value from the stored settings (mutesQuery), not from
 * `issue.muted`: that field is today's verdict, so an `until_activity` card
 * that relit would show "not muted" here while the setting still says
 * muted — and picking "notify" off that display would be a no-op click on
 * a state the reader believes they are leaving.
 *
 * Not part of IssueMoreActions: that section renders behind `canDelete`,
 * and muting is every reader's, not a maintainer's.
 */
export function MuteMenu({
  slug,
  issueNumber,
}: {
  slug: string;
  issueNumber: number;
}) {
  // Plain useQuery, not suspense: the control must render on a page whose
  // mutes fetch has not landed yet, showing the neutral "not set" state.
  const { data } = useQuery(mutesQuery);
  const mutes = data ?? { issues: [], projects: [] };
  const muteIssue = useMuteIssue();
  const unmuteIssue = useUnmuteIssue();
  const mode = muteOf(mutes, slug, issueNumber);
  const projectMuted = (mutes?.projects ?? []).some((p) => p.slug === slug);

  // null mode is the first entry's "not set" state: no mute row, which
  // behaves as always-notify — the same click ("notify") clears either.
  const items: {
    key: IssueMuteMode | null;
    icon: typeof BellRingIcon;
    text: string;
    pick: () => void;
  }[] = [
    {
      key: null,
      icon: BellRingIcon,
      text: "Notify on new activity",
      pick: () => unmuteIssue.mutate({ slug, number: issueNumber }),
    },
    {
      key: "until_activity",
      icon: BellOffIcon,
      text: issueMuteLabels.until_activity,
      pick: () =>
        muteIssue.mutate({ slug, number: issueNumber, mode: "until_activity" }),
    },
    {
      key: "forever",
      icon: BellOffIcon,
      text: issueMuteLabels.forever,
      pick: () =>
        muteIssue.mutate({ slug, number: issueNumber, mode: "forever" }),
    },
  ];

  return (
    <SidebarSection name="notifications" title="Notifications">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm" className="w-full justify-start">
            {mode === undefined || mode === null ? (
              <BellRingIcon className="size-3.5" />
            ) : (
              <BellOffIcon className="size-3.5" />
            )}
            {mode === undefined || mode === null
              ? "Notifying"
              : muteLabelOf(mode)}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent className="w-auto" align="start">
          {items.map((item) => (
            <DropdownMenuItem key={item.text} onSelect={item.pick}>
              <item.icon className="size-3.5" />
              {item.text}
              {(mode ?? null) === item.key && (
                <CheckIcon className="ml-auto size-3.5" />
              )}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      {projectMuted && (
        <p className="text-xs text-muted-foreground">
          The whole project is muted —{" "}
          <Link
            to="/projects/$slug"
            params={{ slug }}
            className="underline-offset-2 hover:underline"
          >
            unmute it
          </Link>{" "}
          to hear from any of its cards.
        </p>
      )}
    </SidebarSection>
  );
}
