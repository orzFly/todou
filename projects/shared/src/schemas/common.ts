import { z } from "zod";

export const Id = z.number().int().positive();
export type Id = z.infer<typeof Id>;

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
