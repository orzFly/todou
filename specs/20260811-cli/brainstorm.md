# todou — CLI（切片 2 设计稿）

> 状态：设计已与用户逐段确认（2026-08-11）。
> 来源：https://todou.example/projects/todou/issues/1 ·
> 路线图见 specs/20260811-server-web-core/brainstorm.md §9。

`todou` 命令行客户端，服务人和 agent 两类用户：人要顺手的日常 issue 工作
流，agent 要稳定的 `--json` 输出和纯环境变量配置（CI 友好）。基于
`@todou/shared` 的 TodouClient，不引入新的 HTTP 层。

## 1. 包结构与依赖

```
projects/cli/src/
  index.ts          # Cli 装配，注册全部命令
  api-command.ts    # ApiCommand 基类：server/token/project 解析、client 构造、
                    #   --json、TodouError → 退出码
  config.ts         # CLI 配置 schema + 读写（基于 shared 抽出的 loader）
  context.ts        # cwd → git remote → 绑定解析
  format.ts         # 人类可读输出：对齐列 + util.styleText（尊重 NO_COLOR）
  commands/
    login.ts whoami.ts api.ts
    project.ts      # list / link / unlink
    issue.ts        # list / create / view / edit / close
    comment.ts label.ts status.ts attach.ts
```

依赖：`@todou/shared`（TodouClient + zod schemas + config loader）、
`clipanion`、`smol-toml`（配置写回）。颜色用 Node 内建 `util.styleText`，
不加第三方库。沿用工作区惯例：无构建步骤，`bin` 直指 `src/index.ts`。

## 2. 配置文件与上下文解析

`~/.config/todou/config.toml`（尊重 `XDG_CONFIG_HOME`；写入时确保目录存在、
文件 chmod 0600）：

```toml
default_server = "https://todou.example"   # 最近一次 login 的 server

[servers."https://todou.example"]
token = "todou_pat_…"

[servers."http://localhost:8637"]
token = "todou_pat_…"

# git remote → server/project 绑定，由 `todou project link` 写入。
# 绑定放在用户配置里而非仓库内文件，避免污染仓库。
[[bindings]]
remote = "git@github.com:you/todou.git"
server = "https://todou.example"
project = "todou"
```

`ApiCommand` 基类统一解析（每层从左到右取第一个命中）：

| 目标 | 解析顺序 |
| --- | --- |
| server | `--server` > `TODOU_SERVER` > cwd 绑定的 server > `default_server` |
| token | `TODOU_TOKEN` > 配置中该 server 的 token；缺失 → 报错提示 `todou login` |
| project | `-p/--project` > `TODOU_PROJECT` > cwd 绑定；缺失 → 报错列出三种给法 |

配置里**没有**「默认 project」概念——project 只来自显式 flag、环境变量或
cwd 绑定。

**cwd 绑定**：`spawnSync("git", ["-C", cwd, "remote", "get-url", "origin"])`
取 remote URL 作绑定键（无 origin 且恰有一个 remote 时用它；无 origin 且
有多个 remote、不在 git 仓库、无 remote、git 不存在，均视为无绑定，静默
跳过）。`todou project link <slug>
[--server <origin>]` 在仓库内执行时写入/更新绑定；`todou project unlink`
移除当前仓库的绑定。

## 3. 命令面

所有与 API 对话的读写命令支持 `--json`（见 §4；login/link/unlink 等本地
配置命令除外）；`[-p]` 表示可用 `-p/--project` 覆盖上下文；`--server`
全局可用。

```
todou login [server] [--manual]        # §5
todou whoami                           # GET /me + 当前 server origin

todou project list
todou project link <slug> [--server <origin>]
todou project unlink

todou issue list   [-p] [--status <name> | --open | --closed]
                   [--label <name>]… [--assignee <login|me>] [-q <text>]
                   [--limit <n>] [--sort created|updated|number] [--order asc|desc]
todou issue create [-p] --title <t> [--body <b> | --body-file <f|->]
                   [--label <name>]… [--assignee <login|me>]… [--status <name>]
todou issue view <number> [-p]         # issue + 全量 timeline
todou issue edit <number> [-p] [--title <t>] [--body <b> | --body-file <f|->]
                   [--status <name>] [--add-label|--remove-label <name>]…
                   [--add-assignee|--remove-assignee <login|me>]…
todou issue close <number> [-p] [--status <name>] [--comment <text>]

todou comment add <issue-number> [-p] [--body <b> | --body-file <f|->]

todou label list [-p]
todou label create [-p] --name <n> [--color <#hex>] [--description <d>]
todou label edit <name> [-p] [--name] [--color] [--description]
todou label delete <name> [-p]

todou status list [-p]

todou attach <issue-number> <file>... [-p]

todou api <method> <path> [--body <json|@file>] [-f k=v]...
```

语义决策：

- **name → id 解析**：REST 过滤/写入参数用 id（`IssueListQuery.status/label`
  是 csv id，`assignee` 是 user id）。CLI 面向人用名字：命令内先经
  `listStatuses` / `listLabels` / `listMembers` 把名字解析成 id（大小写不
  敏感精确匹配；找不到 → 报错并列出可选值）；`--assignee me` 经 `GET /me`；
  `--open` / `--closed` 映射为 `category` 过滤参数。
- **`issue close`**：取项目状态里 `category == "closed"`、position 最靠前
  的状态；`--status` 指定其他关闭态；`--comment` 先加评论再改状态（agent
  留关闭原因）。
- **`issue view`**：拉 issue + timeline 全量页（沿 `next_cursor` 拼接
  items）。人类视图按时间线渲染评论与事件。
