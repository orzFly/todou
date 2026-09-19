import { z } from "zod";
import { Id, Timestamp } from "./common.ts";
import { ProjectSlug } from "./project.ts";

/** 读者能给一张卡挑的静音方式。 */
export const IssueMuteMode = z.enum(["forever", "until_activity"]);
export type IssueMuteMode = z.infer<typeof IssueMuteMode>;

/**
 * 一张卡此刻为什么是安静的。`project` 不是谁挑出来的模式，而是
 * 整个项目被静音的结果，所以它只出现在读路径上，不出现在写入体里。
 */
export const MuteReason = z.enum(["forever", "until_activity", "project"]);
export type MuteReason = z.infer<typeof MuteReason>;

export const IssueMuteInput = z.strictObject({ mode: IssueMuteMode });
export type IssueMuteInput = z.infer<typeof IssueMuteInput>;

export const MutedIssue = z.object({
  project: z.object({ slug: ProjectSlug, name: z.string() }),
  number: Id,
  title: z.string(),
  mode: IssueMuteMode,
  muted_at: Timestamp,
});
export type MutedIssue = z.infer<typeof MutedIssue>;

export const MutedProject = z.object({
  slug: ProjectSlug,
  name: z.string(),
  /** Versioned project icon URL; null means draw the fallback. */
  icon_url: z.string().nullable(),
  muted_at: Timestamp,
});
export type MutedProject = z.infer<typeof MutedProject>;

/** 存下来的设置，不是此刻的判定结果。 */
export const MuteList = z.object({
  issues: z.array(MutedIssue),
  projects: z.array(MutedProject),
});
export type MuteList = z.infer<typeof MuteList>;
