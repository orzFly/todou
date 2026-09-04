import { Readable } from "node:stream";
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import {
  Attachment,
  DirectUploadRequest,
  DirectUploadTicket,
  ProjectSlug,
} from "@todou/shared";
import type { Context } from "hono";
import type { AppEnv } from "../auth/middleware.ts";
import { ValidationFailedError } from "../errors.ts";
import { contentDisposition } from "../http/content-disposition.ts";
import {
  completeDirectUpload,
  listIssueAttachments,
  openAttachment,
  requestDirectUpload,
  uploadAttachment,
} from "../services/attachments.ts";

type AttachmentRow = Awaited<ReturnType<typeof openAttachment>>["row"];

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

const directUploadRoute = createRoute({
  method: "post",
  path: "/{slug}/attachments/direct-uploads",
  summary: "Request a presigned direct upload (writer, s3 backend only)",
  request: {
    params: z.object({ slug: ProjectSlug }),
    body: {
      content: { "application/json": { schema: DirectUploadRequest } },
    },
  },
  responses: {
    201: {
      description: "Upload ticket",
      content: { "application/json": { schema: DirectUploadTicket } },
    },
  },
});

const directUploadCompleteRoute = createRoute({
  method: "post",
  path: "/{slug}/attachments/direct-uploads/{upload_id}/complete",
  summary: "Register a finished direct upload (writer, s3 backend only)",
  request: {
    params: z.object({
      slug: ProjectSlug,
      upload_id: z.coerce.number().int().positive(),
    }),
  },
  responses: {
    201: {
      description: "Registered",
      content: { "application/json": { schema: Attachment } },
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
  responses: {
    200: { description: "File stream" },
    301: { description: "The card moved; the attachment lives elsewhere now" },
    302: { description: "Redirect to a presigned URL (s3 backend)" },
    410: { description: "Moved to a project the reader cannot see" },
  },
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
  responses: {
    200: { description: "File stream" },
    301: { description: "The card moved; the attachment lives elsewhere now" },
    302: { description: "Redirect to a presigned URL (s3 backend)" },
    410: { description: "Moved to a project the reader cannot see" },
  },
});

const viewRoute = createRoute({
  method: "get",
  path: "/{slug}/attachments/{id}/view",
  summary: "Render an attachment inline, CSP-sandboxed (member)",
  request: {
    params: z.object({
      slug: ProjectSlug,
      id: z.coerce.number().int().positive(),
    }),
  },
  responses: {
    200: { description: "Inline file stream" },
    301: { description: "The card moved; the attachment lives elsewhere now" },
    410: { description: "Moved to a project the reader cannot see" },
  },
});

const viewNamedRoute = createRoute({
  method: "get",
  path: "/{slug}/attachments/{id}/view/{name}",
  summary:
    "Render an attachment inline, CSP-sandboxed; the name segment is " +
    "ignored (member)",
  request: {
    params: z.object({
      slug: ProjectSlug,
      id: z.coerce.number().int().positive(),
      name: z.string(),
    }),
  },
  responses: {
    200: { description: "Inline file stream" },
    301: { description: "The card moved; the attachment lives elsewhere now" },
    410: { description: "Moved to a project the reader cannot see" },
  },
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

  app.openapi(directUploadRoute, async (c) => {
    const { slug } = c.req.valid("param");
    const ticket = await requestDirectUpload(
      c.get("appCtx"),
      c.get("user"),
      slug,
      c.req.valid("json"),
    );
    return c.json(ticket, 201);
  });

  app.openapi(directUploadCompleteRoute, async (c) => {
    const { slug, upload_id } = c.req.valid("param");
    const attachment = await completeDirectUpload(
      c.get("appCtx"),
      c.get("user"),
      slug,
      upload_id,
      c.get("agentContext"),
    );
    return c.json(attachment, 201);
  });

  const streamAttachment = async (
    c: Context<AppEnv>,
    row: AttachmentRow,
    disposition: "attachment" | "inline",
  ) => {
    const ctx = c.get("appCtx");
    const { stream, size } = await ctx.storage.getStream(row.storageKey);

    c.header("content-type", row.contentType);
    c.header("content-length", String(size));
    c.header(
      "content-disposition",
      contentDisposition(disposition, row.filename),
    );
    if (disposition === "inline") {
      // Attachments are user-supplied and share the API's origin. The CSP
      // sandbox (no allow-same-origin) gives the document an opaque origin
      // even when this URL is opened as a top-level tab, so its scripts can
      // run but cannot use the viewer's cookies against the API. The web
      // client's <iframe sandbox> is the first fence; this one holds when
      // the URL is visited directly.
      c.header("content-security-policy", "sandbox allow-scripts");
      c.header("x-content-type-options", "nosniff");
    }
    return c.body(Readable.toWeb(stream) as ReadableStream);
  };

  // Downloads 302 to a presigned URL when the backend offers one; filename
  // and type semantics travel as response-* presign parameters. Views stay
  // server-streamed on every backend — the CSP sandbox header cannot follow
  // a redirect.
  const downloadAttachment = async (
    c: Context<AppEnv>,
    slug: string,
    id: number,
    name: string | null = null,
  ) => {
    const ctx = c.get("appCtx");
    const { row } = await openAttachment(ctx, c.get("user"), slug, id, {
      variant: "download",
      filename: name,
    });
    const url = await ctx.storage.urlFor(row.storageKey, {
      filename: row.filename,
      contentType: row.contentType,
    });
    if (url !== null) {
      // The redirect target expires; caching the 302 would outlive it.
      c.header("cache-control", "no-store");
      return c.redirect(url, 302);
    }
    return streamAttachment(c, row, "attachment");
  };

  const viewAttachment = async (
    c: Context<AppEnv>,
    slug: string,
    id: number,
    name: string | null = null,
  ) => {
    const ctx = c.get("appCtx");
    const { row } = await openAttachment(ctx, c.get("user"), slug, id, {
      variant: "view",
      filename: name,
    });
    return streamAttachment(c, row, "inline");
  };

  app.openapi(downloadRoute, (c) => {
    const { slug, id } = c.req.valid("param");
    return downloadAttachment(c, slug, id);
  });

  app.openapi(downloadNamedRoute, (c) => {
    const { slug, id, name } = c.req.valid("param");
    return downloadAttachment(c, slug, id, name);
  });

  app.openapi(viewRoute, (c) => {
    const { slug, id } = c.req.valid("param");
    return viewAttachment(c, slug, id);
  });

  app.openapi(viewNamedRoute, (c) => {
    const { slug, id, name } = c.req.valid("param");
    return viewAttachment(c, slug, id, name);
  });

  return app;
}
