import { Readable } from "node:stream";
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { Attachment, ProjectSlug } from "@todou/shared";
import type { Context } from "hono";
import type { AppEnv } from "../auth/middleware.ts";
import { ValidationFailedError } from "../errors.ts";
import {
  listIssueAttachments,
  openAttachment,
  uploadAttachment,
} from "../services/attachments.ts";

const uploadRoute = createRoute({
  method: "post",
  path: "/{slug}/attachments",
  summary: "Upload a file to an issue (writer, multipart)",
  request: {
    params: z.object({ slug: ProjectSlug }),
    body: {
      content: {
        "multipart/form-data": {
          schema: z.object({
            file: z
              .custom<File>((v: unknown) => v instanceof File, "file required")
              .openapi({ type: "string", format: "binary" }),
            issue_number: z.coerce.number().int().positive(),
          }),
        },
      },
    },
  },
  responses: {
    201: {
      description: "Uploaded",
      content: { "application/json": { schema: Attachment } },
    },
  },
});

const listRoute = createRoute({
  method: "get",
  path: "/{slug}/attachments",
  summary: "List an issue's attachments (member)",
  request: {
    params: z.object({ slug: ProjectSlug }),
    query: z.object({ issue_number: z.coerce.number().int().positive() }),
  },
  responses: {
    200: {
      description: "Attachments",
      content: { "application/json": { schema: z.array(Attachment) } },
    },
  },
});

const downloadRoute = createRoute({
  method: "get",
  path: "/{slug}/attachments/{id}/download",
  summary: "Download an attachment (member)",
  request: {
    params: z.object({
      slug: ProjectSlug,
      id: z.coerce.number().int().positive(),
    }),
  },
  responses: { 200: { description: "File stream" } },
});

// The trailing name is cosmetic — a readable URL and a sensible save-as
// default for clients that ignore content-disposition. Lookup is by id.
const downloadNamedRoute = createRoute({
  method: "get",
  path: "/{slug}/attachments/{id}/download/{name}",
  summary: "Download an attachment; the name segment is ignored (member)",
  request: {
    params: z.object({
      slug: ProjectSlug,
      id: z.coerce.number().int().positive(),
      name: z.string(),
    }),
  },
  responses: { 200: { description: "File stream" } },
});

export function attachmentRoutes() {
  const app = new OpenAPIHono<AppEnv>();

  app.openapi(uploadRoute, async (c) => {
    const { slug } = c.req.valid("param");
    const form = c.req.valid("form");
    if (!(form.file instanceof File)) {
      throw new ValidationFailedError("file part is required");
    }
    const attachment = await uploadAttachment(
      c.get("appCtx"),
      c.get("user"),
      slug,
      form.issue_number,
      form.file,
      c.get("agentContext"),
    );
    return c.json(attachment, 201);
  });

  app.openapi(listRoute, async (c) => {
    const { slug } = c.req.valid("param");
    const { issue_number } = c.req.valid("query");
    const list = await listIssueAttachments(
      c.get("appCtx"),
      c.get("user"),
      slug,
      issue_number,
    );
    return c.json(list, 200);
  });

  const streamDownload = async (
    c: Context<AppEnv>,
    slug: string,
    id: number,
  ) => {
    const ctx = c.get("appCtx");
    const { row } = await openAttachment(ctx, c.get("user"), slug, id);
    const { stream, size } = await ctx.storage.getStream(row.storageKey);

    c.header("content-type", row.contentType);
    c.header("content-length", String(size));
    c.header(
      "content-disposition",
      `attachment; filename="${row.filename.replaceAll('"', "_")}"`,
    );
    return c.body(Readable.toWeb(stream) as ReadableStream);
  };

  app.openapi(downloadRoute, (c) => {
    const { slug, id } = c.req.valid("param");
    return streamDownload(c, slug, id);
  });

  app.openapi(downloadNamedRoute, (c) => {
    const { slug, id } = c.req.valid("param");
    return streamDownload(c, slug, id);
  });

  return app;
}
