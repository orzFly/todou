# todou CLI — 系统设计

> 设计稿见 [brainstorm.md](./brainstorm.md)；本文件落到模块与代码层面。
> 命令面与各类契约的完整参考见 [api.md](./api.md)。

## 1. 总览

```
┌─ projects/cli ──────────────────────────────────────────┐
│ index.ts ── 注册命令                                     │
│                                                          │
│ commands/*  ──▶ ApiCommand / ProjectCommand（基类）      │
│                    │  server/token/project 解析、--json、 │
│                    │  TodouError → exit code             │
│                    ▼                                     │
│ config.ts（读写 ~/.config/todou/config.toml）            │
│ context.ts（cwd → git remote → binding）                 │
│ format.ts（人类视图渲染）                                │
└──────────────┬───────────────────────────────────────────┘
               │ TodouClient（bearer）
┌─ projects/shared ────────────────────────────────────────┐
│ client.ts     #request → 公开 request()（todou api 用）  │
│ config.ts(新) loadTomlConfig / ConfigError / flexibleBool│
│               子路径导出 @todou/shared/config（Node-only）│
└──────────────┬───────────────────────────────────────────┘
               │ REST /api/*
┌─ projects/server ─（零改动；config.ts 改用 shared loader）┐
┌─ projects/web ───────────────────────────────────────────┐
│ /cli-auth 页面（新）+ /login redirect 参数（新）          │
└──────────────────────────────────────────────────────────┘
```

不引入新的第三方依赖：CLI 用已有的 `clipanion`；`smol-toml` 从 server 移到
shared；颜色用 Node 内建 `util.styleText`；回调服务器用 `node:http`；git
探测用 `node:child_process` 的 `spawnSync`；文件上传用 `node:fs` 的
`openAsBlob` + 全局 `File`/`FormData`（Node 24）。

## 2. shared 改动

### 2.1 config loader 抽取（`projects/shared/src/config.ts`，新文件）

从 `projects/server/src/config.ts` 移出**与 server schema 无关**的机制：

- `ConfigError`
- `flexibleBool`（TOML 真布尔 / ENV "true"/"1" 字符串）
- `setPath(target, path, value)`
- `loadTomlConfig<S extends ZodType>(options)`：读 TOML（`tomlSource` 或
  `path`；`optional: true` 时文件缺失返回空表）→ 按 `envMap` 覆盖 → schema
  parse。签名见 api.md §5。

包装配：`projects/shared/package.json` 新增子路径导出
`"./config": "./src/config.ts"`，并把 `smol-toml` 依赖移入 shared。该文件
**不**从 `"."`（index.ts）re-export——它 import `node:fs`，不能进浏览器面。

server 侧重构：`projects/server/src/config.ts` 改 import shared 的机制，
保留自己的 `ConfigSchema`、`ENV_MAP`、后处理（static_dir 绝对化、
url_template 编译、auth.mode/database.system 校验）。对外 API
（`loadConfig`、`Config`、`ConfigError` re-export）不变，
`test/config.test.ts` 应原样通过。

### 2.2 `TodouClient.request` 公开

私有 `#request` 改为公开方法 `request<T>(method, path, init?)`（原有各方法
改调 `this.request`）。`todou api` 透传命令直接使用；对 web 无影响。

## 3. CLI 包设计

### 3.1 `config.ts` — CLI 自身配置

zod schema（用 shared loader 加载）：

```ts
const ServerEntry = z.object({ token: z.string() });
const Binding = z.object({
  remote: z.string(),      // git remote URL，绑定键
  server: z.string(),      // origin
  project: z.string(),     // slug
});
const CliConfig = z.object({
  default_server: z.string().optional(),
  servers: z.record(z.string(), ServerEntry).default({}),
  bindings: z.array(Binding).default([]),
});
```

- `configPath(env)`：`$XDG_CONFIG_HOME ?? ~/.config` + `/todou/config.toml`。
- `loadCliConfig(env)`：文件缺失 → 空配置（optional）。
- `saveCliConfig(config, env)`：`mkdir -p` 目录、`smol-toml` stringify 写入、
  `chmod 0600`。login / project link / unlink 都经它写回。

