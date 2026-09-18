import { z } from "zod";

import { Id, Timestamp } from "./common.ts";
import { StatusCategory } from "./project.ts";

const NonNegativeSafeInteger = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER);
const SafeInteger = z
  .number()
  .int()
  .min(Number.MIN_SAFE_INTEGER)
  .max(Number.MAX_SAFE_INTEGER);
const ColorHex = z.string().regex(/^#[0-9a-f]{6}$/i);
const OpaqueVersion = z.string().min(1);

export const Role = z.enum(["remaining", "completed", "excluded"]);
export type Role = z.infer<typeof Role>;

export const Grain = z.enum(["auto", "1h", "6h", "12h", "1d", "1w"]);
export type Grain = z.infer<typeof Grain>;

export const ResolvedGrain = z.enum(["1h", "6h", "12h", "1d", "1w"]);
export type ResolvedGrain = z.infer<typeof ResolvedGrain>;

const BurnBoundary = z.union([Timestamp, z.iso.date()]);
const LOCAL_DATE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_RANGE_MS = 366 * 24 * 60 * 60 * 1_000;

export const BurnQuery = z
  .strictObject({
    from: BurnBoundary,
    to: BurnBoundary,
    grain: Grain,
    tz: z.string().min(1),
  })
  .superRefine((query, ctx) => {
    const fromIsDate = LOCAL_DATE.test(query.from);
    const toIsDate = LOCAL_DATE.test(query.to);
    if (fromIsDate !== toIsDate) {
      ctx.addIssue({
        code: "custom",
        path: ["to"],
        message: "from and to must both be dates or both be timestamps",
      });
      return;
    }

    const from = Date.parse(
      fromIsDate ? `${query.from}T00:00:00Z` : query.from,
    );
    const to = Date.parse(toIsDate ? `${query.to}T00:00:00Z` : query.to);
    if (to <= from) {
      ctx.addIssue({
        code: "custom",
        path: ["to"],
        message: "to must be later than from",
      });
    } else if (to - from > MAX_RANGE_MS) {
      ctx.addIssue({
        code: "custom",
        path: ["to"],
        message: "the insights range cannot exceed 366 days",
      });
    }
  });
export type BurnQuery = z.infer<typeof BurnQuery>;

export const RoleEntry = z.strictObject({
  status_id: Id,
  name: z.string().min(1),
  category: StatusCategory,
  color: ColorHex,
  position: SafeInteger,
  role: Role,
});
export type RoleEntry = z.infer<typeof RoleEntry>;

const PutRoleEntry = z.strictObject({
  status_id: Id,
  role: Role,
});

function hasUniqueStatusIds(entries: ReadonlyArray<{ status_id: number }>) {
  return (
    new Set(entries.map((entry) => entry.status_id)).size === entries.length
  );
}

export const Settings = z.strictObject({
  version: OpaqueVersion,
  source: z.enum(["default", "saved"]),
  roles: z
    .array(RoleEntry)
    .refine(hasUniqueStatusIds, "status_id values must be unique"),
});
export type Settings = z.infer<typeof Settings>;

export const PutSettings = z.strictObject({
  version: OpaqueVersion,
  roles: z
    .array(PutRoleEntry)
    .refine(hasUniqueStatusIds, "status_id values must be unique"),
});
export type PutSettings = z.infer<typeof PutSettings>;

export const Measure = z
  .strictObject({
    value: NonNegativeSafeInteger.nullable(),
    known: NonNegativeSafeInteger,
    unknown: NonNegativeSafeInteger,
  })
  .superRefine((measure, ctx) => {
    if (measure.unknown === 0 && measure.value !== measure.known) {
      ctx.addIssue({
        code: "custom",
        path: ["value"],
        message: "value must equal known when unknown is zero",
      });
    }
    if (measure.unknown > 0 && measure.value !== null) {
      ctx.addIssue({
        code: "custom",
        path: ["value"],
        message: "value must be null when unknown is greater than zero",
      });
    }
  });
export type Measure = z.infer<typeof Measure>;

const StatusCount = z.strictObject({
  status_id: Id,
  count: NonNegativeSafeInteger,
});

export const StockSnapshot = z.strictObject({
  remaining: Measure,
  scope: Measure,
  open_total: Measure,
  by_status: z
    .array(StatusCount)
    .refine(hasUniqueStatusIds, "status_id values must be unique"),
  unknown_cards: NonNegativeSafeInteger,
});
export type StockSnapshot = z.infer<typeof StockSnapshot>;

const ClosedByStatus = z.strictObject({
  status_id: Id,
  count: Measure,
});

export const Flow = z.strictObject({
  completed: Measure,
  completed_cards: Measure,
  reopened: Measure,
  created_remaining: Measure,
  created_completed: Measure,
  moved_in_remaining: Measure,
  moved_in_completed: Measure,
  restored_remaining: Measure,
  restored_completed: Measure,
  reintroduced_remaining: Measure,
  reintroduced_completed: Measure,
  excluded_remaining: Measure,
  excluded_completed: Measure,
  deleted_remaining: Measure,
  deleted_completed: Measure,
  scope_added: Measure,
  scope_removed: Measure,
  open_entered: Measure,
  open_exited: Measure,
  category_closed: Measure,
  category_reopened: Measure,
  created_open: Measure,
  moved_in_open: Measure,
  restored_open: Measure,
  deleted_open: Measure,
  closed_by_status: z
    .array(ClosedByStatus)
    .refine(hasUniqueStatusIds, "status_id values must be unique"),
});
export type Flow = z.infer<typeof Flow>;

export const CoverageReason = z.enum([
  "missing_status_definition",
  "broken_transition_chain",
  "membership_boundary_unknown",
  "malformed_event",
]);
export type CoverageReason = z.infer<typeof CoverageReason>;

export const Coverage = z.strictObject({
  project_created_at: Timestamp,
  mode: z.literal("current_cohort"),
  has_unknown: z.boolean(),
  reasons: z.array(CoverageReason),
});
export type Coverage = z.infer<typeof Coverage>;

export const BucketQuality = z.enum([
  "exact",
  "mixed",
  "unknown",
  "not_applicable",
]);
export type BucketQuality = z.infer<typeof BucketQuality>;

export const Bucket = z
  .strictObject({
    start: Timestamp,
    end: Timestamp,
    partial: z.boolean(),
    current: z.boolean(),
    quality: BucketQuality,
    reasons: z.array(CoverageReason),
    stock: StockSnapshot.nullable(),
    flow: Flow.nullable(),
  })
  .superRefine((bucket, ctx) => {
    const notApplicable = bucket.quality === "not_applicable";
    if (notApplicable !== (bucket.stock === null && bucket.flow === null)) {
      ctx.addIssue({
        code: "custom",
        path: ["quality"],
        message:
          "not_applicable buckets must have null stock and flow; other buckets must have both",
      });
    }
    if ((bucket.stock === null) !== (bucket.flow === null)) {
      ctx.addIssue({
        code: "custom",
        path: ["stock"],
        message: "stock and flow must either both be present or both be null",
      });
    }
    if (Date.parse(bucket.end) <= Date.parse(bucket.start)) {
      ctx.addIssue({
        code: "custom",
        path: ["end"],
        message: "bucket end must be later than start",
      });
    }
  });
export type Bucket = z.infer<typeof Bucket>;

export const BurnResponse = z.strictObject({
  as_of: Timestamp,
  from: Timestamp,
  to: Timestamp,
  requested_grain: Grain,
  resolved_grain: ResolvedGrain,
  timezone: z.string().min(1),
  settings_version: OpaqueVersion,
  cohort: z.strictObject({
    mode: z.literal("current"),
    count: NonNegativeSafeInteger,
  }),
  history_coverage: Coverage,
  statuses: z
    .array(RoleEntry)
    .refine(hasUniqueStatusIds, "status_id values must be unique"),
  opening: StockSnapshot.nullable(),
  buckets: z.array(Bucket),
});
export type BurnResponse = z.infer<typeof BurnResponse>;
