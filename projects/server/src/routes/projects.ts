import { Readable } from "node:stream";
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import {
  AccessDenial,
  Member,
  MemberAddInput,
  MemberSetInput,
  Project,
  ProjectCreateInput,
  ProjectRef,
  ProjectUpdateInput,
} from "@todou/shared";
import type { AppEnv } from "../auth/middleware.ts";
import { requireCapability } from "../services/access.ts";
import {
  listDenials,
  removeDenial,
  setDenial,
} from "../services/access-denials.ts";
import {
  addMemberByLogin,
  listMembers,
  removeMember,
  setMember,
} from "../services/members.ts";
import {
  deleteProjectIcon,
  openProjectIcon,
  setProjectIcon,
} from "../services/project-icon.ts";
import {
  blockClearStatusOf,
  createProject,
  deleteProject,
  formerSlugsOf,
  listProjects,
  toProject,
  updateProject,
} from "../services/projects.ts";
import { roleTag } from "./role-tag.ts";

const slugParam = z.object({ slug: ProjectRef });
const memberParams = z.object({
  slug: ProjectRef,
  userId: z.coerce.number().int().positive(),
});

const jsonBody = <T extends z.ZodType>(schema: T) => ({
  content: { "application/json": { schema } },
});

/** Same shape as `POST /me/avatar`'s body. */
const iconBody = {
  content: {
    "multipart/form-data": {
      schema: z.object({
        file: z
          .custom<File>((v: unknown) => v instanceof File, "file required")
          .openapi({ type: "string", format: "binary" }),
      }),
    },
  },
};

const uploadIconRoute = createRoute({
  method: "post",
  path: "/{slug}/icon",
  summary: "Upload this project's icon (png/jpeg/webp/gif, multipart; admin)",
  request: { params: slugParam, body: iconBody },
  responses: {
    200: { description: "Updated project", ...jsonBody(Project) },
  },
});

const deleteIconRoute = createRoute({
  method: "delete",
  path: "/{slug}/icon",
  summary: "Remove this project's icon and go back to the fallback (admin)",
  request: { params: slugParam },
  responses: {
    200: { description: "Updated project", ...jsonBody(Project) },
  },
});

const getIconRoute = createRoute({
  method: "get",
  path: "/{slug}/icon",
  summary: "This project's icon image (anyone who can read the project)",
  request: { params: slugParam },
  responses: { 200: { description: "Image stream" } },
});

const listRoute = createRoute({
  method: "get",
  path: "/",
  summary: "Projects visible to me",
  responses: {
    200: { description: "Projects", ...jsonBody(z.array(Project)) },
  },
});

const createRouteDef = createRoute({
  method: "post",
  path: "/",
  summary: "Create a project (creator becomes admin)",
  request: { body: jsonBody(ProjectCreateInput) },
  responses: { 201: { description: "Created", ...jsonBody(Project) } },
});

const getRoute = createRoute({
  method: "get",
  path: "/{slug}",
  summary: "Project details",
  request: { params: slugParam },
  responses: { 200: { description: "Project", ...jsonBody(Project) } },
});

const patchRoute = createRoute({
  method: "patch",
  path: "/{slug}",
  summary: `Update project ${roleTag("project.update")}`,
  request: { params: slugParam, body: jsonBody(ProjectUpdateInput) },
  responses: { 200: { description: "Updated", ...jsonBody(Project) } },
});

const deleteRoute = createRoute({
  method: "delete",
  path: "/{slug}",
  summary: `Delete project ${roleTag("project.delete")}`,
  request: { params: slugParam },
  responses: { 204: { description: "Deleted" } },
});

const listMembersRoute = createRoute({
  method: "get",
  path: "/{slug}/members",
  summary: "List members",
  request: { params: slugParam },
  responses: {
    200: { description: "Members", ...jsonBody(z.array(Member)) },
  },
});

const addMemberRoute = createRoute({
  method: "post",
  path: "/{slug}/members",
  summary: `Add a member by their exact login ${roleTag("member.set")}`,
  request: { params: slugParam, body: jsonBody(MemberAddInput) },
  responses: { 201: { description: "Member added", ...jsonBody(Member) } },
});

const setMemberRoute = createRoute({
  method: "put",
  path: "/{slug}/members/{userId}",
  summary: `Add a member or change their role, never your own ${roleTag("member.set")}`,
  request: { params: memberParams, body: jsonBody(MemberSetInput) },
  responses: { 204: { description: "Member set" } },
});

const removeMemberRoute = createRoute({
  method: "delete",
  path: "/{slug}/members/{userId}",
  summary: `Remove a member, never yourself ${roleTag("member.remove")}`,
  request: { params: memberParams },
  responses: { 204: { description: "Member removed" } },
});

const listDenialsRoute = createRoute({
  method: "get",
  path: "/{slug}/access-denials",
  summary: `Agents told to stop asking for access here ${roleTag(
    "access_denial.list",
  )}`,
  request: { params: slugParam },
  responses: {
    200: { description: "Denials", ...jsonBody(z.array(AccessDenial)) },
  },
});

