# CLI profiles + agent context — 系统设计

> 设计稿见 [brainstorm.md](./brainstorm.md)；本文件落到模块与代码层面。
> 契约细节见 [api.md](./api.md)。

## 1. 总览

```
CLI（Claude Code 会话内）
 ├─ config.ts        servers.X.tokens 命名 profile 表（新）
 ├─ context.ts       token 选择：--profile > TODOU_TOKEN > TODOU_PROFILE
 │                     > CLAUDECODE 自动规则 > 默认 token
 ├─ agent-context.ts detectAgentContext()：CLAUDECODE / SESSION_ID /
 │                     transcript 尾部 → model（新模块）
 └─ api-command.ts   构造 client 时注入 X-Todou-Agent-Context header
        │
        ▼  X-Todou-Agent-Context: {"agent":"claude-code","session_id":…,"model":…}
shared
 ├─ schemas/agent-context.ts  AgentContext zod schema（新）
 ├─ client.ts                 TodouClientOptions.headers（新选项）
 └─ schemas/timeline.ts       TimelineComment/TimelineEvent + agent_context
        │
        ▼
server
 ├─ agent-context 中间件      解析/校验 header → c.set("agentContext")
 ├─ services/{comments,issues,attachments,references}.ts
 │                            写 comments/issue_events 时落 agent_context 列
 ├─ db/project-schema.ts      两表各加 agent_context jsonb（迁移 0001）
 └─ services/timeline.ts      响应带出 agent_context
        │
        ▼
web
 └─ components/timeline/…     徽章：<agent> · <model>，tooltip 显 session
```

无新第三方依赖。

## 2. shared

### 2.1 `AgentContext` schema（`src/schemas/agent-context.ts`，新）

```ts
export const AgentContext = z.object({
  agent: z.string().min(1).max(100),
  session_id: z.string().max(200).optional(),
  model: z.string().max(200).optional(),
});
```

`"."` 导出（浏览器安全，纯 zod）。header 名常量
`AGENT_CONTEXT_HEADER = "x-todou-agent-context"` 一并导出，CLI 与 server
共用。

### 2.2 `TodouClientOptions.headers`

构造选项加 `headers?: Record<string, string>`；`request()` 把它合并进每个
请求的 header（authorization/content-type 优先级更高，不可被覆盖）。

### 2.3 timeline schema

`TimelineComment`、`TimelineEvent` 各加
`agent_context: AgentContext.nullable()`。web/CLI 的 `--json` 输出随之
自动携带。

## 3. CLI

### 3.1 config（`src/config.ts`）

```ts
servers: z.record(z.string(), z.object({
  token: z.string().optional(),          // 由必填改为可选：允许只有命名 profile
  tokens: z.record(z.string(), z.string()).default({}),
})).default({})
```

注意 `token` 转为 optional：`login --profile x` 后该 server 可能没有默认
token。现有配置文件向后兼容（多出的 `tokens` 空表不写盘即不出现）。

### 3.2 token 选择（`src/context.ts`）

`resolveContext` 增加输入 `flags.profile`；token 解析改为（见
brainstorm §1 顺序）：

```
lookup(name) = name === "default"
  ? servers[server].token（缺 → 报错）
  : servers[server].tokens[name]（缺 → 报错并列出可用 profile 名）

if flags.profile        → lookup(flags.profile)
else if env.TODOU_TOKEN → env.TODOU_TOKEN
else if env.TODOU_PROFILE → lookup(env.TODOU_PROFILE)
else if env.CLAUDECODE === "1" && tokens["claude-code"] 存在
                        → tokens["claude-code"]
else                    → servers[server].token
```

返回值增加 `tokenSource: "flag-profile" | "env-token" | "env-profile" |
"auto-claude-code" | "default" | null`，whoami 用它注明非默认来源，测试
断言用。「profile 不存在」的报错由 `ApiCommand` 在缺 token 报错之前区分
（resolveContext 保持纯函数，返回 `profileError` 字段或直接 throw
CliError——选 throw，调用方在 execute 的 try 里）。

### 3.3 agent 上下文（`src/agent-context.ts`，新）

```ts
detectAgentContext(env, homedir?): AgentContext | null
```

- `env.CLAUDECODE !== "1"` → null。
- `session_id = env.CLAUDE_CODE_SESSION_ID`（可缺省）。
- `model = detectModel(env, sessionId, homedir)`：
  1. transcript：`<homedir>/.claude/projects/*/<sessionId>.jsonl`（glob，
     取第一个命中），`readLastChunk(file, 256 KiB)` 按行倒序找
     `"type":"assistant"` 且 `message.model` 为 string 的条目；任何 IO/
     JSON 失败 → 下一步。逐行 `JSON.parse` 只在包含 `"model"` 子串的行
     上尝试（廉价预过滤）。
  2. `env.CLAUDE_MODEL`（用户经 SessionStart hook + CLAUDE_ENV_FILE 注入
     时存在）。
  3. 缺省。
