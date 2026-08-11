import type {
  Agent,
  AgentCreateInput,
  AgentUpdateInput,
  Attachment,
  Issue,
  IssueCreateInput,
  IssueListPage,
  IssueUpdateInput,
  Label,
  LabelCreateInput,
  LabelUpdateInput,
  Me,
  Member,
  MemberRole,
  Project,
  ProjectCreateInput,
  ProjectUpdateInput,
  Status,
  StatusCreateInput,
  StatusUpdateInput,
  TimelineComment,
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
  login = () => this.request<Me>("POST", "/auth/login");
  logout = () => this.request<void>("POST", "/auth/logout");
  me = () => this.request<Me>("GET", "/me");
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
  createIssue = (slug: string, input: IssueCreateInput) =>
    this.request<Issue>("POST", `/projects/${slug}/issues`, { json: input });
  getIssue = (slug: string, number: number) =>
    this.request<Issue>("GET", `/projects/${slug}/issues/${number}`);
  updateIssue = (slug: string, number: number, input: IssueUpdateInput) =>
    this.request<Issue>("PATCH", `/projects/${slug}/issues/${number}`, {
      json: input,
    });

  // — timeline / comments —
  getTimeline = (
    slug: string,
    number: number,
    query?: { before?: string; after?: string; last?: boolean; limit?: number },
  ) =>
    this.request<TimelinePage>(
      "GET",
      `/projects/${slug}/issues/${number}/timeline`,
      { query: query ? { ...query, last: query.last ? 1 : undefined } : {} },
    );
  createComment = (slug: string, number: number, body: string) =>
    this.request<TimelineComment>(
      "POST",
      `/projects/${slug}/issues/${number}/comments`,
      { json: { body } },
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

  // — attachments —
  uploadAttachment = (slug: string, issueNumber: number, file: File) => {
    const form = new FormData();
    form.set("file", file);
    form.set("issue_number", String(issueNumber));
    return this.request<Attachment>("POST", `/projects/${slug}/attachments`, {
      form,
    });
  };

  /** EventSource URL for the project change feed. */
  eventsUrl = (slug: string) => `${this.#baseUrl}/api/projects/${slug}/events`;
}
