import { z } from "@hono/zod-openapi";
import { GoneBody, MovedTo } from "@todou/shared";

const jsonBody = <T extends z.ZodType>(schema: T) => ({
  content: { "application/json": { schema } },
});

/**
 * What a GET answers with once the card has moved to another project
 * (T-231). Declared per route rather than globally: only the reads that go
 * through the issue gate can produce them.
 *
 * One module rather than a copy per route file, unlike the `jsonBody` helper
 * beside it: that one is three lines of formatting, this is a contract, and
 * three copies of a contract are three things that can drift apart.
 */
export const movedResponses = {
  301: {
    description: "Moved to another project",
    ...jsonBody(z.object({ moved_to: MovedTo })),
  },
  410: {
    description: "Moved to a project the reader cannot see",
    ...jsonBody(GoneBody),
  },
};
