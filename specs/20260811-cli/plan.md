# todou CLI — 实施计划

> 依据 [brainstorm.md](./brainstorm.md) 与 [design.md](./design.md)。
> 每步以 `pnpm fmt && pnpm lint && pnpm typecheck && pnpm test` 全绿为完成
> 条件，按 AGENTS.md 惯例提交（conventional prefix + 单个 Co-Authored-By）。

## 步骤 1 — shared：config loader 抽取

1. 新建 `projects/shared/src/config.ts`：从 server 移入 `ConfigError`、
   `flexibleBool`、`setPath`，实现通用 `loadTomlConfig`（api.md §5 签名，
   含 `optional` 语义：默认路径缺失返回空表、显式路径缺失抛错）。
2. `projects/shared/package.json`：exports 增加
   `"./config": "./src/config.ts"`；`smol-toml` 移入 dependencies。
   确认 `"."` 不 re-export 该文件（浏览器面不受影响）。
3. 重构 `projects/server/src/config.ts`：改用 shared 机制，保留
   `ConfigSchema`、`ENV_MAP`、后处理与校验；对外 `loadConfig` / `Config` /
   `ConfigError`（re-export）不变；server 的 `smol-toml` 依赖移除。
4. 测试：shared 新增 `test/config.test.ts`（TOML 解析、env 覆盖、optional
   路径、坏 schema → ConfigError）；server 现有 `test/config.test.ts` 不改
   一行必须照常通过。

提交：`refactor(shared): extract TOML+env config loader from server`

## 步骤 2 — shared：`TodouClient.request` 公开

1. `#request` → 公开 `request()`；类内调用点批量改。
2. shared client 测试补一条：直接 `client.request("GET", "/projects")` 与
   错误映射（非 2xx → TodouError）。

提交：`feat(shared): expose TodouClient.request for raw API calls`

## 步骤 3 — cli：配置与上下文

1. `src/config.ts`：`CliConfig` schema（design §3.1）、`configPath`（XDG）、
   `loadCliConfig`、`saveCliConfig`（mkdir + stringify + 0600）。
2. `src/context.ts`：`gitRemoteUrl(cwd)`（spawnSync；origin 优先，无 origin
   且恰一个 remote 用之，否则 null）、`resolveContext`（纯函数，
   design §3.2）。
3. 测试 `test/config.test.ts` / `test/context.test.ts`：临时 HOME/
   XDG_CONFIG_HOME 下读写往返 + 权限 0600；临时目录 `git init` + `git
   remote add` 覆盖 origin/单 remote/多 remote/非仓库；解析顺序矩阵
   （flag/env/绑定/default 的每层覆盖）。

提交：`feat(cli): config file and context resolution`

## 步骤 4 — cli：命令基建

1. `src/api-command.ts`：`ApiCommand` / `ProjectCommand`（design §3.3）：
   `--server`、`--json`、上下文解析、client 构造（context 可注入 fetch）、
   `output()`、错误 → 退出码与指引文案（缺 token → `todou login`；缺
   project → 三种给法）。
2. `src/format.ts`：`table()`、styleText 包装、相对时间。
3. `src/resolve.ts`：`resolveStatus` / `resolveLabels` / `resolveAssignee` /
   `pickClosedStatus`（design §3.4，未命中报错并列出可选值）。
4. `src/body.ts`：`readBody`（design §3.5，含 $EDITOR 与非 TTY 报错）。
5. `src/index.ts`：注册模式定型（数组导入 + 循环 register）。
6. 测试：基建单元测试（错误映射、output 两态、resolve 未命中文案、
   readBody 各分支——$EDITOR 用假编辑器脚本）。

提交：`feat(cli): command base class, formatting, and resolvers`

## 步骤 5 — cli：只读命令（whoami / project list / issue list / issue view / label list / status list）

1. `commands/whoami.ts`、`commands/project.ts`（list 部分）、
   `commands/issue.ts`（list/view）、`commands/label.ts`（list）、
   `commands/status.ts`。
2. `issue list`：flags → name 解析 → `IssueListQuery` 参数（csv id、
   category、q、sort/order/limit）；人类视图列
   `number/title/status/labels/assignees/updated`。
3. `issue view`：`getIssue` + timeline 沿 `next_cursor` 全量拼接；人类视图
   正文 + 时间线；`--json` 输出 `{ issue, timeline }`。
