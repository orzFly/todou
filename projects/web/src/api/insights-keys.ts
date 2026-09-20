import type { BurnQuery } from "@todou/shared";

export const insightsKeys = {
  settings: (slug?: string) =>
    slug === undefined
      ? (["insights-settings"] as const)
      : (["insights-settings", slug] as const),
  burn: (slug?: string) =>
    slug === undefined
      ? (["insights-burn"] as const)
      : (["insights-burn", slug] as const),
  burnRequest: (slug: string, request: BurnQuery, settingsVersion: string) =>
    [
      "insights-burn",
      slug,
      {
        from: request.from,
        to: request.to,
        grain: request.grain,
        tz: request.tz,
        settingsVersion,
      },
    ] as const,
};
