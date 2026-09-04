import {
  type CrossChangeEvent,
  CrossChangeEvent as CrossChangeEventSchema,
  SSE_CHANGE_EVENT,
} from "./events.ts";
import type {
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
  BulkReadInput,
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
  CommentLocation,
  CrossActivityPage,
  DirectUploadTicket,
  InboxPage,
  Issue,
  IssueCounts,
  IssueCreateInput,
  IssueListPage,
  IssueQuestions,
  IssueReadInput,
  IssueUpdateInput,
  Label,
  LabelCreateInput,
  LabelUpdateInput,
  Me,
  Member,
  MemberRole,
  MePrefs,
  MePrefsPatch,
  MeUpdateInput,
  Project,
  ProjectCreateInput,
  ProjectUpdateInput,
  ReferenceConfig,
  ReferenceDirectory,
  RefFormatSetInput,
  RevisionPage,
  SearchPage,
  SpecComments,
  SpecFiles,
  SpecInfo,
  SpecPushInput,
  SpecPushResult,
  SpecReviewResult,
  SpecReviewSubmitInput,
  Status,
  StatusCreateInput,
  StatusUpdateInput,
  TimelineComment,
  TimelineEvent,
  TimelinePage,
  TokenCreated,
  TokenCreateInput,
  TokenListItem,
  VersionInfo,
} from "./index.ts";
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
  /** Origin of the server; empty string = same origin (web app). */
  baseUrl?: string;
  /** Bearer PAT for agents/CLI; omitted = cookie session (web). */
  token?: string;
  /**
   * Extra headers on every request (e.g. x-todou-agent-context).
   * authorization and content-type cannot be overridden.
   */
  headers?: Record<string, string>;
  fetch?: typeof fetch;
  /**
   * Coalesce same-tick GETs into one POST /api/batch exchange (T-91).
   * Off by default: only the web app's burst-y query fan-out profits;
   * sequential CLI calls would pay the macrotask delay for nothing.
   */
  batch?: boolean;
  /**
   * Called with the project's current slug whenever a response says the
   * path named a retired one (T-156). Batched sub-requests carry no
   * headers, so this is a hint for the caller to nudge the user, never
   * something to depend on for correctness.
   */
  onCanonicalSlug?: (canonical: string) => void;
};

export class TodouError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(
    status: number,
    code: string,
    message: string,
    details?: unknown,
  ) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
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
function errorFromBody(status: number, parsed: unknown): TodouError {
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
 */
function movedToFromUrl(url: string): MovedTo | null {
  let path: string;
  try {
    path = new URL(url).pathname;
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
  #onCanonicalSlug?: (canonical: string) => void;
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
   */
  async requestRaw(
    method: string,
    path: string,
    init?: { json?: unknown; form?: FormData; query?: Query },
  ): Promise<Response> {
    const headers: Record<string, string> = { ...this.#headers };
    if (this.#token) headers.authorization = `Bearer ${this.#token}`;
    let body: string | FormData | undefined;
    if (init?.json !== undefined) {
      headers["content-type"] = "application/json";
      body = JSON.stringify(init.json);
    } else if (init?.form) {
      body = init.form;
    }

    const res = await this.#fetch(
      `${this.#baseUrl}/api${path}${queryString(init?.query)}`,
      { method, headers, body, credentials: "same-origin" },
    );
    if (!res.ok) {
      let parsed: unknown = null;
      try {
        parsed = await res.json();
      } catch {
        // Non-JSON error body; errorFromBody keeps status as message.
      }
      throw errorFromBody(res.status, parsed);
    }
    if (this.#onCanonicalSlug !== undefined) {
      const canonical = res.headers.get(CANONICAL_SLUG_HEADER);
      if (canonical !== null) this.#onCanonicalSlug(canonical);
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
      const movedTo = movedToFromUrl(res.url);
      if (movedTo !== null) throw new MovedError(movedTo);
    }
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
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
    let envelope: { responses: Array<{ status: number; body: unknown }> };
    try {
      envelope = await this.#send("POST", "/batch", {
        json: { requests: chunk.map(({ url }) => ({ url })) },
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
    chunk.forEach((item, i) => {
      const result = envelope.responses[i];
      if (result === undefined) {
        item.reject(
          new TodouError(502, "batch_mismatch", "missing batch response"),
        );
      } else if (result.status >= 200 && result.status < 300) {
        item.resolve(result.status === 204 ? undefined : result.body);
      } else {
        item.reject(errorFromBody(result.status, result.body));
      }
    });
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
  deleteProject = (slug: string) =>
    this.request<void>("DELETE", `/projects/${slug}`);

  listMembers = (slug: string) =>
    this.request<Member[]>("GET", `/projects/${slug}/members`);
  setMember = (slug: string, userId: number, role: MemberRole) =>
    this.request<void>("PUT", `/projects/${slug}/members/${userId}`, {
      json: { role },
    });
  removeMember = (slug: string, userId: number) =>
    this.request<void>("DELETE", `/projects/${slug}/members/${userId}`);

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
  getIssue = (slug: string, number: number) =>
    this.request<Issue>("GET", `/projects/${slug}/issues/${number}`);
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
  markIssueRead = (slug: string, number: number, input: IssueReadInput = {}) =>
    this.request<void>("PUT", `/projects/${slug}/issues/${number}/read`, {
      json: input,
    });

  // — search —
  search = (slug: string, query: Query) =>
    this.request<SearchPage>("GET", `/projects/${slug}/search`, { query });

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

  /** EventSource URL for the user-level cross-project feed (T-122). */
  userEventsUrl = () => `${this.#baseUrl}/api/events`;

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
      throw errorFromBody(res.status, parsed);
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