4. 测试：fetch stub 断言 query 组装（含 `--open/--closed`→category、
   label 名→id）、`--json` 原样性、视图关键字段。

提交：`feat(cli): read commands — whoami, project/issue/label/status list, issue view`

## 步骤 6 — cli：写命令（issue create/edit/close · comment add · label CRUD · attach）

1. `issue create`：`--title` + readBody + name→id（status/labels/
   assignees）。
2. `issue edit`：读改写标签/指派（getIssue → 增删 → PATCH 整表）+
   title/body/status。
3. `issue close`：`pickClosedStatus`；`--comment` 先 `createComment` 再
   PATCH status。
4. `comment add`、`label create/edit/delete`。
5. `attach`：`openAsBlob` → `File` → `uploadAttachment` 逐个上传，打印
   URL；`--json` 输出 `Attachment[]`。
6. 测试：每条命令请求体断言 + 读改写路径（edit 的增删并集）、close 的
   状态选择与 `--comment` 顺序、attach 的 multipart。

提交：`feat(cli): write commands — issue create/edit/close, comment, label, attach`

## 步骤 7 — cli：`todou api` 透传

1. `commands/api.ts`：method/path 校验、`--body`（内联/@file/-）、`-f`
   query、经 `client.request` 发出，恒 JSON 输出，204 → 空。
2. 测试：各 body 来源、query 组装、错误透传。

提交：`feat(cli): generic api passthrough command`

## 步骤 8 — web：`/login` redirect + `/cli-auth` 页面

1. `router.tsx`：loginRoute 加 `validateSearch`（`redirect?: string`）；
   `AuthedLayout` 401 → `Navigate to /login` 带当前 href；`pages/login.tsx`
   成功后跳 `redirect`（仅站内路径）？否则 `/projects`。
2. `pages/cli-auth.tsx` + 路由（authed 下）：search 校验（port/state/
   name）、显式授权按钮 → `createMyToken({ name })` →
   `location.assign("http://127.0.0.1:<port>/callback?token&state")`；
   取消 → `/projects`；失败态与重试。
3. 测试（Testing Library）：授权点击 → mint + assign 参数正确（mock
   assign）；非法 search 显示错误；login redirect 往返。

提交：`feat(web): cli-auth authorization page and login redirect support`

## 步骤 9 — cli：`todou login`

1. `commands/login.ts`：state 生成、`node:http` 一次性监听（127.0.0.1 随机
   端口）、平台化开浏览器（失败打印 URL）、5 分钟超时、回调校验 state →
   `saveCliConfig`（server token + default_server）→ 成功页 + stderr 摘要。
2. `--manual`：指引 + muted readline 隐藏粘贴 → 同样落盘。
3. 测试：真监听 + fetch 模拟回调（成功、state 不符 → 400 不落盘、超时）；
   `--manual` 用注入 stdin。

提交：`feat(cli): browser-based login flow`

## 步骤 10 — 收尾

1. 文档：README「Running」下补 CLI 快速上手（login → issue list）；
   `docs/` 如有合适位置补充命令参考指引（指向 `todou --help`）。
2. 全套检查 + 全部测试。
3. **真机验证**（https://todou.example，参照 dogfood 惯例）：
   `todou login`（浏览器流）→ `whoami` → `project list` →
   在 `dogfood` 项目走一遍 issue create/view/edit/comment/attach/close
   （含 `--json`）→ `todou api get /me/tokens`。
4. 验证通过后，用新 CLI 在 `todou` 项目给 issue #1 留言并关闭：
   `todou issue close 1 -p todou --comment "shipped in <commit>"`——CLI 自己
   关闭自己的 issue，作为端到端验收。

提交：`docs: CLI quickstart`（如有文档改动）

## 风险与注意

- **clipanion 4.0.0-rc.4**：Option/Builtins API 以现装版本为准，遇 rc 差异
  查 `node_modules/clipanion` 的类型而非线上文档。
- **兼容**：server `loadConfig` 行为不得变（现有 config.test.ts 是回归
  网）；shared `"."` 导出不得引入 Node-only 模块。
- **PGlite 测试较慢**：server 测试 ~16s，CI 全量跑即可，无需优化。
- **不做**（brainstorm §9）：发布/打包、MCP、SSE 命令、附件下载、--all
  翻页、TUI、member/agent/token 专用命令。
