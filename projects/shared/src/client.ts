import type {
  ActivityPage,
  Agent,
  AgentCreateInput,
  AgentUpdateInput,
  AnswersSubmitInput,
  Attachment,
  AuthMode,
  Autolink,
  AutolinkCreateInput,
  CommentComponentInput,
  DirectUploadTicket,
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
  MeUpdateInput,
  Project,
  ProjectCreateInput,
  ProjectUpdateInput,
  ReferenceConfig,
  RefFormatSetInput,
  RevisionPage,
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
} from "./index.ts";

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

export class TodouClient {
  #baseUrl: string;
  #token?: string;
  #headers?: Record<string, string>;
  #fetch: typeof fetch;

  constructor(options?: TodouClientOptions) {
    this.#baseUrl = options?.baseUrl ?? "";
    this.#token = options?.token;
    this.#headers = options?.headers;
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
      let code = "unknown";
      let message = `${res.status}`;
      let details: unknown;
      try {
        const parsed = (await res.json()) as {
          error?: { code?: string; message?: string; details?: unknown };
        };
        code = parsed.error?.code ?? code;
        message = parsed.error?.message ?? message;
        details = parsed.error?.details;
      } catch {
        // Non-JSON error body; keep status as message.
      }
      throw new TodouError(res.status, code, message, details);
    }
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

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
  createMyToken = (input: TokenCreateInput) =>
    this.request<TokenCreated>("POST", "/me/tokens", { json: input });
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
  markIssueRead = (slug: string, number: number, input: IssueReadInput = {}) =>
    this.request<void>("PUT", `/projects/${slug}/issues/${number}/read`, {
      json: input,
    });

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
    },
  ) =>
    this.request<ActivityPage>("GET", `/projects/${slug}/activity`, {
      query: query ? { ...query, last: query.last ? 1 : undefined } : {},
    });
  createComment = (
    slug: string,
    number: number,
    body: string,
    component?: CommentComponentInput,
  ) =>
    this.request<TimelineComment>(
      "POST",
      `/projects/${slug}/issues/${number}/comments`,
      { json: component === undefined ? { body } : { body, component } },
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

  // — questions (#19) —
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

  // — spec (#23) —
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

  /** base64 SHA-256 when the runtime offers WebCrypto; else omitted. */
  #sha256 = async (file: File): Promise<string | undefined> => {
    const subtle = globalThis.crypto?.subtle;
    if (!subtle) return undefined;
    try {
      const digest = await subtle.digest("SHA-256", await file.arrayBuffer());
      return btoa(String.fromCharCode(...new Uint8Array(digest)));
    } catch {
      return undefined;
    }
  };

  /** EventSource URL for the project change feed. */
  eventsUrl = (slug: string) => `${this.#baseUrl}/api/projects/${slug}/events`;
}
