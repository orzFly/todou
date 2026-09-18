import type { Grain, ResolvedGrain } from "@todou/shared";
import { DomainError } from "../../errors.ts";
import type { AggregateBucket } from "./aggregate.ts";

export const AUTO_BUCKET_LIMIT = 120;
export const EXPLICIT_BUCKET_LIMIT = 400;
const GRAINS: ResolvedGrain[] = ["1h", "6h", "12h", "1d", "1w"];
const FIXED_MS: Partial<Record<ResolvedGrain, number>> = {
  "1h": 60 * 60 * 1_000,
  "6h": 6 * 60 * 60 * 1_000,
  "12h": 12 * 60 * 60 * 1_000,
};

export type BoundaryProvider = (
  from: Date,
  to: Date,
  grain: "1d" | "1w",
  timezone: string,
) => Promise<Date[]>;

function validation(message: string, details?: unknown): DomainError {
  return new DomainError(400, "validation_failed", message, details);
}

export function fixedBoundaries(from: Date, to: Date, stepMs: number): Date[] {
  if (!(stepMs > 0) || !Number.isSafeInteger(stepMs)) {
    throw validation("bucket step must be a positive integer");
  }
  const firstGrid = Math.floor(from.getTime() / stepMs) * stepMs;
  const result = [new Date(from)];
  for (let time = firstGrid + stepMs; time < to.getTime(); time += stepMs) {
    if (time > from.getTime()) result.push(new Date(time));
  }
  result.push(new Date(to));
  return result;
}

export function normalizeCalendarBoundaries(
  candidates: Date[],
  from: Date,
  to: Date,
): Date[] {
  const times = new Set<number>([from.getTime(), to.getTime()]);
  for (const candidate of candidates) {
    const time = candidate.getTime();
    if (Number.isFinite(time) && time > from.getTime() && time < to.getTime()) {
      times.add(time);
    }
  }
  return [...times].sort((a, b) => a - b).map((time) => new Date(time));
}

async function boundariesFor(
  from: Date,
  to: Date,
  grain: ResolvedGrain,
  timezone: string,
  calendar: BoundaryProvider,
): Promise<Date[]> {
  const fixed = FIXED_MS[grain];
  if (fixed !== undefined) return fixedBoundaries(from, to, fixed);
  return normalizeCalendarBoundaries(
    await calendar(from, to, grain as "1d" | "1w", timezone),
    from,
    to,
  );
}

export async function buildBuckets(input: {
  from: Date;
  to: Date;
  asOf: Date;
  grain: Grain;
  timezone: string;
  calendar: BoundaryProvider;
}): Promise<{ resolvedGrain: ResolvedGrain; buckets: AggregateBucket[] }> {
  const to = input.to < input.asOf ? input.to : input.asOf;
  if (input.from >= input.asOf || to <= input.from) {
    throw validation("insights range must begin before the current snapshot");
  }
  let resolved: ResolvedGrain;
  let boundaries: Date[];
  if (input.grain === "auto") {
    let selected: { grain: ResolvedGrain; boundaries: Date[] } | undefined;
    for (const candidate of GRAINS) {
      const next = await boundariesFor(
        input.from,
        to,
        candidate,
        input.timezone,
        input.calendar,
      );
      if (next.length - 1 <= AUTO_BUCKET_LIMIT) {
        selected = { grain: candidate, boundaries: next };
        break;
      }
    }
    if (selected === undefined) {
      throw validation(
        "range cannot be represented by at most 120 automatic buckets",
      );
    }
    resolved = selected.grain;
    boundaries = selected.boundaries;
  } else {
    resolved = input.grain;
    boundaries = await boundariesFor(
      input.from,
      to,
      resolved,
      input.timezone,
      input.calendar,
    );
    if (boundaries.length - 1 > EXPLICIT_BUCKET_LIMIT) {
      let suggestion: ResolvedGrain | undefined;
      for (const candidate of GRAINS) {
        const count =
          (
            await boundariesFor(
              input.from,
              to,
              candidate,
              input.timezone,
              input.calendar,
            )
          ).length - 1;
        if (count <= EXPLICIT_BUCKET_LIMIT) {
          suggestion = candidate;
          break;
        }
      }
      throw validation(
        `requested grain produces ${boundaries.length - 1} buckets; maximum is 400`,
        {
          buckets: boundaries.length - 1,
          limit: 400,
          suggested_grain: suggestion,
        },
      );
    }
  }

  const calendarBoundaryTimes =
    FIXED_MS[resolved] === undefined
      ? new Set(
          (
            await input.calendar(
              input.from,
              to,
              resolved as "1d" | "1w",
              input.timezone,
            )
          ).map((boundary) => boundary.getTime()),
        )
      : undefined;

  return {
    resolvedGrain: resolved,
    buckets: boundaries.slice(0, -1).map((start, index) => {
      const end = boundaries[index + 1];
      const fixed = FIXED_MS[resolved];
      const partial =
        fixed === undefined
          ? !calendarBoundaryTimes?.has(start.getTime()) ||
            !calendarBoundaryTimes?.has(end.getTime())
          : start.getTime() !== Math.floor(start.getTime() / fixed) * fixed ||
            end.getTime() !== Math.ceil(end.getTime() / fixed) * fixed;
      return {
        start,
        end,
        partial,
        current:
          input.asOf >= start && input.asOf <= end && input.to >= input.asOf,
      };
    }),
  };
}