- **`issue list`**：人类视图列 `number / title / status / labels /
  assignees / updated`；`--limit` 直接映射 API 参数（1–100，默认 30）。
  不做 `--all` 自动翻页（本切片）。
- **正文输入**：`--body` 内联；`--body-file <f>` 读文件、`--body-file -`
  读 stdin；`issue create` / `comment add` 在 TTY 且未给 body 时打开
  `$EDITOR`（临时文件）。agent 永远走 flag/stdin，不会触发编辑器。
- **`todou attach`**：逐个文件调 `uploadAttachment`（Node 24 有 `File`
  global），输出每个附件的 URL。
- **`todou api`**：透传逃生舱，覆盖本切片未包装的端点（member/agent/token
  管理等）。方法 + 路径 + 可选 body/query 直接发出，带认证和 `/api` 前缀，
  恒输出 JSON。需要把 `TodouClient` 的私有 `#request` 以公开 `request()`
  方法暴露（shared 的一个小改动）。

## 4. 输出契约

- **`--json`**：原样输出 REST 响应（即 shared 里的 zod schema），契约与
  API 同一份。写命令输出受影响的实体（如 `issue create --json` 输出新
  Issue，agent 由此拿到 number）。两个组合特例：
  - `issue view --json` → `{ "issue": Issue, "timeline": TimelineItem[] }`
    （timeline 为全量拼接的 items）；
  - `issue list --json` → `IssueListPage` 原样（`items` + `next_cursor`）。
- **人类视图**：对齐列 / 简单键值排版，`util.styleText` 着色（自动尊重
  NO_COLOR 与非 TTY）。不引入表格库。
- stdout 只放数据；提示、进度、错误一律 stderr。

## 5. `todou login`（localhost 回调换 PAT）

0. `todou login` 省略 server 参数时用 `default_server`；两者皆无 → 报错
   要求显式给 origin。
1. CLI 生成随机 `state`，在 `127.0.0.1` 随机端口起一次性 `node:http`
   监听。
2. 打开浏览器到
   `<server>/cli-auth?port=<p>&state=<s>&name=cli @ <hostname>`；打开失败
   则打印该 URL 让用户手动访问。
3. **web 新增 `/cli-auth` 页面**（纯前端路由）：已登录会话下显示
   「授权 todou CLI（<name>）？」确认按钮 → 现有 `createMyToken` 签 PAT →
   浏览器重定向到 `http://127.0.0.1:<p>/callback?token=…&state=…`。未登录
   先走既有登录页再回来；若现有登录页缺 returnTo 支持，本切片补上。
4. CLI 校验 `state` 一致后把 token 写入配置（该 server 条目 + 更新
   `default_server`），回一页「已完成，可关闭此页」，退出监听。
5. **server 零改动**（复用 `POST /me/tokens`）。
6. `--manual` / headless：打印 Settings → Tokens 指引，stdin 隐藏输入粘贴
   token，其余相同。

安全性：回调只绑 127.0.0.1；`state` 不匹配即拒绝；token 落盘 0600、永不回
显到终端；token 名带主机名（`cli @ <hostname>`），便于在 Settings 里识别
与吊销。

## 6. 配置 schema 抽到 shared

- shared 新增**子路径导出** `@todou/shared/config`（Node-only，含
  `node:fs`，不进 `"."` 浏览器面）：通用
  `loadTomlConfig(schema, { path, envMap, env, tomlSource })` +
  `ConfigError` + `flexibleBool` + `setPath` 等；`smol-toml` 依赖随之移到
  shared。
- server `config.ts` 改用它：只保留自己的 `ConfigSchema`、`ENV_MAP` 与后
  处理（static_dir 绝对化、url_template 编译、模式校验），行为不变。
- CLI 用同一 loader 定义自己的 schema（`default_server` / `servers` /
  `bindings`）。`TODOU_SERVER` / `TODOU_TOKEN` / `TODOU_PROJECT` 是运行时
  选择逻辑（§2 的解析顺序），不进 envMap。CLI 侧的写回（login / link /
  unlink）用 `smol-toml` 的 `stringify`。

## 7. 错误处理

- `TodouError` → stderr 一行 `error: <code> — <message>`，退出码 1；
  网络层错误同样退出 1 并提示检查 server/网络。
- 缺 token → 提示 `todou login <server>`；缺 project → 列出 `-p` /
  `TODOU_PROJECT` / `todou project link` 三种给法。
- usage 错误交给 clipanion 内建（用法打印 + 非零退出）。
- `--json` 模式下错误照旧走 stderr 文本；agent 以退出码判断成败。

## 8. 测试

- **命令单测**（vitest）：clipanion `Cli` + 注入 fetch stub，断言请求
  （方法/路径/query/body）与输出（人类视图关键字段、`--json` 全量）。
- **config / 绑定**：临时目录 + 真 `git init` 假仓库，覆盖 XDG 路径、
  0600、解析顺序、link/unlink 往返。
- **login**：起真回调 server，用 fetch 模拟浏览器 redirect，覆盖 state
  不匹配拒绝。
- **web `/cli-auth`**：Testing Library（mint + redirect 调用）。
- 收尾对 dogfood 实例（https://todou.example）真机跑通主要命令。

## 9. 明确不做（本切片）

npm 发布 / 单文件二进制打包（工作区内 bin link 使用）· MCP server（切片
5）· SSE 订阅命令（`todou watch`）· 附件下载命令 · `issue list --all` 自动
翻页 · 交互式 TUI · member/agent/token 管理命令（`todou api` 兜底）·
device-code 登录流程。
