import {
  type CrossChangeEvent,
  CrossChangeEvent as CrossChangeEventSchema,
  SSE_CHANGE_EVENT,
} from "./events.ts";
import type {
  AccessDenial,
  AccessHint,
  ActivityCalendarQueryInput,
  ActivityCalendarResponse,
  ActivityPage,
  Agent,
  AgentCreateInput,
  AgentMemberships,
  AgentUpdateInput,
  AnswersSubmitInput,
  Attachment,
  AuthMode,
  Autolink,
  AutolinkCreateInput,
  BlockRef,
  BulkReadInput,
  BurnQuery,
  BurnResponse,
  CliAuthApproveInput,
  CliAuthApproveResult,
  CliAuthPollInput,
  CliAuthPollResult,
  CliAuthRequestCreated,
  CliAuthRequestCreateInput,
  CliAuthRequestInfo,
  CommandSubmitInput,
  CommandSubmitResult,
  CommentComponentInput,
  CommentCreateResult,
  CommentHideResult,
  CommentLocation,
  CrossActivityPage,
  DirectUploadTicket,
  InboxPage,
  Issue,
  IssueCounts,
  IssueCreateInput,
  IssueListPage,
  IssueMetadataList,
  IssueMetadataNamespaceList,
  IssueMetadataWriteInput,
  IssueMuteInput,
  IssueQuestions,
  IssueReadInput,
  IssueUpdateInput,
  Label,
  LabelCreateInput,
  LabelUpdateInput,
  Me,
  Member,
  MemberAddInput,
  MemberRole,
  MePrefs,
  MePrefsPatch,
  MetadataNamespaceSelector,
  MeUpdateInput,
  MuteList,
  Project,
  ProjectCreateInput,
  ProjectUpdateInput,
  PublicUser,
  PutSettings,
  ReferenceConfig,
  ReferenceDirectory,
  RefFormatSetInput,
  ResolvedRef,
  RevisionPage,
  SearchFacets,
  SearchPage,
  Settings,
  SpecComments,
  SpecFiles,
  SpecInfo,
  SpecPushInput,
  SpecPushResult,
  SpecReviewResult,
  SpecReviewSubmitInput,
  SpecWithdrawInput,
  SpecWithdrawResult,
  Status,
  StatusCreateInput,
  StatusUpdateInput,
  TimelineComment,
  TimelineEvent,
  TimelinePage,
  TokenCreated,
  TokenCreateInput,
  TokenListItem,
  UserIssuesPage,
  UserProjects,
  VersionInfo,
} from "./index.ts";
import { type BatchStreamItem, SSE_BATCH_ITEM_EVENT } from "./schemas/batch.ts";
// Imported from their own modules rather than the barrel: these are values,
// and the barrel re-exports this file.
import {
  GoneBody,
  MovedTo,
  type MoveIssueInput,
  type MoveIssueResult,
} from "./schemas/move.ts";
import { CANONICAL_SLUG_HEADER } from "./schemas/project.ts";
import { SseDecoder } from "./sse.ts";

export type TodouClientOptions = {
  /**
   * Where the API is mounted: an origin, or an origin plus a path prefix
   * when the server sits under a subpath of a reverse proxy. A leading-slash
   * path alone means that prefix on the current origin; empty string means
   * the current origin's root (web app).
   */
  baseUrl?: string;
  /** Bearer PAT for agents/CLI; omitted = cookie session (web). */
  token?: string;
  /**
   * Extra headers on every request (e.g. x-todou-agent-context).
   * authorization and content-type cannot be overridden.
   */
  headers?: Record<string, string>;
  /**
   * Fetch-compatible adapter: synchronous throws are adapter/program errors.
   * Reject the returned promise with a TypeError for transport failure, or
   * AbortError for cancellation. Other rejections pass through unchanged.
   */
  fetch?: typeof fetch;
  /**
   * Coalesce same-tick GETs into one POST /api/batch exchange (T-91).
   * Off by default: only the web app's burst-y query fan-out profits;
   * sequential CLI calls would pay the macrotask delay for nothing.
   */
  batch?: boolean;
  /**
   * Called with the project's current slug whenever a response says the path
   * named something else (T-156) — a retired slug, or the project's id
   * (T-266). `requested` is the spelling the path used, which is how a
   * caller tells those two apart: only the first is worth nudging about.
   * Batched sub-requests carry no headers, so this is a hint, never
   * something to depend on for correctness.
   */
  onCanonicalSlug?: (canonical: string, requested: string | null) => void;
};

export class TodouError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;
  /**
   * The path this request was sent to, relative to `/api` and without any
   * reverse-proxy prefix — the same spelling the caller passed in (T-280).
   * Carried because an error envelope names no subject: "project not found"
   * with a path of `/projects/homelab/issues` is the only way a reporter
   * downstream learns *which* project could not be read.
   */
  readonly path?: string;

  constructor(
    status: number,
    code: string,
    message: string,
    details?: unknown,
    path?: string,
  ) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
    this.path = path;
  }
}

/** A transport failure while awaiting headers or consuming response bytes. */
export class TodouNetworkError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : "Network request failed");
    this.name = "TodouNetworkError";
    this.cause = cause;
  }
}

type Query = Record<
  string,
  string | number | boolean | Array<string | number> | undefined
>;

function queryString(query?: Query): string {
  if (!query) return "";
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined) continue;
    params.set(key, Array.isArray(value) ? value.join(",") : String(value));
  }
  const s = params.toString();
  return s === "" ? "" : `?${s}`;
}

/**
 * WebCrypto's digest only takes a complete buffer, so hashing costs the
 * file's size in memory; past this cap the optional checksum is skipped
 * so the ticket request stays a pure size probe. Sized above the
 * server's default 20 MB upload limit, so default deployments still
 * checksum everything they accept.
 */
const MAX_SHA256_BYTES = 32 * 1024 * 1024;

