# todou CLI — 命令与契约参考

## 1. 全局约定

- 全局 flags：`--server <origin>`（所有命令）、`--json`（与 API 对话的命
  令）、`-p/--project <slug>`（项目作用域命令）。
- 环境变量：`TODOU_SERVER`（覆盖 server）、`TODOU_TOKEN`（覆盖 token）、
  `TODOU_PROJECT`（覆盖 project）。
- 解析顺序：
  - server：`--server` > `TODOU_SERVER` > cwd 绑定 > `default_server`
  - token：`TODOU_TOKEN` > 配置中该 server 的 token
  - project：`-p` > `TODOU_PROJECT` > cwd 绑定
- 退出码：`0` 成功；`1` API/网络/配置错误（stderr 一行
  `error: <code> — <message>`）；usage 错误由 clipanion 内建处理（非零）。
- stdout 只放数据（人类视图或 JSON）；提示、进度、错误一律 stderr。
- `--json` 输出 = REST 响应原样（`@todou/shared` zod schema），
  `JSON.stringify(…, null, 2)`。

## 2. 命令参考

`--json` 列给出输出对应的 shared 类型。

### 认证与身份

| 命令 | 说明 | --json |
| --- | --- | --- |
| `todou login [server] [--manual]` | localhost 回调换 PAT 写入配置；省略 server 用 `default_server`，皆无则报错。`--manual`：打印指引 + 隐藏粘贴。 | —（本地命令） |
| `todou whoami` | 当前身份 + server origin | `Me` |

### project

| 命令 | 说明 | --json |
| --- | --- | --- |
| `todou project list` | 可见项目列表 | `Project[]` |
| `todou project link <slug> [--server <origin>]` | 当前 git 仓库 remote → server/project 绑定，写入用户配置 | — |
| `todou project unlink` | 移除当前仓库的绑定 | — |

### issue

| 命令 | 说明 | --json |
| --- | --- | --- |
| `todou issue list [--status <name> \| --open \| --closed] [--label <name>]… [--assignee <login\|me>] [-q <text>] [--limit <n>] [--sort created\|updated\|number] [--order asc\|desc]` | 过滤名解析为 id 后调 API；`--open/--closed` → `category` | `IssueListPage` |
| `todou issue create --title <t> [--body <b> \| --body-file <f\|->] [--label <name>]… [--assignee <login\|me>]… [--status <name>]` | TTY 且无 body → `$EDITOR` | `Issue` |
| `todou issue view <number>` | issue + 全量 timeline（沿 `next_cursor` 拼接） | `{ issue: Issue, timeline: TimelineItem[] }` |
| `todou issue edit <number> [--title <t>] [--body <b> \| --body-file <f\|->] [--status <name>] [--add-label\|--remove-label <name>]… [--add-assignee\|--remove-assignee <login\|me>]…` | 标签/指派为读改写（getIssue → 增删 → PATCH 整表） | `Issue` |
| `todou issue close <number> [--status <name>] [--comment <text>]` | 目标 = `--status` 或 closed 类目中 position 最小者；`--comment` 先评论后改状态 | `Issue` |

### comment / label / status / attach

| 命令 | 说明 | --json |
| --- | --- | --- |
| `todou comment add <issue-number> [--body <b> \| --body-file <f\|->]` | TTY 且无 body → `$EDITOR` | `TimelineComment` |
| `todou label list` | | `Label[]` |
| `todou label create --name <n> [--color <#hex>]` | color 缺省用 API 默认 | `Label` |
| `todou label edit <name> [--name <n>] [--color <#hex>]` | `<name>` 解析为 id | `Label` |
| `todou label delete <name>` | | — |
| `todou status list` | | `Status[]` |
| `todou attach <issue-number> <file>...` | 逐个上传；人类视图打印每个附件 URL | `Attachment[]` |

### 透传逃生舱

```
todou api <method> <path> [--body <json|@file|->] [-f k=v]...
```

- `<method>`：get/post/patch/put/delete（大小写不敏感）。
- `<path>`：`/api` 后的路径，如 `/projects/todou/members`。
- `--body`：内联 JSON、`@file` 读文件、`-` 读 stdin。
- `-f k=v`：query 参数，可重复。
- 恒输出 JSON（无人类视图；`--json` 冗余但接受）；204 输出空。

## 3. 配置文件

`$XDG_CONFIG_HOME/todou/config.toml`（缺省 `~/.config/todou/config.toml`），
写入时 0600：

```toml
default_server = "https://todou.example"

[servers."https://todou.example"]
token = "todou_pat_…"

[[bindings]]
remote = "git@github.com:you/todou.git"
server = "https://todou.example"
project = "todou"
```

## 4. `/cli-auth` 浏览器契约

**请求**（CLI 打开）：

```
GET <server>/cli-auth?port=<1-65535>&state=<nonce>&name=<display name>
```

**回调**（页面授权成功后顶级导航）：

```
GET http://127.0.0.1:<port>/callback?token=<todou_pat_…>&state=<nonce>
```

- CLI 侧：`state` 不符 → 400，不写配置；成功 → 200 HTML「已完成，可关闭
  此页」，随后退出监听。等待超时（5 分钟）→ 放弃并提示 `--manual`。
- web 侧：页面挂在登录保护下；未登录经 `/login?redirect=<回跳>` 往返；
  必须显式点击「授权」才调 `POST /me/tokens`。

## 5. shared 新增/变更 API

```ts
// @todou/shared/config（新子路径导出，Node-only）
export class ConfigError extends Error {}
export const flexibleBool: ZodType<boolean>;
export function setPath(target, path: string[], value: unknown): void;
export function loadTomlConfig<S extends z.ZodType>(options: {
  schema: S;
  path?: string;            // 与 tomlSource 二选一
  tomlSource?: string;
  optional?: boolean;       // true：path 缺失 → 空表（CLI 配置、server 默认路径）
  envMap?: Array<[string, string[]]>;
  env?: Record<string, string | undefined>;  // 缺省 process.env
}): z.infer<S>;

// @todou/shared — TodouClient
request<T>(method: string, path: string,
  init?: { json?: unknown; form?: FormData; query?: Query }): Promise<T>;
// （原私有 #request 公开化；现有方法行为不变）
```

server 的 `loadConfig` 对外签名与行为不变。