### 3.2 `context.ts` — 运行上下文解析

```ts
gitRemoteUrl(cwd): string | null   // spawnSync git remote get-url origin；
                                   // 无 origin 且恰一个 remote 时取它；
                                   // 其余情形（含 git 缺失/非仓库）返回 null
resolveContext(input: {
  flags: { server?: string; project?: string };
  env: Record<string, string | undefined>;
  config: CliConfig;
  remoteUrl: string | null;        // 由 gitRemoteUrl 注入，纯函数便于测试
}): { server: string; token?: string; project?: string }
```

解析顺序即 brainstorm §2 的表；`token` 取
`env.TODOU_TOKEN ?? config.servers[server]?.token`。缺 server/token 在这里
不抛——由基类在真正需要时给出带指引的错误（见 3.3），`project` 同理由
`ProjectCommand` 检查。

### 3.3 命令基类（`api-command.ts`）

```ts
abstract class ApiCommand extends Command {
  server = Option.String("--server", { description: "server origin" });
  json = Option.Boolean("--json", false);
  abstract run(client: TodouClient, ctx: ResolvedContext): Promise<void>;
  async execute() { /* 解析上下文 → 建 client → try { run } catch → exit code */ }
  protected output(data: unknown, human: () => string): void;
}

abstract class ProjectCommand extends ApiCommand {
  project = Option.String("-p,--project");
  // run(client, ctx) 前置校验 ctx.project，缺失给三种给法的提示
}
```

- `execute()` 统一错误映射：`TodouError` → stderr
  `error: <code> — <message>`，return 1；`ConfigError`/上下文缺失 → 带指引
  提示，return 1；fetch 网络错误 → 提示检查 server/网络，return 1。
- `output(data, human)`：`--json` 时 `JSON.stringify(data, null, 2)` 到
  stdout，否则调用 `human()`。提示/进度一律 `this.context.stderr`。
- client 构造：`new TodouClient({ baseUrl: ctx.server, token: ctx.token })`；
  测试经 clipanion 的 context 注入 fetch stub（TodouClient 支持
  `fetch` 选项）——基类从 `this.context` 读可选的 `fetchImpl`。

### 3.4 name → id 解析（`resolve.ts` 或并入基类 helpers）

REST 的过滤/写入参数用 id；CLI 面向人用名字。每次命令执行内按需拉取并解析
（不做跨进程缓存）：

- `resolveStatus(client, project, name)` → `listStatuses` 精确匹配（大小写
  不敏感）；未命中 → 报错并列出全部状态名。
- `resolveLabels(client, project, names[])` → 同上，基于 `listLabels`。
- `resolveAssignee(client, project, loginOrMe)` → `me` 走 `GET /me`；否则
  `listMembers` 按 login 匹配。
- `pickClosedStatus(statuses, override?)`：`--status` 给了就解析之；否则取
  `category == "closed"` 中 position 最小者；项目没有关闭态 → 报错。

`issue edit` 的 `--add-label/--remove-label`、`--add-assignee/
--remove-assignee` 是读改写：先 `getIssue` 取当前 `labels`/`assignees`，
应用增删后整表 PATCH（`label_ids`/`assignee_ids`）。

### 3.5 正文输入（`body.ts` helper）

`readBody({ body?, bodyFile?, stdin, tty })`：

1. `--body` 直接用；
2. `--body-file -` 读完 stdin，`--body-file <f>` 读文件；
3. 都没给且 stdin 是 TTY：`$EDITOR`（缺省 `vi`）开临时文件（`os.tmpdir()`,
   后缀 `.md`），关闭后读回，空内容视为取消；
4. 都没给且非 TTY（agent 场景）：报错要求显式给 body。

### 3.6 `login.ts`

时序（brainstorm §5）：

