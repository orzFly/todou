import {
  AGENT_CONTEXT_HEADER,
  AGENT_CONTEXT_MAX_BYTES,
  AgentContext,
} from "@todou/shared";
import { createMiddleware } from "hono/factory";
import type { AppEnv } from "../auth/middleware.ts";
import { DomainError } from "../errors.ts";

/**
 * Sending the header is opt-in, but a present-and-broken one is a client
 * bug — reject loudly instead of silently dropping the metadata.
 */
class InvalidAgentContextError extends DomainError {
  constructor(message: string, details?: unknown) {
    super(400, "invalid_agent_context", message, details);
  }
}

export function agentContextMiddleware() {
  return createMiddleware<AppEnv>(async (c, next) => {
    const raw = c.req.header(AGENT_CONTEXT_HEADER);
    if (raw === undefined) {
      c.set("agentContext", null);
      return next();
    }
    if (Buffer.byteLength(raw, "utf8") > AGENT_CONTEXT_MAX_BYTES) {
      throw new InvalidAgentContextError(
        `${AGENT_CONTEXT_HEADER} exceeds ${AGENT_CONTEXT_MAX_BYTES} bytes`,
      );
    }
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      throw new InvalidAgentContextError(
        `${AGENT_CONTEXT_HEADER} is not valid JSON`,
      );
    }
    const parsed = AgentContext.safeParse(json);
    if (!parsed.success) {
      throw new InvalidAgentContextError(
        `${AGENT_CONTEXT_HEADER} does not match the AgentContext schema`,
        parsed.error.issues,
      );
    }
    c.set("agentContext", parsed.data);
    return next();
  });
}
