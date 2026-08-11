# CLI profiles + agent context — 契约参考

## 1. CLI 面变更

### 新/变更 flags 与环境变量

| 项 | 说明 |
| --- | --- |
| `--profile <name>`（所有 ApiCommand + login） | 选用命名 token；`default` 为保留名 = 默认 token |
| `TODOU_PROFILE` | 环境变量版 `--profile`，优先级低于 `TODOU_TOKEN` |
| `todou login <server> --profile <name>` | token 写入 `servers.<origin>.tokens.<name>`；浏览器流 token 命名 `cli @ <host> (<name>)` |
| 自动规则 | `CLAUDECODE=1` 且存在 `tokens."claude-code"` → 自动选用（无需任何 flag/env） |

token 选择顺序：`--profile` > `TODOU_TOKEN` > `TODOU_PROFILE` >
CLAUDECODE 自动规则 > 默认 `token`。

### 配置文件

```toml
[servers."https://todou.example"]
token = "todou_pat_user"                # 可缺省（只用命名 profile 时）

[servers."https://todou.example".tokens]
claude-code = "todou_pat_claude"
```

### agent 上下文自动附带

`CLAUDECODE=1` 时，CLI 所有请求附 header（与 token 选择无关）：

```
X-Todou-Agent-Context: {"agent":"claude-code","session_id":"<uuid>","model":"claude-fable-5"}
```

- `session_id` ← `CLAUDE_CODE_SESSION_ID`（缺则省略字段）
- `model` ← transcript 尾部 `message.model`；失败退 `CLAUDE_MODEL` env；
  再失败省略字段

## 2. HTTP 契约

### 请求 header

```
X-Todou-Agent-Context: <JSON>        # 可选；≤ 2048 字节
```

```ts
AgentContext = {
  agent: string (1–100),
  session_id?: string (≤200),
  model?: string (≤200),
}
```

- 缺失 → 无上下文（存量客户端不受影响）。
- 存在但超长/非 JSON/不合 schema → 4xx `{ error: { code:
  "invalid_agent_context" } }`。
- server 不验证内容真实性；作者身份仍由认证（cookie/PAT）决定。

### 响应（timeline）

`TimelineComment` 与 `TimelineEvent` 均新增：

```ts
agent_context: AgentContext | null
```

出现在 `GET /projects/{slug}/issues/{n}/timeline` 及所有内嵌 comment 的
响应（`POST …/comments` 返回体等）。落库范围：`comments` 全部 +
`issue_events` 全部（opened/status_changed/label_*/assigned/…/
attachment_added/referenced）。

## 3. shared 新增 API

```ts
// "." 导出
export const AgentContext: z.ZodType;      // schemas/agent-context.ts
export type AgentContext;
export const AGENT_CONTEXT_HEADER = "x-todou-agent-context";

// TodouClientOptions
headers?: Record<string, string>;          // 随每个请求发送；不可覆盖
                                           // authorization / content-type
```

## 4. DB 迁移（project tier 0001）

```sql
ALTER TABLE "comments" ADD COLUMN "agent_context" jsonb;
ALTER TABLE "issue_events" ADD COLUMN "agent_context" jsonb;
```