```
CLI                        浏览器                      web /cli-auth
 │ 生成 state、起 127.0.0.1:随机port 的 node:http
 │ 打开 <server>/cli-auth?port&state&name ─▶
 │                          │ （未登录→/login?redirect=…→回来）
 │                          │ 用户点「授权」
 │                          │ createMyToken({name}) ─▶ POST /me/tokens
 │                          ◀─ TokenCreated.token
 │  ◀── 302 http://127.0.0.1:port/callback?token&state
 │ 校验 state → 写配置（servers[origin].token、default_server）
 │ 响应「已完成，可关闭此页」→ 关监听 → 打印 whoami 摘要
```

- 打开浏览器：按平台 `xdg-open` / `open` / `start`，spawn 失败则打印 URL。
- 超时（如 5 分钟）自动放弃并提示 `--manual`。
- `--manual`：打印 `<server>/settings/tokens` 指引 + stdin 隐藏输入（自实现
  muted readline，无新依赖）。
- 安全：监听只绑 `127.0.0.1`；`state` 不符返回 400 且不写配置；token 不回显。

### 3.7 `format.ts`

- `table(rows, columns)`：按最宽单元对齐的空格分隔列（无表格库）；
- `styleText` 包装（label 颜色点、状态着色、dim 时间戳），非 TTY /
  `NO_COLOR` 自动降级（`util.styleText` 内建处理）；
- 相对时间（`3h ago`）自实现（`Intl.RelativeTimeFormat`）。

## 4. web 改动

### 4.1 `/login` 支持 redirect 参数

- `loginRoute` 加 `validateSearch`：`{ redirect?: string }`；登录成功后
  `navigate({ to: redirect ?? "/projects" })`，仅接受站内路径（以 `/` 开头
  且非 `//`），防开放跳转。
- `AuthedLayout` 401 时 `<Navigate to="/login" search={{ redirect:
  location.href }} />`（TanStack Router 的 `useLocation()`）。

### 4.2 `/cli-auth` 页面（`pages/cli-auth.tsx`，挂在 authedRoute 下）

- `validateSearch`：`{ port: number（1–65535）, state: string, name?:
  string }`；非法参数直接显示错误。
- 界面：显示「授权 todou CLI（<name ?? "todou CLI">）访问你的账号？」+
  当前用户 + 确认/取消按钮。**绝不自动签发**——必须显式点击（防第三方站点
  诱导跳转静默取 token）。
- 确认 → `api.createMyToken({ name })` → `window.location.assign(
  "http://127.0.0.1:<port>/callback?token=…&state=…")`（顶级导航到
  loopback，无混合内容问题）。失败显示错误与重试。
- 取消 → 跳回 `/projects`。

## 5. 测试设计

| 层 | 手段 |
| --- | --- |
| shared config loader | 单测：TOML/env 覆盖/缺文件/坏 schema（部分由 server 现有 config.test.ts 间接覆盖，行为须不变） |
| shared client.request | 单测：方法/路径/头/错误映射（现有 client 测试扩一条） |
| cli config/context | 临时目录 + 真 `git init`（加 remote）；覆盖 XDG、0600、解析顺序矩阵、link/unlink 往返 |
| cli 命令 | clipanion `Cli.run([...], context)` + 注入 fetch stub；断言请求（方法/路径/query/body）与 stdout（`--json` 全量、人类视图关键字段）；stderr 错误路径 |
| cli login | 起真回调监听；fetch 模拟浏览器 redirect；覆盖 state 不符 → 400、超时、--manual |
| web | Testing Library：cli-auth 确认→mint→assign（mock `location.assign`）、login redirect 参数 |
| 真机 | 对 https://todou.example 手动跑通 login/whoami/issue 流（见 plan 收尾步骤） |

## 6. 安全考量

- 回调监听只绑 `127.0.0.1`，随机端口，一次一用；`state` nonce 必须回传一致。
- `/cli-auth` 必须已登录 + 显式点击授权；`name` 仅作展示与 token 命名。
- 配置文件 0600；token 永不写 stdout/stderr；`todou api` 输出的是 API 响应，
  不含请求头。
- `/login` 的 `redirect` 限站内路径。