- `homedir` 参数可注入（测试指向临时目录）。

### 3.4 header 注入（`src/api-command.ts`）

`execute()` 构造 `TodouClient` 时：

```ts
const agentCtx = detectAgentContext(this.context.env);
new TodouClient({ …, headers: agentCtx
  ? { [AGENT_CONTEXT_HEADER]: JSON.stringify(agentCtx) } : undefined })
```

`todou api` 逃生舱同样经基类，自动获益。login 命令不发（无认证请求仅
GET /me 验证——也带上，无妨，统一走基类以外的构造点需单独加；login 的
client 构造处照抄一行）。

### 3.5 login `--profile`

`LoginCommand` 加 `profile = Option.String("--profile")`：

- `"default"` → 报错（保留名）。
- 有值 → 写 `servers[origin].tokens[profile]`；否则写 `servers[origin].token`。
- 浏览器流 token 命名：`cli @ <hostname>` / 带 profile 时
  `cli @ <hostname> (<profile>)`。

## 4. server

### 4.1 中间件（`src/middleware/agent-context.ts`，新）

挂在 API 路由链 authMiddleware 之后：

- 无 header → `c.set("agentContext", null)`。
- 有 header：长度 > 2048 或 JSON/schema 校验失败 → 422 风格错误
  `{ code: "invalid_agent_context" }`（走现有错误约定，400 系）；合法 →
  set 解析结果。
- `AppEnv.Variables` 增加 `agentContext: AgentContext | null`。

### 4.2 schema 与迁移

`db/project-schema.ts`：`comments`、`issueEvents` 各加

```ts
agentContext: jsonb("agent_context").$type<AgentContext | null>(),
```

迁移：`drizzle-kit generate --config drizzle.project.config.ts` 生成
`drizzle/project/0001_*.sql`（两条 `ADD COLUMN`）。测试与 auto_migrate
环境自动应用。

### 4.3 写路径

`agentContext` 作为可选尾参穿过 service 层（保持 service 不读 hono）：

- `createComment(ctx, actor, slug, n, input, agentContext?)`
- `createIssue(…, agentContext?)`（`opened` 事件）
- `updateIssue(…, agentContext?)`（`addEvent` 闭包捕获）
- `attachments` 上传（`attachment_added` 事件）
- `references.recordReferences`（`referenced` 事件）——从调用方
  （comment/issue 写路径）透传。

各 `insert(comments|issueEvents).values({ …, agentContext })`。路由层从
`c.get("agentContext")` 取值传入。comment 的 update/delete 不动（编辑不
改变来源归属）。

### 4.4 timeline 读路径

`services/timeline.ts` 用 `$inferSelect` 整行，新增列自动可用；行→
`TimelineItem` 的映射函数补 `agent_context: row.agentContext ?? null`。

## 5. web 徽章

`components/timeline/timeline.tsx`：评论头部与事件行内，若
`item.agent_context` 存在渲染：

```tsx
<Badge variant="secondary" title={agent_context.session_id
    ? `session ${agent_context.session_id}` : undefined}>
  {agent_context.agent}{agent_context.model ? ` · ${agent_context.model}` : ""}
</Badge>
```

（沿用现有 `ui/badge.tsx`；原生 `title` 即可，不引 Tooltip 组件，保持
轻量。）

## 6. 测试设计

| 层 | 覆盖 |
| --- | --- |
| cli config/context | token 选择矩阵（§3.2 六种来源 + 未知 profile 报错文案）；login --profile 写入位置与 default 保留名；round-trip |
| cli agent-context | 伪 HOME + 伪 transcript（多行、尾部 assistant、坏 JSON、大文件截尾）；CLAUDE_MODEL 兜底；非 Claude 环境 → null |
| cli 命令 | fetch stub 断言写命令请求带 X-Todou-Agent-Context 且内容正确；未设 CLAUDECODE 时不带 |
| shared | headers 选项随请求发送、不覆盖 authorization |
| server | header 非法 → 4xx；comment/issue create/close、attach 落库并在 timeline 响应回读；无 header → null |
| web | 徽章渲染三态（agent+model / 仅 agent / 无上下文） |
| 真机 | Claude Code 会话内对 dogfood 写 comment + close，网页确认徽章 |

## 7. 兼容性

- 旧 CLI/其它客户端不发 header → 一切照旧（列为 null）。
- 配置文件：旧文件无 `tokens` 表 → default 生效；新文件被旧 CLI 读 →
  zod 未知键（`tokens`）……旧 schema 用 `z.object` 默认 strip，未知键被
  忽略，不会报错。可接受。
- API 响应新增字段对旧 web/CLI 是加法，无破坏。
