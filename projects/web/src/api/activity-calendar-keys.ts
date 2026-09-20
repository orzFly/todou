export const activityKeys = {
  project: (slug?: string) =>
    slug === undefined
      ? (["activity-project"] as const)
      : (["activity-project", slug] as const),
  user: (subjectId?: number) =>
    subjectId === undefined
      ? (["activity-user"] as const)
      : (["activity-user", subjectId] as const),
};
