# CLI profiles + agent context — 实施计划

> 依据 [brainstorm.md](./brainstorm.md) 与 [design.md](./design.md)。
> 每步 `pnpm fmt && pnpm lint && pnpm typecheck && pnpm test` 全绿后按
> AGENTS.md 惯例提交（conventional prefix + Spec: 行 + Co-Authored-By）。

## 步骤 1 — shared：AgentContext schema + client headers

1. 新建 `projects/shared/src/schemas/agent-context.ts`：`AgentContext`
   zod schema + `AGENT_CONTEXT_HEADER` 常量；`index.ts` re-export。
2. `client.ts`：`TodouClientOptions.headers`，`request()` 合并（先铺
   headers，再覆盖 authorization/content-type，保证不可覆盖）。
3. `schemas/timeline.ts`：`TimelineComment`、`TimelineEvent` 加
   `agent_context: AgentContext.nullish()`（过渡态：server 路由的响应
   schema 直接引用 shared schema，本步 server 尚未带出该字段，`nullish`
   让缺字段合法、server 测试保持绿）。步骤 4 server 全面带出后收紧为
   `.nullable()`。
4. shared 测试：headers 发送 + authorization 不被覆盖；timeline schema
   解析带/不带 agent_context 均通过。

提交：`feat(shared): AgentContext schema and TodouClient custom headers`

## 步骤 2 — cli：profiles（config + context + login + whoami）

1. `config.ts`：server 条目改为 `{ token?: string; tokens: record }`
   （见 design §3.1）。
2. `context.ts`：`flags.profile` 输入；token 选择按 design §3.2 分支；
   返回 `tokenSource`；未知 profile → `CliError`（列出可用名）。
3. `api-command.ts`：`ApiCommand` 加 `--profile` flag 并传入
   resolveContext。
4. `commands/login.ts`：`--profile`（禁 `default`），写入位置分流，
   浏览器流 token 名带 profile。
5. `commands/whoami.ts`：stderr 注明非默认 tokenSource（如
   `token: profile "claude-code" (auto)`）。
6. 测试：选择矩阵（flag/TODOU_TOKEN/TODOU_PROFILE/自动/默认/未知
   profile/保留名 default）；login --profile 写入与命名；旧配置文件兼容
   （无 tokens 表）。

提交：`feat(cli): named token profiles with CLAUDECODE auto-selection`

## 步骤 3 — cli：agent 上下文检测 + header 注入

1. `src/agent-context.ts`：`detectAgentContext(env, homedir?)` 与
   `detectModel`（transcript glob + 末尾 256 KiB 倒序扫 + CLAUDE_MODEL
   兜底），全程静默失败。
2. `api-command.ts` 与 `commands/login.ts` 的 client 构造处注入
   `AGENT_CONTEXT_HEADER`。
3. 测试：伪 HOME 下伪 transcript（尾部 assistant 行、坏 JSON 行、
   >256 KiB 截尾、无命中）；CLAUDE_MODEL 兜底；CLAUDECODE 未设 → 无
   header；写命令请求头断言（fetch stub）。

提交：`feat(cli): attach Claude Code agent context to every request`

## 步骤 4 — server：列 + 中间件 + 写路径 + timeline 暴露

1. `db/project-schema.ts`：两表加
   `agentContext: jsonb("agent_context").$type<AgentContext | null>()`；
   `pnpm --filter @todou/server exec drizzle-kit generate --config
   drizzle.project.config.ts` 生成 0001 迁移，核对 SQL 只有两条
   ADD COLUMN。
2. `src/middleware/agent-context.ts`（新）+ 挂载（authMiddleware 之后）；
   `AppEnv.Variables.agentContext`；非法 → `invalid_agent_context`
   （沿用现有错误工厂，4xx）。
3. service 尾参穿透：`createComment` / `createIssue` / `updateIssue`
   （含 `addEvent`）/ attachments 上传 / `recordReferences`；各 insert
   带 `agentContext`。路由层 `c.get("agentContext")` 传入。
4. `services/timeline.ts` 行→item 映射补 `agent_context`；shared
   timeline schema 从 `.nullish()` 收紧为 `.nullable()`（见步骤 1 注）。
5. 测试（server round-trip）：带 header 的 comment 创建 + issue close +
   attach → timeline 回读 agent_context 正确；无 header → null；非法
   header → 4xx `invalid_agent_context`；超长 header → 4xx。

提交：`feat(server): persist and expose agent context on comments and events`

## 步骤 5 — web：时间线徽章

1. `components/timeline/timeline.tsx`：评论头与事件行渲染
   `agent_context` 徽章（design §5，原生 title 提示 session）。
2. 测试（Testing Library）：三态（agent+model / 仅 agent / 无）。

提交：`feat(web): agent context badge in the timeline`

## 步骤 6 — 文档 + 收尾

1. README：CLI 段补 profiles 与 CLAUDECODE 自动选择一句。
2. `docs/claude-code.md`（新，或并入现有 docs 合适位置）：SessionStart
   hook + `CLAUDE_ENV_FILE` 注入 `CLAUDE_MODEL` 的可选配置片段与说明
   （官方机制、/model 切换过期、CLI 以 transcript 为先）。
3. 全套检查 + 全部测试。
4. **真机验证**（需先部署：push + `ssh user@todou ./deploy.sh`，迁移由
   auto_migrate 自动跑）：
   - `todou login https://todou.example --profile claude-code --manual`
     （贴现有 PAT，隔离 XDG 验证写入位置后，再写入真实配置——真实配置
     属用户环境，先征询用户或仅用隔离配置验证）；
   - Claude Code 会话内（CLAUDECODE=1 天然成立）对 `dogfood` 发
     comment / close → timeline JSON 与网页徽章确认 metadata；
   - 未设上下文的写操作确认 agent_context 为 null。
5. 用 CLI 在 `todou` 项目给 issue #11 留言并关闭（带上真实 metadata，
   自证功能）。

提交：`docs: CLI profiles and Claude Code integration notes`（如有）

## 风险与注意

- **shared timeline schema 时序**：步骤 1 用 `.nullish()` 过渡、步骤 4
  收紧，避免中间状态 server 测试失败（server 路由响应 schema 直接引用
  shared schema）。
- **迁移**：dogfood 是 PGlite 持久库，0001 必须可在存量库上就地执行
  （纯 ADD COLUMN，安全）；部署后首次启动 auto_migrate 生效。
- **transcript 解析**：非官方 schema——实现必须把一切异常吞成
  「无 model」，绝不影响命令本身。
- **隐私**：agent_context 是调用方自述、明文入库；不含 token 或密钥。
