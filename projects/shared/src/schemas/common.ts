import { z } from "zod";

export const Id = z.number().int().positive();
export type Id = z.infer<typeof Id>;

/**
 * A PostgreSQL `integer` column's range. An input compared with or written
 * to one has to be bounded by it: past it the query fails outright instead
 * of matching nothing, and the caller gets a 500 (T-730).
 */
export const INT4_MAX = 2 ** 31 - 1;
export const Int4 = z
  .number()
  .int()
  .min(-INT4_MAX - 1)
  .max(INT4_MAX);

export const Timestamp = z.iso.datetime({ offset: true });
export type Timestamp = z.infer<typeof Timestamp>;

export const Cursor = z.string().min(1);
export type Cursor = z.infer<typeof Cursor>;

export const ErrorBody = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.unknown().optional(),
  }),
});
export type ErrorBody = z.infer<typeof ErrorBody>;

export function paginated<T extends z.ZodType>(item: T) {
  return z.object({
    items: z.array(item),
    next_cursor: Cursor.nullable(),
  });
}