/** Mirrors the server's envelope cap (BATCH_MAX_REQUESTS). */
const BATCH_LIMIT = 50;

type BatchWaiter = {
  url: string;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
};

/**
 * A card (or one of its comments) has moved to another project and the
 * reader may follow (T-231). Carries the new address so a caller can retry
 * there; `movedTo.comment_id` is present only on the comment routes.
 */
export class MovedError extends TodouError {
  readonly movedTo: MovedTo;

  constructor(movedTo: MovedTo) {
    super(301, "moved", `moved to ${movedTo.slug}#${movedTo.number}`, movedTo);
    this.movedTo = movedTo;
  }
}

/** Moved somewhere the reader has no role. The body never names it. */
export class GoneError extends TodouError {
  readonly body: GoneBody;

  constructor(body: GoneBody) {
    super(410, "gone", "this issue moved to a project you cannot read", body);
    this.body = body;
  }
}

/**
 * The redirect bodies are not the error envelope every other status uses,
 * so they are parsed before the envelope reading below would mangle them.
 */
function errorFromBody(
  status: number,
  parsed: unknown,
  path?: string,
): TodouError {
  if (status === 301) {
    const moved = (parsed as { moved_to?: unknown } | null)?.moved_to;
    const result = MovedTo.safeParse(moved);
    if (result.success) return new MovedError(result.data);
  }
  if (status === 410) {
    const result = GoneBody.safeParse(parsed);
    if (result.success) return new GoneError(result.data);
  }
  const body = parsed as {
    error?: { code?: string; message?: string; details?: unknown };
  } | null;
  return new TodouError(
    status,
    body?.error?.code ?? "unknown",
    body?.error?.message ?? `${status}`,
    body?.error?.details,
    path,
  );
}

/**
 * The new address read back off a followed redirect's final URL.
 *
 * `fetch` follows a 301 on its own and discards the body doing so, leaving
 * the URL as the only surviving evidence — which is precisely why the
 * contract promises nothing in that body a client cannot also get from the
 * URL. Anything that is not one of our own JSON issue routes (a presigned
 * attachment redirect, say) is not a move and returns null.
 *
 * The test is "did we land under *our* mount point", not "does this path
 * contain /api/projects/… somewhere": a server mounted under a proxy subpath
 * gets its own prefix back on the `Location`, so the patterns have to match
 * past it, and merely unanchoring them would read a cross-host presigned
 * attachment redirect as a move (T-246).
 */
function movedToFromUrl(url: string, baseUrl: string): MovedTo | null {
  let path: string;
  try {
    const final = new URL(url);
    const base = new URL(baseUrl || "/", final);
    if (base.origin !== final.origin) return null;
    const prefix = base.pathname.replace(/\/$/, "");
    if (!final.pathname.startsWith(prefix)) return null;
    path = final.pathname.slice(prefix.length);
  } catch {
    return null;
  }
  const comment =
    /^\/api\/projects\/([^/]+)\/issues\/(\d+)\/comments\/(\d+)$/.exec(path);
  if (comment?.[1] !== undefined)
    return {
      slug: comment[1],
      number: Number(comment[2]),
      comment_id: Number(comment[3]),
    };
  const issue = /^\/api\/projects\/([^/]+)\/issues\/(\d+)(?:\/|$)/.exec(path);
  if (issue?.[1] !== undefined)
    return { slug: issue[1], number: Number(issue[2]) };
  // The attachment list addresses its issue through the query, so its new
  // address has no `/issues/{n}` segment for the rule above to find (T-245).
  // Without this, following that redirect would return the destination's
  // attachments as if they were the ones asked for — `attach list a/1`
  // quietly printing B's files. Anchored at `/attachments` so it cannot take
  // in `/attachments/{id}/download`, which travels the binary channel and is
  // meant to follow its redirect and hand back bytes.
  const list = /^\/api\/projects\/([^/]+)\/attachments$/.exec(path);
  if (list?.[1] !== undefined) {
    const number = Number(new URL(url).searchParams.get("issue_number"));
    if (Number.isInteger(number) && number > 0)
      return { slug: list[1], number };
  }
  return null;
}

export class TodouClient {
  #baseUrl: string;
  #token?: string;
  #headers?: Record<string, string>;
  #fetch: typeof fetch;
  #batch: boolean;
  #batchQueue: BatchWaiter[] = [];
  #onCanonicalSlug?: (canonical: string, requested: string | null) => void;
  /** Remembered per client: the backend has no batch endpoint. */
  #batchUnavailable = false;

  constructor(options?: TodouClientOptions) {
    this.#baseUrl = options?.baseUrl ?? "";
    this.#token = options?.token;
    this.#headers = options?.headers;
    this.#batch = options?.batch ?? false;
    this.#onCanonicalSlug = options?.onCanonicalSlug;
    // Never store the bare global fetch: calling it as `this.#fetch(...)`
    // rebinds `this` to the client and browsers throw
    // "'fetch' called on an object that does not implement interface Window".
    this.#fetch = options?.fetch ?? ((...args) => fetch(...args));
  }

