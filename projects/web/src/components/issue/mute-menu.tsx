import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { IssueMuteMode } from "@todou/shared";
import { BellOffIcon, BellRingIcon, CheckIcon } from "lucide-react";
import {
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
 * The notification control itself (T-372): one dropdown, three settings —
 * notifying, snoozed until someone else's next activity ends it (T-573), or
 * muted until unmuted by hand.
 *
 * It only reads and reports a setting, because the two callers store it in
 * different places: the card page writes straight through to the server,
 * while the new-issue page holds the pick until the card it applies to
 * exists (T-458).
 *
 * `mode` is `undefined` while the stored settings are still in flight and
 * `null` when the card carries no mute row — the control draws both as
 * notifying, and picking "notify" out of either is the same click.
 */
export function MuteControl({
  slug,
  mode,
  onPick,
}: {
  slug: string;
  mode: IssueMuteMode | null | undefined;
  onPick: (mode: IssueMuteMode | null) => void;
}) {
  // Plain useQuery, not suspense: the control must render on a page whose
  // mutes fetch has not landed yet, showing the neutral "not set" state.
  const { data } = useQuery(mutesQuery);
  const projectMuted = (data?.projects ?? []).some((p) => p.slug === slug);

  // Verbs, where the trigger shows the state they lead to. No prose under
  // them (T-573): what snoozing quiets shows the moment the card leaves the
  // inbox, and the snooze ending shows on this very control.
  const items: {
    key: IssueMuteMode | null;
    icon: typeof BellRingIcon;
    text: string;
  }[] = [
    { key: null, icon: BellRingIcon, text: "Notify" },
    {
      key: "until_activity",
      icon: BellOffIcon,
      text: "Snooze until new activity",
    },
    { key: "forever", icon: BellOffIcon, text: "Mute" },
  ];

  return (
    <>
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
            <DropdownMenuItem key={item.text} onSelect={() => onPick(item.key)}>
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
    </>
  );
}

/**
 * The card's notification section.
 *
 * Reads its current value from the stored settings (mutesQuery), not from
 * `issue.muted`: only list responses compute that field, and it is today's
 * verdict — "project" for a card quiet only because its project is muted,
 * a reason this control cannot set or clear.
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
  const { data } = useQuery(mutesQuery);
  const muteIssue = useMuteIssue();
  const unmuteIssue = useUnmuteIssue();
  const mode = muteOf(data ?? { issues: [], projects: [] }, slug, issueNumber);

  return (
    <SidebarSection name="notifications" title="Notifications">
      <MuteControl
        slug={slug}
        mode={mode}
        onPick={(next) => {
          if (next === null) {
            unmuteIssue.mutate({ slug, number: issueNumber });
            return;
          }
          muteIssue.mutate({ slug, number: issueNumber, mode: next });
        }}
      />
    </SidebarSection>
  );
}
