import {
  BotIcon,
  CircleDotIcon,
  HashIcon,
  InboxIcon,
  KeyRoundIcon,
  type LucideIcon,
  PaletteIcon,
  SettingsIcon,
  TagIcon,
  UserIcon,
  UsersIcon,
} from "lucide-react";

export interface SettingsCategory {
  to: string;
  params?: Record<string, string>;
  label: string;
  icon: LucideIcon;
  /** Neighbours sharing a group are drawn under one heading; `undefined` heads none. */
  group?: string;
  /** Current only on its own address: every other category lives under it. */
  exact: boolean;
}

/**
 * The account's settings (T-557). The settings nav and the account menu both
 * read this, so the menu never offers fewer categories than the page has.
 */
export const ACCOUNT_SETTINGS: readonly SettingsCategory[] = [
  { to: "/settings/profile", label: "Profile", icon: UserIcon, exact: false },
  {
    to: "/settings/appearance",
    label: "Appearance",
    icon: PaletteIcon,
    group: "Preferences",
    exact: false,
  },
  {
    to: "/settings/inbox",
    label: "Inbox",
    icon: InboxIcon,
    group: "Preferences",
    exact: false,
  },
  {
    to: "/settings/agents",
    label: "Agents",
    icon: BotIcon,
    group: "Access",
    exact: false,
  },
  {
    to: "/settings/tokens",
    label: "Personal tokens",
    icon: KeyRoundIcon,
    group: "Access",
    exact: false,
  },
];

export function projectSettings(slug: string): SettingsCategory[] {
  const params = { slug };
  return [
    {
      to: "/projects/$slug/settings",
      params,
      label: "General",
      icon: SettingsIcon,
      exact: true,
    },
    {
      to: "/projects/$slug/settings/members",
      params,
      label: "Members",
      icon: UsersIcon,
      group: "Access",
      exact: false,
    },
    {
      to: "/projects/$slug/settings/statuses",
      params,
      label: "Statuses",
      icon: CircleDotIcon,
      group: "Issues",
      exact: false,
    },
    {
      to: "/projects/$slug/settings/labels",
      params,
      label: "Labels",
      icon: TagIcon,
      group: "Issues",
      exact: false,
    },
    {
      to: "/projects/$slug/settings/references",
      params,
      label: "References",
      icon: HashIcon,
      group: "Issues",
      exact: false,
    },
  ];
}

/** Runs of neighbours sharing a `group`, in order. */
export function groupCategories(
  categories: readonly SettingsCategory[],
): { group?: string; items: SettingsCategory[] }[] {
  const runs: { group?: string; items: SettingsCategory[] }[] = [];
  for (const category of categories) {
    const last = runs.at(-1);
    if (last && last.group === category.group) last.items.push(category);
    else runs.push({ group: category.group, items: [category] });
  }
  return runs;
}