  /**
   * Raw escape hatch for endpoints without a dedicated method (the CLI's
   * `todou api`). `path` is relative to `/api`; auth and error mapping
   * behave exactly like the typed methods.
   */
  async request<T>(
    method: string,
    path: string,
    init?: { json?: unknown; form?: FormData; query?: Query },
  ): Promise<T> {
    if (method === "GET" && this.#batch && !this.#batchUnavailable) {
      return this.#enqueueBatch(
        `${path}${queryString(init?.query)}`,
      ) as Promise<T>;
    }
    return this.#send(method, path, init);
  }

  /**
   * Like `request`, but hands back the untouched `Response` — the channel
   * for bodies that are not JSON (attachment downloads, `todou api` against
   * a binary endpoint). Auth, headers and error mapping are identical, which
   * is the point: a consumer that needs raw bytes still never has to
   * assemble a request, and therefore never has to get hold of the token
   * (T-176). Never batched — an envelope carries parsed bodies only.
   * `init.headers` adds per-call request headers (the batch channel's
   * `accept: text/event-stream`, negotiated on the response's
   * Content-Type); the two protected headers stay non-overridable.
   */
  async requestRaw(
    method: string,
    path: string,
    init?: {
      json?: unknown;
      form?: FormData;
      query?: Query;
      headers?: Record<string, string>;
    },
  ): Promise<Response> {
    const headers: Record<string, string> = {
      ...this.#headers,
      ...init?.headers,
    };
    if (this.#token) headers.authorization = `Bearer ${this.#token}`;
    let body: string | FormData | undefined;
    if (init?.json !== undefined) {
      headers["content-type"] = "application/json";
      body = JSON.stringify(init.json);
    } else if (init?.form) {
      body = init.form;
    }

    // Build the request before the transport boundary. A query getter or
    // synchronous custom fetch adapter bug must keep its original identity.
    const url = `${this.#baseUrl}/api${path}${queryString(init?.query)}`;
    const request = {
      method,
      headers,
      body,
      credentials: "same-origin" as const,
    };
    const response = this.#fetch(url, request);
    let res: Response;
    try {
      res = await response;
    } catch (error) {
      if (
        error instanceof TypeError ||
        (error instanceof DOMException &&
          (error.name === "TimeoutError" || error.name === "NetworkError"))
      ) {
        throw new TodouNetworkError(error);
      }
      throw error;
    }
    if (!res.ok) {
      let parsed: unknown = null;
      try {
        parsed = await res.json();
      } catch {
        // Non-JSON error body; errorFromBody keeps status as message.
      }
      throw errorFromBody(res.status, parsed, path);
    }
    if (this.#onCanonicalSlug !== undefined) {
      const canonical = res.headers.get(CANONICAL_SLUG_HEADER);
      if (canonical !== null) {
        this.#onCanonicalSlug(
          canonical,
          /^\/projects\/([^/?#]+)/.exec(path)?.[1] ?? null,
        );
      }
    }
    return res;
  }

  /**
   * The JSON channel, and therefore the one that turns a followed redirect
   * back into a `MovedError`. `requestRaw` deliberately does not: it is the
   * binary channel (`attach download`, `todou api`), where following the
   * redirect and getting the bytes is the whole point.
   */
  async #send<T>(
    method: string,
    path: string,
    init?: { json?: unknown; form?: FormData; query?: Query },
  ): Promise<T> {
    const res = await this.requestRaw(method, path, init);
    if (method === "GET" && res.redirected) {
      const movedTo = movedToFromUrl(res.url, this.#baseUrl);
      if (movedTo !== null) throw new MovedError(movedTo);
    }
    if (res.status === 204) return undefined as T;
    // Consume the response stream before parsing. Only rejected body reads
    // shaped like transport failures get network identity; JSON syntax and
    // application errors remain outside this I/O boundary.
    const bodyRead = res.text();
    let text: string;
    try {
      text = await bodyRead;
    } catch (error) {
      if (
        error instanceof TypeError ||
        (error instanceof DOMException &&
          (error.name === "EncodingError" ||
            error.name === "NetworkError" ||
            error.name === "TimeoutError"))
      ) {
        throw new TodouNetworkError(error);
      }
      throw error;
    }
    return JSON.parse(text) as T;
  }

  /**
   * Same-tick GETs coalesce into one POST /api/batch (T-91); the
   * macrotask boundary lets every query mounted by one render commit
   * join before the flush (same trick as the web's issue-refs batcher).
   * A single queued request skips the envelope so plain HTTP semantics
   * (and server logs) stay the norm outside bursts.
   */
  #enqueueBatch(url: string): Promise<unknown> {
    return new Promise((resolve, reject) => {
      this.#batchQueue.push({ url, resolve, reject });
      if (this.#batchQueue.length === 1) {
        setTimeout(() => void this.#flushBatch(), 0);
      }
    });
  }

  async #flushBatch(): Promise<void> {
    const queue = this.#batchQueue;
    this.#batchQueue = [];
    if (queue.length === 1) {
      const item = queue[0] as BatchWaiter;
      this.#send<unknown>("GET", item.url).then(item.resolve, item.reject);
      return;
    }
    for (let i = 0; i < queue.length; i += BATCH_LIMIT) {
      await this.#sendBatchChunk(queue.slice(i, i + BATCH_LIMIT));
    }
  }

  async #sendBatchChunk(chunk: BatchWaiter[]): Promise<void> {
    let res: Response;
    try {
      // The accept header is a negotiation, not a demand: a server without
      // the stream answers with the JSON envelope, and the response's
      // Content-Type decides which reading applies.
      res = await this.requestRaw("POST", "/batch", {
        json: { requests: chunk.map(({ url }) => ({ url })) },
        headers: { accept: "text/event-stream" },
      });
    } catch (error) {
      // 404/405 = a server predating the gateway: remember, fall back to
      // direct sends for this chunk, and never try the envelope again.
      if (
        error instanceof TodouError &&
        (error.status === 404 || error.status === 405)
      ) {
        this.#batchUnavailable = true;
        for (const item of chunk) {
          this.#send<unknown>("GET", item.url).then(item.resolve, item.reject);
        }
        return;
      }
      for (const item of chunk) item.reject(error);
      return;
    }

    // A waiter is settled exactly once: duplicate or out-of-range indices in
    // a stream (or missing entries in an envelope) leave the rest for the
    // shared mismatch rejection below.
    const settled = new Set<number>();
    const settle = (index: number, status: number, body: unknown): void => {
      const item = chunk[index];
      if (item === undefined || settled.has(index)) return;
      settled.add(index);
      if (status >= 200 && status < 300) {
        item.resolve(status === 204 ? undefined : body);
      } else {
        item.reject(errorFromBody(status, body, item.url));
      }
    };

    // Read errors (a reset connection, a malformed frame, a 200 that is not
    // the envelope) must reject the unsatisfied waiters rather than escape:
    // the flush is fire-and-forget, so an exception here would otherwise
    // strand every pending caller in this chunk — and every later chunk.
    try {
      if (res.headers.get("content-type")?.includes("text/event-stream")) {
        // item frames settle waiters as they arrive; the done frame is
        // skipped — a truncated stream is reported through the same
        // missing-waiter path as a short envelope, so its count is
        // informational on the wire, nothing the client needs to track.
        const reader = res.body?.getReader();
        if (reader === undefined) throw new Error("stream without a body");
        const text = new TextDecoder();
        const decoder = new SseDecoder();
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          for (const frame of decoder.push(
            text.decode(value, { stream: true }),
          )) {
            if (frame.event !== SSE_BATCH_ITEM_EVENT) continue;
            const item = JSON.parse(frame.data) as BatchStreamItem;
            settle(item.index, item.status, item.body);
          }
        }
      } else {
        const envelope = (await res.json()) as {
          responses: Array<{ status: number; body: unknown }>;
        };
        envelope.responses.forEach((result, i) => {
          settle(i, result.status, result.body);
        });
      }
    } catch {
      // Fall through to the mismatch rejection: an unreadable body is
      // indistinguishable from a truncated stream, and the waiters must
      // not outlive the exchange.
    }

    for (const [i, item] of chunk.entries()) {
      if (settled.has(i)) continue;
      item.reject(
        new TodouError(502, "batch_mismatch", "missing batch response"),
      );
    }
  }

  version = () => this.request<VersionInfo>("GET", "/version");

  // — auth / me —
  authMode = () => this.request<AuthMode>("GET", "/auth/mode");
  login = () => this.request<Me>("POST", "/auth/login");
  logout = () => this.request<void>("POST", "/auth/logout");
  me = () => this.request<Me>("GET", "/me");
  updateMe = (input: MeUpdateInput) =>
    this.request<Me>("PATCH", "/me", { json: input });
  uploadMyAvatar = (file: File) => {
    const form = new FormData();
    form.set("file", file);
    return this.request<Me>("POST", "/me/avatar", { form });
  };
  deleteMyAvatar = () => this.request<Me>("DELETE", "/me/avatar");
  getMyPrefs = () => this.request<MePrefs>("GET", "/me/prefs");
  patchMyPrefs = (input: MePrefsPatch) =>
    this.request<MePrefs>("PATCH", "/me/prefs", { json: input });
  getInbox = (query?: Query) =>
    this.request<InboxPage>("GET", "/me/inbox", { query });
  markAllRead = (input: BulkReadInput = {}) =>
    this.request<void>("PUT", "/me/read", { json: input });
  createMyToken = (input: TokenCreateInput) =>
    this.request<TokenCreated>("POST", "/me/tokens", { json: input });
  /**
   * Whether to print an access link for `target`, and whose name goes in it
   * (T-280). Answers about the caller's own denial record only, so it says
   * nothing about whether `target` names a project at all.
   */
  accessHint = (target: string) =>
    this.request<AccessHint>("GET", "/me/access-hint", { query: { target } });

  // — CLI device authorization (T-140) —
  // The first two are the only calls a not-yet-logged-in CLI makes, so they
  // run on a token-less client (like authMode); the rest need a web session.
  createCliAuthRequest = (input: CliAuthRequestCreateInput) =>
    this.request<CliAuthRequestCreated>("POST", "/auth/cli/requests", {
      json: input,
    });
  pollCliAuthRequest = (id: number, input: CliAuthPollInput) =>
    this.request<CliAuthPollResult>("POST", `/auth/cli/requests/${id}/poll`, {
      json: input,
    });
  getCliAuthRequestByCode = (code: string) =>
    this.request<CliAuthRequestInfo>(
      "GET",
      `/auth/cli/requests/by-code/${code}`,
    );
  approveCliAuthRequest = (id: number, input: CliAuthApproveInput) =>
    this.request<CliAuthApproveResult>(
      "POST",
      `/auth/cli/requests/${id}/approve`,
      { json: input },
    );
  denyCliAuthRequest = (id: number) =>
    this.request<void>("POST", `/auth/cli/requests/${id}/deny`);
  listMyTokens = () => this.request<TokenListItem[]>("GET", "/me/tokens");
  revokeMyToken = (id: number) =>
    this.request<void>("DELETE", `/me/tokens/${id}`);

  // — agents —
  createAgent = (input: AgentCreateInput) =>
    this.request<Agent>("POST", "/agents", { json: input });
  listAgents = (owner: "me" | "all" = "me") =>
    this.request<Agent[]>("GET", "/agents", { query: { owner } });
  updateAgent = (id: number, input: AgentUpdateInput) =>
    this.request<Agent>("PATCH", `/agents/${id}`, { json: input });
  uploadAgentAvatar = (id: number, file: File) => {
    const form = new FormData();
    form.set("file", file);
    return this.request<Agent>("POST", `/agents/${id}/avatar`, { form });
  };
  deleteAgentAvatar = (id: number) =>
    this.request<Agent>("DELETE", `/agents/${id}/avatar`);
  disableAgent = (id: number) => this.request<void>("DELETE", `/agents/${id}`);
  enableAgent = (id: number) =>
    this.request<Agent>("POST", `/agents/${id}/enable`);
  issueAgentToken = (id: number, input: TokenCreateInput) =>
    this.request<TokenCreated>("POST", `/agents/${id}/tokens`, {
      json: input,
    });
  listAgentTokens = (id: number) =>
    this.request<TokenListItem[]>("GET", `/agents/${id}/tokens`);
  revokeAgentToken = (id: number, tokenId: number) =>
    this.request<void>("DELETE", `/agents/${id}/tokens/${tokenId}`);
  listAgentMemberships = () =>
    this.request<AgentMemberships>("GET", "/me/agent-memberships");

  // — projects —
  listProjects = () => this.request<Project[]>("GET", "/projects");
  createProject = (input: ProjectCreateInput) =>
    this.request<Project>("POST", "/projects", { json: input });
  getProject = (slug: string) =>
    this.request<Project>("GET", `/projects/${slug}`);
  updateProject = (slug: string, input: ProjectUpdateInput) =>
    this.request<Project>("PATCH", `/projects/${slug}`, { json: input });
  uploadProjectIcon = (ref: string, file: File) => {
    const form = new FormData();
    form.set("file", file);
    return this.request<Project>("POST", `/projects/${ref}/icon`, { form });
  };
  deleteProjectIcon = (ref: string) =>
    this.request<Project>("DELETE", `/projects/${ref}/icon`);

  getInsightsSettings = (slug: string) =>
    this.request<Settings>("GET", `/projects/${slug}/insights/settings`);
  updateInsightsSettings = (slug: string, input: PutSettings) =>
    this.request<Settings>("PUT", `/projects/${slug}/insights/settings`, {
      json: input,
    });
  getInsightsBurn = (slug: string, query: BurnQuery) =>
    this.request<BurnResponse>("GET", `/projects/${slug}/insights/burn`, {
      query: { ...query },
    });
  getProjectActivityCalendar = (
    slug: string,
    query: ActivityCalendarQueryInput,
  ) =>
    this.request<ActivityCalendarResponse>(
      "GET",
      `/projects/${encodeURIComponent(slug)}/insights/activity`,
      { query: { ...query } },
    );

  /**
   * One account's public identity. `ref` is a user id when all digits, a
   * login otherwise — the same rule `/api/users/{ref}` reads.
   */
  getUser = (ref: string | number) =>
    this.request<PublicUser>("GET", `/users/${ref}`);
  getUserActivityCalendar = (
    ref: string | number,
    query: ActivityCalendarQueryInput,
  ) =>
    this.request<ActivityCalendarResponse>(
      "GET",
      `/users/${encodeURIComponent(String(ref))}/activity`,
      { query: { ...query } },
    );

  /** Both lists are scoped to what the CALLER can read, not the subject. */
  listUserIssues = (ref: string | number, query?: Query) =>
    this.request<UserIssuesPage>("GET", `/users/${ref}/issues`, { query });
  listUserProjects = (ref: string | number) =>
    this.request<UserProjects>("GET", `/users/${ref}/projects`, {});
  deleteProject = (slug: string) =>
    this.request<void>("DELETE", `/projects/${slug}`);

  listMembers = (slug: string) =>
    this.request<Member[]>("GET", `/projects/${slug}/members`);
  addMember = (slug: string, input: MemberAddInput) =>
    this.request<Member>("POST", `/projects/${slug}/members`, { json: input });
  setMember = (slug: string, userId: number, role: MemberRole) =>
    this.request<void>("PUT", `/projects/${slug}/members/${userId}`, {
      json: { role },
    });
  removeMember = (slug: string, userId: number) =>
    this.request<void>("DELETE", `/projects/${slug}/members/${userId}`);

  listAccessDenials = (slug: string) =>
    this.request<AccessDenial[]>("GET", `/projects/${slug}/access-denials`);
  denyAccess = (slug: string, userId: number) =>
    this.request<void>("PUT", `/projects/${slug}/access-denials/${userId}`);
  allowAccess = (slug: string, userId: number) =>
    this.request<void>("DELETE", `/projects/${slug}/access-denials/${userId}`);

  listStatuses = (slug: string) =>
    this.request<Status[]>("GET", `/projects/${slug}/statuses`);
  createStatus = (slug: string, input: StatusCreateInput) =>
    this.request<Status>("POST", `/projects/${slug}/statuses`, {
      json: input,
    });
  updateStatus = (slug: string, id: number, input: StatusUpdateInput) =>
    this.request<Status>("PATCH", `/projects/${slug}/statuses/${id}`, {
      json: input,
    });
  deleteStatus = (slug: string, id: number) =>
    this.request<void>("DELETE", `/projects/${slug}/statuses/${id}`);

  getReferenceConfig = (slug: string) =>
    this.request<ReferenceConfig>("GET", `/projects/${slug}/references/config`);
  getReferenceDirectory = () =>
    this.request<ReferenceDirectory>("GET", "/me/reference-directory");
  resolveRef = (ref: string) =>
    this.request<ResolvedRef>("GET", "/me/refs/resolve", { query: { ref } });
  setReferenceFormat = (slug: string, input: RefFormatSetInput) =>
    this.request<ReferenceConfig>(
      "PUT",
      `/projects/${slug}/references/format`,
      { json: input },
    );
  createAutolink = (slug: string, input: AutolinkCreateInput) =>
    this.request<Autolink>("POST", `/projects/${slug}/references/autolinks`, {
      json: input,
    });
  deleteAutolink = (slug: string, id: number) =>
    this.request<void>(
      "DELETE",
      `/projects/${slug}/references/autolinks/${id}`,
    );

  listLabels = (slug: string) =>
    this.request<Label[]>("GET", `/projects/${slug}/labels`);
  createLabel = (slug: string, input: LabelCreateInput) =>
    this.request<Label>("POST", `/projects/${slug}/labels`, { json: input });
  updateLabel = (slug: string, id: number, input: LabelUpdateInput) =>
    this.request<Label>("PATCH", `/projects/${slug}/labels/${id}`, {
      json: input,
    });
  deleteLabel = (slug: string, id: number) =>
    this.request<void>("DELETE", `/projects/${slug}/labels/${id}`);

  // — issues —
  listIssues = (slug: string, query?: Query) =>
    this.request<IssueListPage>("GET", `/projects/${slug}/issues`, { query });
  getIssueCounts = (slug: string, query?: Query) =>
    this.request<IssueCounts>("GET", `/projects/${slug}/issues/counts`, {
      query,
    });
  createIssue = (slug: string, input: IssueCreateInput) =>
    this.request<Issue>("POST", `/projects/${slug}/issues`, { json: input });
  getIssue = (
    slug: string,
    number: number,
    /** `metadata` fetches those namespaces with the card (T-282). */
    opts?: { metadata?: MetadataNamespaceSelector },
  ) =>
    this.request<Issue>("GET", `/projects/${slug}/issues/${number}`, {
      query: { metadata: opts?.metadata },
    });
  updateIssue = (slug: string, number: number, input: IssueUpdateInput) =>
    this.request<Issue>("PATCH", `/projects/${slug}/issues/${number}`, {
      json: input,
    });
  /** Move an issue to the trash — reversible, see restoreIssue (T-145). */
  deleteIssue = (slug: string, number: number) =>
    this.request<void>("DELETE", `/projects/${slug}/issues/${number}`);
  restoreIssue = (slug: string, number: number) =>
    this.request<Issue>("POST", `/projects/${slug}/issues/${number}/restore`);
  moveIssue = (slug: string, number: number, input: MoveIssueInput) =>
    this.request<MoveIssueResult>(
      "POST",
      `/projects/${slug}/issues/${number}/move`,
      { json: input },
    );
  /**
   * Metadata under the named namespaces (T-282). `namespace` is required —
   * `"*"` for all of them — because asking for none is a typo rather than a
   * request for nothing.
   */
  getIssueMetadata = (
    slug: string,
    number: number,
    namespaces: MetadataNamespaceSelector,
  ) =>
    this.request<IssueMetadataList>(
      "GET",
      `/projects/${slug}/issues/${number}/metadata`,
      { query: { namespace: namespaces } },
    );
  listIssueMetadataNamespaces = (slug: string, number: number) =>
    this.request<IssueMetadataNamespaceList>(
      "GET",
      `/projects/${slug}/issues/${number}/metadata/namespaces`,
    );
  /** Answers with the whole new state of every namespace it touched. */
  writeIssueMetadata = (
    slug: string,
    number: number,
    input: IssueMetadataWriteInput,
  ) =>
    this.request<IssueMetadataList>(
      "PATCH",
      `/projects/${slug}/issues/${number}/metadata`,
      { json: input },
    );
  /**
   * Block edges (T-377). `ref` is any spelling the deployment resolves —
   * `#31`, `T-31`, `acme#31`, a stored `/projects/7/issues/31` — and each
   * add answers with the card's whole set in that direction, because
   * redrawing that section is what the caller does next.
   */
  addIssueBlockedBy = (slug: string, number: number, ref: string) =>
    this.request<{ blocked_by: BlockRef[] }>(
      "POST",
      `/projects/${slug}/issues/${number}/blocked-by`,
      { json: { ref } },
    );
  removeIssueBlockedBy = (slug: string, number: number, edgeId: number) =>
    this.request<void>(
      "DELETE",
      `/projects/${slug}/issues/${number}/blocked-by/${edgeId}`,
    );
  addIssueBlocks = (slug: string, number: number, ref: string) =>
    this.request<{ blocks: BlockRef[] }>(
      "POST",
      `/projects/${slug}/issues/${number}/blocks`,
      { json: { ref } },
    );
  removeIssueBlocks = (slug: string, number: number, edgeId: number) =>
    this.request<void>(
      "DELETE",
      `/projects/${slug}/issues/${number}/blocks/${edgeId}`,
    );

  markIssueRead = (slug: string, number: number, input: IssueReadInput = {}) =>
    this.request<void>("PUT", `/projects/${slug}/issues/${number}/read`, {
      json: input,
    });

  muteIssue = (slug: string, number: number, input: IssueMuteInput) =>
    this.request<void>("PUT", `/projects/${slug}/issues/${number}/mute`, {
      json: input,
    });
  unmuteIssue = (slug: string, number: number) =>
    this.request<void>("DELETE", `/projects/${slug}/issues/${number}/mute`);
  muteProject = (slug: string) =>
    this.request<void>("PUT", `/projects/${slug}/mute`);
  unmuteProject = (slug: string) =>
    this.request<void>("DELETE", `/projects/${slug}/mute`);
  getMutes = () => this.request<MuteList>("GET", "/me/mutes");

  // — search —
  search = (slug: string, query: Query) =>
    this.request<SearchPage>("GET", `/projects/${slug}/search`, { query });

  searchFacets = (slug: string) =>
    this.request<SearchFacets>("GET", `/projects/${slug}/search/facets`);

  // — timeline / comments —
  getTimeline = (
    slug: string,
    number: number,
    query?: {
      before?: string;
      after?: string;
      last?: boolean;
      limit?: number;
      types?: string;
      exclude_actor?: number;
      exclude_agent_session?: string;
      include_hidden?: boolean;
    },
  ) =>
    this.request<TimelinePage>(
      "GET",
      `/projects/${slug}/issues/${number}/timeline`,
      { query: query ? { ...query, last: query.last ? 1 : undefined } : {} },
    );
  getActivity = (
    slug: string,
    query?: {
      after?: string;
      last?: boolean;
      limit?: number;
      types?: string;
      exclude_actor?: number;
      exclude_agent_session?: string;
      include_hidden?: boolean;
    },
  ) =>
    this.request<ActivityPage>("GET", `/projects/${slug}/activity`, {
      query: query ? { ...query, last: query.last ? 1 : undefined } : {},
    });
  getCrossActivity = (query?: {
    projects?: string;
    after?: string;
    last?: boolean;
    limit?: number;
    types?: string;
    exclude_actor?: number;
    exclude_agent_session?: string;
    include_hidden?: boolean;
  }) =>
    this.request<CrossActivityPage>("GET", "/activity", {
      query: query ? { ...query, last: query.last ? 1 : undefined } : {},
    });
  createComment = (
    slug: string,
    number: number,
    body: string,
    component?: CommentComponentInput,
  ) =>
    this.request<CommentCreateResult>(
      "POST",
      `/projects/${slug}/issues/${number}/comments`,
      { json: component === undefined ? { body } : { body, component } },
    );
  /** Comment plus incremental commands, one transaction (T-161). */
  submitCommands = (slug: string, number: number, input: CommandSubmitInput) =>
    this.request<CommandSubmitResult>(
      "POST",
      `/projects/${slug}/issues/${number}/commands`,
      { json: input },
    );
  locateComment = (slug: string, commentId: number) =>
    this.request<CommentLocation>(
      "GET",
      `/projects/${slug}/comments/${commentId}`,
    );
  getComment = (slug: string, number: number, commentId: number) =>
    this.request<TimelineComment>(
      "GET",
      `/projects/${slug}/issues/${number}/comments/${commentId}`,
    );
  updateComment = (
    slug: string,
    number: number,
    commentId: number,
    body: string,
  ) =>
    this.request<TimelineComment>(
      "PATCH",
      `/projects/${slug}/issues/${number}/comments/${commentId}`,
      { json: { body } },
    );
  deleteComment = (slug: string, number: number, commentId: number) =>
    this.request<void>(
      "DELETE",
      `/projects/${slug}/issues/${number}/comments/${commentId}`,
    );
  /** Hide or unhide comments, one transaction per call (T-281). */
  setCommentsHidden = (
    slug: string,
    number: number,
    input: { hidden: boolean; comment_ids: number[] },
  ) =>
    this.request<CommentHideResult>(
      "POST",
      `/projects/${slug}/issues/${number}/comments/hide`,
      { json: input },
    );

  // — questions (T-19) —
  getIssueQuestions = (slug: string, number: number) =>
    this.request<IssueQuestions>(
      "GET",
      `/projects/${slug}/issues/${number}/questions`,
    );
  submitAnswers = (
    slug: string,
    number: number,
    commentId: number,
    input: AnswersSubmitInput,
  ) =>
    this.request<TimelineEvent>(
      "POST",
      `/projects/${slug}/issues/${number}/comments/${commentId}/answers`,
      { json: input },
    );

  // — spec (T-23) —
  getSpec = (slug: string, number: number) =>
    this.request<SpecInfo>("GET", `/projects/${slug}/issues/${number}/spec`);
  getSpecFiles = (slug: string, number: number, version?: number) =>
    this.request<SpecFiles>(
      "GET",
      `/projects/${slug}/issues/${number}/spec/files`,
      { query: { version } },
    );
  pushSpec = (slug: string, number: number, input: SpecPushInput) =>
    this.request<SpecPushResult>(
      "POST",
      `/projects/${slug}/issues/${number}/spec/push`,
      { json: input },
    );
  withdrawSpec = (slug: string, number: number, input: SpecWithdrawInput) =>
    this.request<SpecWithdrawResult>(
      "POST",
      `/projects/${slug}/issues/${number}/spec/withdraw`,
      { json: input },
    );
  submitSpecReview = (
    slug: string,
    number: number,
    input: SpecReviewSubmitInput,
  ) =>
    this.request<SpecReviewResult>(
      "POST",
      `/projects/${slug}/issues/${number}/spec/reviews`,
      { json: input },
    );
  getSpecComments = (slug: string, number: number) =>
    this.request<SpecComments>(
      "GET",
      `/projects/${slug}/issues/${number}/spec/comments`,
    );
  resolveSpecComments = (slug: string, number: number, commentIds: number[]) =>
    this.request<{ resolved: number[] }>(
      "POST",
      `/projects/${slug}/issues/${number}/spec/comments/resolve`,
      { json: { comment_ids: commentIds } },
    );

  // — edit history —
  getIssueRevisions = (slug: string, number: number, query?: Query) =>
    this.request<RevisionPage>(
      "GET",
      `/projects/${slug}/issues/${number}/revisions`,
      { query },
    );
  getCommentRevisions = (
    slug: string,
    number: number,
    commentId: number,
    query?: Query,
  ) =>
    this.request<RevisionPage>(
      "GET",
      `/projects/${slug}/issues/${number}/comments/${commentId}/revisions`,
      { query },
    );

  // — attachments —
  listAttachments = (slug: string, issueNumber: number) =>
    this.request<Attachment[]>("GET", `/projects/${slug}/attachments`, {
      query: { issue_number: issueNumber },
    });
  uploadAttachment = async (
    slug: string,
    issueNumber: number,
    file: File,
  ): Promise<Attachment> => {
    if (!this.#directUploadUnavailable) {
      const direct = await this.#tryDirectUpload(slug, issueNumber, file);
      if (direct) return direct;
    }
    const form = new FormData();
    form.set("file", file);
    form.set("issue_number", String(issueNumber));
    return this.request<Attachment>("POST", `/projects/${slug}/attachments`, {
      form,
    });
  };

  /** Remembered per client: the backend said it cannot presign. */
  #directUploadUnavailable = false;

  /**
   * Direct-upload path (s3 backends): presigned ticket → PUT straight to
   * the store → register. Returns null to signal "use multipart instead":
   * definitive unavailability (dedicated 409 code, or the 404 of an older
   * server without the endpoint) is remembered; a failure of just this
   * attempt (store unreachable, ticket expired) is not — the abandoned
   * ticket is the server gc's to reap. Anything else (validation, missing
   * issue, permissions) would fail multipart identically, so it surfaces.
   */
  #tryDirectUpload = async (
    slug: string,
    issueNumber: number,
    file: File,
  ): Promise<Attachment | null> => {
    const sha256 = await this.#sha256(file);
    let ticket: DirectUploadTicket;
    try {
      ticket = await this.request<DirectUploadTicket>(
        "POST",
        `/projects/${slug}/attachments/direct-uploads`,
        {
          json: {
            issue_number: issueNumber,
            filename: file.name,
            content_type: file.type || "application/octet-stream",
            size: file.size,
            ...(sha256 ? { sha256 } : {}),
          },
        },
      );
    } catch (err) {
      if (
        err instanceof TodouError &&
        (err.code === "direct_upload_unavailable" ||
          (err.status === 404 && err.code === "unknown"))
      ) {
        this.#directUploadUnavailable = true;
        return null;
      }
      throw err;
    }
    try {
      const put = await this.#fetch(ticket.url, {
        method: "PUT",
        body: file,
        headers: ticket.headers,
      });
      if (!put.ok) return null;
      return await this.request<Attachment>(
        "POST",
        `/projects/${slug}/attachments/direct-uploads/${ticket.upload_id}/complete`,
      );
    } catch {
      return null;
    }
  };

  /**
   * base64 SHA-256; omitted when the runtime lacks WebCrypto or the
   * file is too large to buffer whole (see MAX_SHA256_BYTES).
   */
  #sha256 = async (file: File): Promise<string | undefined> => {
    const subtle = globalThis.crypto?.subtle;
    if (!subtle || file.size > MAX_SHA256_BYTES) return undefined;
    try {
      const digest = await subtle.digest("SHA-256", await file.arrayBuffer());
      return btoa(String.fromCharCode(...new Uint8Array(digest)));
    } catch {
      return undefined;
    }
  };

  /** EventSource URL for the project change feed. */
  eventsUrl = (slug: string) => `${this.#baseUrl}/api/projects/${slug}/events`;

  /**
   * EventSource URL for the user-level cross-project feed (T-122).
   *
   * `inbox` asks the server to judge every event against the caller's inbox
   * and stamp the answer on it (T-273). Opt-in and spelled at the call site
   * because it costs the server a handful of queries per event: worth it
   * for a client that keeps an inbox badge on screen, waste for one that
   * treats events as a bare nudge to refetch something else.
   */
  userEventsUrl = (opts?: {
    inbox?: boolean;
    /** Namespaces whose metadata events this stream wants (T-282). */
    metadata?: MetadataNamespaceSelector;
  }) =>
    `${this.#baseUrl}/api/events${queryString({
      inbox: opts?.inbox ? "1" : undefined,
      metadata: opts?.metadata,
    })}`;

  /**
   * Subscribes to the user-level change feed (T-122) over plain `fetch`
   * rather than EventSource, which cannot carry an Authorization header —
   * the only way a token-authenticated client identifies itself.
   *
   * Resolves once the response headers prove the feed exists; frames are
   * then dispatched from a background reader until the stream ends. Every
   * way of *not* getting a feed throws a TodouError carrying the response
   * status, so callers can sort "this server has no such endpoint" (404,
   * permanent) from "the server is having a moment" (5xx, retry) with the
   * same classifier they already use for REST calls.
   *
   * Events are pointers, never data (see ChangeEvent): a subscriber learns
   * that something changed and refetches it through the authorized API.
   */
  openChangeStream = async (opts: {
    onEvent: (event: CrossChangeEvent) => void;
    /** Any bytes at all, framed or not — liveness for stall detection. */
    onAlive?: () => void;
  }): Promise<ChangeStream> => {
    const headers: Record<string, string> = {
      ...this.#headers,
      accept: "text/event-stream",
    };
    if (this.#token) headers.authorization = `Bearer ${this.#token}`;
    const abort = new AbortController();
    const res = await this.#fetch(`${this.#baseUrl}/api/events`, {
      method: "GET",
      headers,
      credentials: "same-origin",
      signal: abort.signal,
    });
    if (!res.ok) {
      let parsed: unknown = null;
      try {
        parsed = await res.json();
      } catch {
        // Non-JSON error body; errorFromBody keeps status as message.
      }
      throw errorFromBody(res.status, parsed, "/events");
    }
    const contentType = res.headers.get("content-type") ?? "";
    if (!res.body || !contentType.includes("text/event-stream")) {
      // A 2xx that is not a stream is something else answering for the
      // server (a login page, a caching proxy). Reported with the real
      // status so it classifies as permanent, not as a transient blip.
      throw new TodouError(
        res.status,
        "not_event_stream",
        `expected text/event-stream, got ${contentType || "an empty body"}`,
      );
    }

    const reader = res.body.getReader();
    const text = new TextDecoder();
    const decoder = new SseDecoder();
    // Frames from one chunk are dispatched synchronously, without an await
    // between them: a caller that resumes on this promise has therefore
    // seen everything the network had already delivered.
    const closed = (async () => {
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          opts.onAlive?.();
          for (const frame of decoder.push(
            text.decode(value, { stream: true }),
          )) {
            if (frame.event !== SSE_CHANGE_EVENT) continue;
            let event: CrossChangeEvent;
            try {
              event = CrossChangeEventSchema.parse(JSON.parse(frame.data));
            } catch {
              continue; // A frame we cannot read is one we cannot act on.
            }
            opts.onEvent(event);
          }
        }
      } catch {
        // A dropped stream is ordinary, not exceptional: it ends here and
        // the caller decides whether to reconnect.
      }
    })();

    return {
      closed,
      close: () => {
        abort.abort();
        void reader.cancel().catch(() => {});
      },
    };
  };
}

/** A live subscription to the change feed; see `openChangeStream`. */
export type ChangeStream = {
  /** Resolves when the stream ends — dropped, failed, or closed. */
  closed: Promise<void>;
  close: () => void;
};