const setDenialRoute = createRoute({
  method: "put",
  path: "/{slug}/access-denials/{userId}",
  summary:
    "Stop offering this agent a link asking for access here; grants and " +
    `revokes nothing ${roleTag("access_denial.set")}`,
  request: { params: memberParams },
  responses: { 204: { description: "Denial recorded" } },
});

const removeDenialRoute = createRoute({
  method: "delete",
  path: "/{slug}/access-denials/{userId}",
  summary: `Let this agent ask for access here again ${roleTag(
    "access_denial.remove",
  )}`,
  request: { params: memberParams },
  responses: { 204: { description: "Denial removed" } },
});

export function projectRoutes() {
  const app = new OpenAPIHono<AppEnv>();

  app.openapi(listRoute, async (c) => {
    return c.json(await listProjects(c.get("appCtx"), c.get("user")), 200);
  });

  app.openapi(createRouteDef, async (c) => {
    const project = await createProject(
      c.get("appCtx"),
      c.get("user"),
      c.req.valid("json"),
    );
    return c.json(project, 201);
  });

  app.openapi(getRoute, async (c) => {
    const ctx = c.get("appCtx");
    const { project, role } = await requireCapability(
      ctx,
      c.get("user"),
      c.req.valid("param").slug,
      "project.read",
    );
    return c.json(
      {
        ...toProject(project, role),
        former_slugs: await formerSlugsOf(ctx.router.system(), project),
        block_clear_status_id: await blockClearStatusOf(ctx, project),
      },
      200,
    );
  });

  app.openapi(patchRoute, async (c) => {
    const project = await updateProject(
      c.get("appCtx"),
      c.get("user"),
      c.req.valid("param").slug,
      c.req.valid("json"),
    );
    return c.json(project, 200);
  });

  app.openapi(deleteRoute, async (c) => {
    await deleteProject(
      c.get("appCtx"),
      c.get("user"),
      c.req.valid("param").slug,
    );
    return c.body(null, 204);
  });

  app.openapi(listMembersRoute, async (c) => {
    return c.json(
      await listMembers(
        c.get("appCtx"),
        c.get("user"),
        c.req.valid("param").slug,
      ),
      200,
    );
  });

  app.openapi(addMemberRoute, async (c) => {
    const member = await addMemberByLogin(
      c.get("appCtx"),
      c.get("user"),
      c.req.valid("param").slug,
      c.req.valid("json"),
    );
    return c.json(member, 201);
  });

  app.openapi(setMemberRoute, async (c) => {
    const { slug, userId } = c.req.valid("param");
    await setMember(
      c.get("appCtx"),
      c.get("user"),
      slug,
      userId,
      c.req.valid("json").role,
    );
    return c.body(null, 204);
  });

  app.openapi(removeMemberRoute, async (c) => {
    const { slug, userId } = c.req.valid("param");
    await removeMember(c.get("appCtx"), c.get("user"), slug, userId);
    return c.body(null, 204);
  });

  app.openapi(listDenialsRoute, async (c) => {
    return c.json(
      await listDenials(
        c.get("appCtx"),
        c.get("user"),
        c.req.valid("param").slug,
      ),
      200,
    );
  });

  app.openapi(setDenialRoute, async (c) => {
    const { slug, userId } = c.req.valid("param");
    await setDenial(c.get("appCtx"), c.get("user"), slug, userId);
    return c.body(null, 204);
  });

  app.openapi(removeDenialRoute, async (c) => {
    const { slug, userId } = c.req.valid("param");
    await removeDenial(c.get("appCtx"), c.get("user"), slug, userId);
    return c.body(null, 204);
  });

  app.openapi(uploadIconRoute, async (c) => {
    const ctx = c.get("appCtx");
    const { project, role } = await requireCapability(
      ctx,
      c.get("user"),
      c.req.valid("param").slug,
      "project.update",
    );
    const { file } = c.req.valid("form");
    return c.json(
      toProject(await setProjectIcon(ctx, project, file), role),
      200,
    );
  });

  app.openapi(deleteIconRoute, async (c) => {
    const ctx = c.get("appCtx");
    const { project, role } = await requireCapability(
      ctx,
      c.get("user"),
      c.req.valid("param").slug,
      "project.update",
    );
    return c.json(toProject(await deleteProjectIcon(ctx, project), role), 200);
  });

  app.openapi(getIconRoute, async (c) => {
    const ctx = c.get("appCtx");
    // Same gate as GET /projects/{slug}: whoever can see the project's name
    // can see its icon, and nobody else learns it exists.
    const { project } = await requireCapability(
      ctx,
      c.get("user"),
      c.req.valid("param").slug,
      "project.read",
    );
    const icon = await openProjectIcon(ctx, project.id);
    const { stream, size } = await ctx.storage.getStream(icon.key);

    c.header("content-type", icon.contentType);
    c.header("content-length", String(size));
    c.header("content-disposition", "inline");
    c.header("x-content-type-options", "nosniff");
    // As on the avatar route: embedded cross-site this loads nothing. The
    // type is an allowlist result from setProjectIcon, not normalised here.
    c.header("cross-origin-resource-policy", "same-origin");
    // The URL carries a per-upload version, so a new image is a new URL
    // rather than a stale cache entry.
    c.header("cache-control", "private, max-age=31536000, immutable");
    return c.body(Readable.toWeb(stream) as ReadableStream);
  });

  return app;
}
