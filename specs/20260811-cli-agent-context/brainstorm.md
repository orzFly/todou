# todou — CLI profiles + agent context metadata（设计稿）

> 状态：设计已定向（proposal.md 两问已确认），待 redline。
> 来源：https://todou.example/projects/todou/issues/11

两件事，一条主线：todou 在 Claude Code 会话里既要**用对身份**（自动选
claude-code 的 token），也要**留下痕迹**（每条 comment/event 附
sessionId + model）。机制做成通用的 agent 上下文，claude-code 是第一个
内置来源。

## 1. CLI：多 token profiles

### 配置

```toml
[servers."https://todou.example"]
token = "todou_pat_user"                # 默认身份（向后兼容，字段不变）

[servers."https://todou.example".tokens]
claude-code = "todou_pat_claude_agent"  # 命名 profile，任意多个
```

### token 选择顺序（替换现有单一规则）

1. `--profile <name>`（flag 胜过一切 env，与其余 flag 的惯例一致）：取
   `tokens.<name>`；不存在 → 报错并列出该 server 的可用 profile
2. `TODOU_TOKEN`（环境变量 token 直连，CI 用）
3. `TODOU_PROFILE`（环境变量选 profile，语义同 --profile）
4. 自动规则：`CLAUDECODE=1` 且存在 `tokens."claude-code"` → 用之
5. 默认 `token`

`default` 是保留 profile 名，含义为「默认 token」（`--profile default`
显式绕过自动规则；login 时禁止把它当命名 profile 用）。`whoami` 在
stderr 注明本次用的 profile（默认身份不注明），便于排查。

### login

`todou login <server> --profile <name>` 把 token 写入 `tokens.<name>`
而非默认位；浏览器流的 token 命名带上 profile（`cli @ <host>
(<name>)`），便于在 Settings → Tokens 识别。`default_server` 更新逻辑
不变。

## 2. CLI：agent 上下文检测

新模块 `agent-context.ts`：

```ts
type AgentContext = { agent: string; session_id?: string; model?: string };
detectAgentContext(env): AgentContext | null
```

- `CLAUDECODE != "1"` → null（本期只内置 claude-code 来源）。
- 否则 `{ agent: "claude-code", session_id: env.CLAUDE_CODE_SESSION_ID,
  model: detectModel() }`。
- `detectModel()` 探测链（任一步失败静默进入下一步，绝不让命令失败）：
  1. **transcript 尾部**（最准，反映 `/model` 中途切换）：glob
     `~/.claude/projects/*/<CLAUDE_CODE_SESSION_ID>.jsonl`（用 glob 避免
     依赖目录名改写规则），读文件末尾 ≤256 KB，从后往前找
     `"type":"assistant"` 行的 `message.model`。schema 非官方，解析失败
     即放弃这一步。
  2. `CLAUDE_MODEL` 环境变量——若用户配置了 SessionStart hook 经官方
     `CLAUDE_ENV_FILE` 注入（docs 附建议片段，见 §7）。
  3. 都不行 → 省略 `model` 字段。
- 检测与 token 选择**正交**：无论最终用哪个 token，`CLAUDECODE=1` 就附
  上下文。

## 3. 传输：`X-Todou-Agent-Context` header

- shared 的 `TodouClientOptions` 增加 `headers?: Record<string, string>`，
  随每个请求发送（读写都带，server 只在写路径落库）。
- CLI 在构造 client 时若 `detectAgentContext()` 非 null，设
  `X-Todou-Agent-Context: <JSON>`。
- **契约**（zod，server 侧校验）：

```ts
AgentContext = z.object({
  agent: z.string().min(1).max(100),
  session_id: z.string().max(200).optional(),
  model: z.string().max(200).optional(),
});
```

- header 值 ≤ 2 KB；缺失 = 无上下文；**存在但非法 → 400**（发了就要发
  对，静默丢弃会把 client bug 藏起来）。
- 任何 bearer/cookie 客户端都可发；server 不验证 session_id/model 的真实
  性（它是调用方自述的溯源信息，作者身份仍由认证决定）。

## 4. server：存储与暴露

- **中间件**：解析 header → `c.set("agentContext", …)`，路由/服务经现有
  的请求上下文取用。
- **表**：`comments`、`issue_events` 各加 `agent_context jsonb`（nullable，
  无默认）。issue 创建有 `opened` 事件、附件有 `attachment_added` 事件，
  因此这两张表已覆盖全时间线，issues/attachments 表不动。
- **写路径**：createComment 与所有产生 issue_events 的 mutation（issue
  create/update、attachment 上传等）把当前请求的 agentContext 落到新列。
- **暴露**：shared 的 `TimelineComment`、`TimelineEvent` schema 增加
  `agent_context: AgentContext | null`；timeline 查询 select 新列。SSE
  是 pointer-only，不受影响。
- **迁移**：project tier 一个 drizzle 迁移（两个 `ADD COLUMN`），
  `auto_migrate` 环境照常自动跑。

## 5. web：时间线小徽章

- timeline 里评论与事件若带 `agent_context`，作者名旁渲染小徽章：
  `<agent> · <model>`（model 缺省则只有 agent 名），`title`/tooltip 显示
  `session <session_id>`。
- 样式沿用现有 Badge/secondary 风格，占位小、不抢焦点。

## 6. 测试

- **cli**：profile 选择矩阵（TODOU_TOKEN / --profile / TODOU_PROFILE /
  CLAUDECODE 自动 / 默认 / 未知 profile 报错）；login --profile 写入位置；
  agent-context 检测（伪 transcript 文件、CLAUDE_MODEL、均缺失）；发出
  请求带 header（fetch stub 断言）。
- **shared**：client headers 选项随请求发送。
- **server**：header 校验（非法 400）；comment 创建与 issue mutation 落
  库 agent_context；timeline 响应含该字段；无 header 时为 null。迁移在
  测试库自动生效。
- **web**：徽章渲染（有/无 model、无上下文不渲染）。
- **真机**：Claude Code 会话内对 dogfood 发 comment/close，验证时间线
  metadata 与徽章。

## 7. 文档

- README CLI 段落补 profiles 一句 + `CLAUDECODE` 自动选择说明。
- `docs/agents.md`（或 README 附近合适位置）：附可选的 SessionStart hook
  片段——把 hook 输入的 `model` 写入 `CLAUDE_ENV_FILE`（`export
  CLAUDE_MODEL=…`），说明这是官方注入机制、以及 `/model` 中途切换会过期、
  CLI 以 transcript 为先。

## 8. 明确不做（本期）

- 其它 agent 的内置自动规则（机制通用，`agent` 字段自由，检测器只实现
  claude-code）
- server 端对 session_id/model 真实性的校验或签名
- 存量数据回填 · issue/attachment 行本身的上下文列（事件已覆盖）
- web 上按 agent/model 过滤或聚合视图
- `todou logout` / profile 删除命令（编辑配置文件即可，逃生舱 `todou api`
  可吊销 token）
