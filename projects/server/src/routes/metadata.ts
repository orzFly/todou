import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import {
  IssueMetadataList,
  IssueMetadataNamespaceList,
  IssueMetadataQuery,
  IssueMetadataWriteInput,
  ProjectRef,
} from "@todou/shared";
import type { AppEnv } from "../auth/middleware.ts";
import {
  listIssueMetadataNamespaces,
  readIssueMetadata,
  writeIssueMetadata,
} from "../services/metadata.ts";
import { movedResponses } from "./moved-responses.ts";
import { roleTag } from "./role-tag.ts";

const issueParams = z.object({
  slug: ProjectRef,
  number: z.coerce.number().int().positive(),
});
const jsonBody = <T extends z.ZodType>(schema: T) => ({
  content: { "application/json": { schema } },
});

const strangerResponse = {
  404: { description: "No such address, or neither project is readable" },
};

const readRoute = createRoute({
  method: "get",
  path: "/{slug}/issues/{number}/metadata",
  summary: `Metadata under the named namespaces ${roleTag("metadata.read")}`,
  description:
    "`namespace` is required — a request naming none is a typo rather " +
    "than a request for nothing. `*` returns every namespace. A namespace " +
    "with no entries is simply absent: there is no such state as an empty " +
    "namespace.",
  request: { params: issueParams, query: IssueMetadataQuery },
  responses: {
    200: { description: "Entries", ...jsonBody(IssueMetadataList) },
    ...movedResponses,
    ...strangerResponse,
  },
});

const namespacesRoute = createRoute({
  method: "get",
  path: "/{slug}/issues/{number}/metadata/namespaces",
  summary: `Which namespaces this issue holds ${roleTag("metadata.read")}`,
  description:
    "Names, key counts and the newest write in each group — no values.",
  request: { params: issueParams },
  responses: {
    200: {
      description: "Namespaces",
      ...jsonBody(IssueMetadataNamespaceList),
    },
    ...movedResponses,
    ...strangerResponse,
  },
});

const writeRoute = createRoute({
  method: "patch",
  path: "/{slug}/issues/{number}/metadata",
  summary: `Write metadata ${roleTag("metadata.write")}`,
  description:
    "Only the keys listed are touched; `value: null` deletes one, and the " +
    "empty string is a value like any other. `if_match` is a " +
    "compare-and-set with three states: absent writes unconditionally, " +
    "null expects the key to be absent, a string expects exactly that " +
    "value. A failed expectation answers 409 `metadata_precondition` with " +
    "the current values and stores nothing. Writing a value that is " +
    "already stored changes nothing and emits no event. The response is " +
    "the full new state of every namespace the request touched.",
  request: { params: issueParams, body: jsonBody(IssueMetadataWriteInput) },
  responses: {
    200: { description: "New state", ...jsonBody(IssueMetadataList) },
    ...movedResponses,
  },
});

export function metadataRoutes() {
  const app = new OpenAPIHono<AppEnv>();

  app.openapi(readRoute, async (c) => {
    const { slug, number } = c.req.valid("param");
    return c.json(
      await readIssueMetadata(
        c.get("appCtx"),
        c.get("user"),
        slug,
        number,
        c.req.valid("query").namespace,
      ),
      200,
    );
  });

  app.openapi(namespacesRoute, async (c) => {
    const { slug, number } = c.req.valid("param");
    return c.json(
      await listIssueMetadataNamespaces(
        c.get("appCtx"),
        c.get("user"),
        slug,
        number,
      ),
      200,
    );
  });

  app.openapi(writeRoute, async (c) => {
    const { slug, number } = c.req.valid("param");
    return c.json(
      await writeIssueMetadata(
        c.get("appCtx"),
        c.get("user"),
        slug,
        number,
        c.req.valid("json"),
      ),
      200,
    );
  });

  return app;
}
