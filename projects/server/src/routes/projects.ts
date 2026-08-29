import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import {
  Member,
  MemberSetInput,
  Project,
  ProjectCreateInput,
  ProjectSlug,
  ProjectUpdateInput,
} from "@todou/shared";
import type { AppEnv } from "../auth/middleware.ts";
import { requireProject } from "../services/access.ts";
import { listMembers, removeMember, setMember } from "../services/members.ts";
import {
  createProject,
  deleteProject,
  formerSlugsOf,
  listProjects,
  toProject,
  updateProject,
} from "../services/projects.ts";

const slugParam = z.object({ slug: ProjectSlug });
const memberParams = z.object({
  slug: ProjectSlug,
  userId: z.coerce.number().int().positive(),
});

const jsonBody = <T extends z.ZodType>(schema: T) => ({
  content: { "application/json": { schema } },
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
  summary: "Update project (admin)",
  request: { params: slugParam, body: jsonBody(ProjectUpdateInput) },
  responses: { 200: { description: "Updated", ...jsonBody(Project) } },
});

const deleteRoute = createRoute({
  method: "delete",
  path: "/{slug}",
  summary: "Delete project (admin)",
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

const setMemberRoute = createRoute({
  method: "put",
  path: "/{slug}/members/{userId}",
  summary: "Add a member or change their role (admin)",
  request: { params: memberParams, body: jsonBody(MemberSetInput) },
  responses: { 204: { description: "Member set" } },
});

const removeMemberRoute = createRoute({
  method: "delete",
  path: "/{slug}/members/{userId}",
  summary: "Remove a member (admin)",
  request: { params: memberParams },
  responses: { 204: { description: "Member removed" } },
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
    const { project } = await requireProject(
      ctx,
      c.get("user"),
      c.req.valid("param").slug,
      "reader",
    );
    return c.json(
      {
        ...toProject(project),
        former_slugs: await formerSlugsOf(ctx.router.system(), project),
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

  return app;
}
