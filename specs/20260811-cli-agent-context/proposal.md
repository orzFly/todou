# CLI profiles + agent context metadata — 原始需求与澄清记录

## 来源

Issue：https://todou.example/projects/todou/issues/11
对话背景：用户先问「do we have special envvar in Claude Code? so we can
identify the call is made by Claude」，确认存在 `CLAUDECODE=1` 等环境变量
后提出本需求。

用户原话（原样）：

> oh, this is so nice. Let's add multiple token storage to todou CLI. A key
> can be stored for claude code, which got automatically picked up by
> CLAUDECODE=1. also, is it possible to obtain current model? I would it to
> have claude code sessionId & modelName/slug as metadata for every
> comments/events made by claude code

即三点：

1. CLI 支持多 token 存储；可以为 Claude Code 存一把 key，`CLAUDECODE=1`
   时自动选用。
2. 询问能否获取当前模型。
3. 希望 Claude Code 发出的每条 comment/event 都带上 claude code sessionId
   与 modelName/slug 作为 metadata。

## 澄清问答

### Q1 token 形态

**问**：多 token 存储做成通用 profile 机制，还是只给 claude-code 开个
专用键？

- **通用 profiles（推荐）**：每个 server 下除默认 token 外可存任意命名
  token：[servers.X.tokens] 表。`todou login <server> --profile <name>`
  写入；选择顺序 TODOU_TOKEN > --profile > 自动规则（CLAUDECODE=1 →
  取 "claude-code"）> 默认 token。以后其它 agent（cursor 等）可照样加。
- **只做 claude-code 键**：配置里固定一个 claude_token 字段，CLAUDECODE=1
  时用它。实现最小，但下一个 agent 出现时又要改配置 schema。

**答**：通用 profiles（推荐）。

### Q2 web 展示

**问**：agent metadata（sessionId + model）除了存进 API/数据库，这一期
要不要在 web 时间线上显示？

- **小徽章（推荐）**：时间线里的评论/事件若带 agent 上下文，在作者旁边
  显示一个小徽章（如 “claude-code · claude-fable-5”，hover 看
  sessionId）。一步到位，多一小块 web 工作量。
- **API-only，web 后续**：本期只存储 + 在 REST/timeline 响应里暴露字段，
  web 展示开 issue 留到以后。切片更小。

**答**：小徽章（推荐）。

## 调研结论（Claude Code v2.1.x，影响设计的事实）

- `CLAUDECODE=1`、`CLAUDE_CODE_SESSION_ID` 是官方文档记载的稳定环境变量
  （后者 v2.1.132 起）。
- 没有携带当前模型的环境变量；`ANTHROPIC_MODEL` 只是用户设置的覆盖输入，
  `/model` 切换不反映。
- SessionStart hook 输入含 `model` 字段（可能缺省），可经官方
  `CLAUDE_ENV_FILE` 机制注入 env；但只在会话开始触发，`/model` 中途切换
  后过期。
- transcript JSONL（`~/.claude/projects/<目录改写>/<sessionId>.jsonl`）的
  assistant 条目含 `message.model`（如 "claude-fable-5"）。schema 官方
  声明不稳定，但反映当前模型，实测可用。
