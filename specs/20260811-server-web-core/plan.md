# Plan: todou server + web core

按阶段执行；每阶段以 `pnpm fmt && pnpm lint && pnpm typecheck && pnpm test`
全绿收尾，并做一次 conventional commit。设计依据：[design.md](design.md)
与 [api.md](api.md)。

## Phase 0 — workspace 准备

1. 新建 `projects/shared`：package.json（`exports` → `./src/index.ts`）、
   tsconfig（extends base）、空 `src/index.ts`、占位测试。
2. 安装依赖：
   - shared: `zod`；dev `typescript vitest`
   - server: `hono @hono/node-server @hono/zod-openapi drizzle-orm
     @electric-sql/pglite pg smol-toml @todou/shared(workspace:*)`；
     dev `drizzle-kit @types/pg`
   - web: `@tanstack/react-router @tanstack/react-query
     @tanstack/react-virtual @dnd-kit/core @dnd-kit/sortable
     react-markdown remark-gfm @todou/shared(workspace:*)`；
     dev `tailwindcss @tailwindcss/vite @testing-library/react happy-dom`
3. 验证 Node/Vite 均能消费 shared 的 `.ts` 导出（server/web 各引一个符号）。

**Commit**: `chore: add shared package and slice-1 dependencies`

## Phase 1 — shared schemas + server 配置 + DB 基础

1. shared `schemas/*`：common（ID/cursor/error）、user、token、project
   （含 status/label/member）、issue（含过滤 DTO）、timeline（event type
   枚举 + payload 判别联合）、attachment；`events.ts` SSE 常量。单测。
2. server `config.ts`：默认值 → TOML（`--config`，默认 ./todou.toml）→
   `TODOU_*` ENV → zod 校验（`[auth] mode` 本切片仅接受 `single`）。单测。
3. server `db/schema.ts` 全部表（见 brainstorm §2）+ `db/index.ts` 驱动
   工厂（`pglite://` / `postgres://`）；drizzle-kit 生成首个迁移进仓库；
   clipanion `migrate` 子命令；`bootstrap.ts`（pglite 自动迁移 + single
   seed 内置 `user`）。
4. 测试基建：`pglite://memory` 每 suite 新库 + 迁移的 helper。

**Commit**: `feat(server): config, schema, migrations, db drivers`

## Phase 2 — 认证

1. `auth/pat.ts`（生成/校验/hash）、`auth/session.ts`（hash 存储、30 天
   滑动 TTL）、`auth/middleware.ts`（Bearer → Cookie → 401）。
2. 路由：`POST /auth/login`（single 零输入）、`/auth/logout`、`GET /me`、
   `/me/tokens` 签发/列表/吊销。
3. `app.ts` 组装 + `errors.ts` 全局映射。
4. 测试：鉴权矩阵（PAT 有效/吊销/过期/格式错、无效 PAT 绝不降级、
   single 登录、logout、/me 双凭证）。

**Commit**: `feat(server): sessions, PAT, single-mode login`

## Phase 3 — projects / members / statuses / labels

1. services + routes：project CRUD（建者即 admin、seed 三 status）、
   member 增删改、status CRUD（排序、被引用删除 → 409）、label CRUD。
2. 角色守卫 helper（reader/writer/admin + instance admin 旁路）。
3. 测试：CRUD + 权限矩阵 + status 删除保护 + slug 冲突 409。

**Commit**: `feat(server): projects, members, statuses, labels`

## Phase 4 — issues / comments / timeline / 事件

1. `issues.ts`：编号事务分配、创建（`opened` 事件）、PATCH 差异 →
   事件（closed/reopened/status_changed/title_changed/label_*/
   (un)assigned）、列表过滤 + cursor 分页。
2. `comments.ts` + `references.ts`（`#N` 解析 → `referenced` 事件，
   去重、排除自引用）。
3. `timeline.ts`：归并查询 + 双向 keyset cursor + `last=1`。
4. 测试：编号并发（Promise.all 创建 20 个 issue 编号不重）、事件正确性、
   引用解析边界（代码块内 `#N` 不豁免——按纯文本正则，记录该取舍）、
   timeline 排序与双向翻页。

**Commit**: `feat(server): issues, comments, timeline, issue events`

## Phase 5 — 附件（fs）

1. `storage/types.ts` + `storage/fs.ts`（分片路径、大小限制）。
2. 上传（multipart）/下载路由 + member 鉴权 + `attachment_added` 事件。
3. 测试：上传下载往返、超限 413/422、无权限 403、文件名 sanitize。

**Commit**: `feat(server): fs attachment storage`

## Phase 6 — agents + PAT 管理

1. `agents.ts`：创建（owner 归属）、列表（owner=me/all）、改名/停用、
   为 agent 签发/吊销 token（owner 或 instance admin）。
2. machine user 调用 `POST /agents` → 403。
3. 测试：归属权限、agent 以 PAT 全流程操作 issue（真实 agent 路径）。

**Commit**: `feat(server): machine users and token management`

## Phase 7 — SSE + OpenAPI

1. `events/bus.ts`（进程内，按 project 订阅）；services 事务提交后发布。
2. `routes/sse.ts`：streamSSE + 30s 心跳 + member 鉴权。
3. `/api/openapi.json` 由 zod-openapi 输出。
4. 测试：bus 发布/订阅、SSE 路由鉴权与首包、事件在事务提交后才发布。

**Commit**: `feat(server): SSE change feed and OpenAPI document`

## Phase 8 — web 基础

1. Tailwind v4（@tailwindcss/vite + styles.css）+ shadcn/ui 初始化
   （components.json，`pnpm dlx shadcn add` 基础组件：button/input/
   table/dialog/select/badge/dropdown-menu/tooltip/sonner…）。
2. TanStack Router 路由树 + QueryClient + shared `TodouClient`（同源
   /api，vite proxy → :3000）。
3. 登录流：401 → `/login` → single 模式自动调 `/auth/login` 秒过 → 回跳。
4. 布局壳（顶栏：项目切换、用户菜单）+ `/projects` 列表页 + 建项目对话框。

**Commit**: `feat(web): app shell, tailwind + shadcn, login flow, projects page`

## Phase 9 — list view

1. `/projects/:slug`：IssueTable + FilterBar（状态/标签/指派/类别/搜索，
   全部落 search params）+ cursor 翻页。
2. 行内改 status/label（dropdown，乐观更新）；新建 issue 对话框。
3. UserChip（agent 徽章 + owner tooltip）、StatusPill、LabelChip 组件。
4. 组件测试：过滤参数 ↔ URL、行内乐观更新回滚。

**Commit**: `feat(web): issue list view with filters`

## Phase 10 — issue 详情 + 虚拟 timeline

1. `/projects/:slug/issues/:number`：标题/正文（MarkdownView）、侧栏
   （status/labels/assignees 编辑）。
2. Timeline：双向 useInfiniteQuery（before/after cursor，初始 `last=1`）
   + react-virtual 动态测高；EventRow（灰字 action 行）/CommentItem。
3. 底部跟随：距底 < 1 屏自动滚动，否则「↓ 新消息」浮标。
4. CommentComposer 乐观发布 + 失败重试标记。
5. 组件测试：归并渲染、跟随策略、乐观评论。

**Commit**: `feat(web): issue page with virtualized timeline`

## Phase 11 — kanban

1. `/projects/:slug/board`：列 = status（position 排序），dnd-kit 拖拽。
2. 落下 → PATCH status（乐观移动，失败回滚 + toast）。
3. 列头显示 open/closed 类别与计数。
4. 组件测试：拖拽结果映射、回滚。

**Commit**: `feat(web): kanban board`

## Phase 12 — 实时

1. `useProjectEvents`：EventSource 连接 `/projects/:slug/events`，指针
   事件 → invalidate 映射（见 api.md）；重连后全量 invalidate 补偿。
2. Timeline 接入 `timeline.*` 事件（在底部则平滑追加）。
3. 测试：mock EventSource → invalidate 断言。

**Commit**: `feat(web): SSE live updates`

## Phase 13 — 设置页

1. `/projects/:slug/settings`：members（增删改 role，可加 agent）、
   statuses（增删改排序，删除被引用时提示迁移）、labels。
2. `/settings/agents`：创建 agent、签发 token（明文一次性展示 + 复制）、
   吊销、归属展示。
3. 组件测试：token 一次性展示流程。

**Commit**: `feat(web): project settings and agent management`

## Phase 14 — 收尾

1. 空态/加载骨架/错误 toast 巡检；`todou-server serve` 优雅关闭复核。
2. README 更新（运行方式：`todou-server serve` + `pnpm --filter
   @todou/web dev`）；AGENTS.md 若命令有变则同步。
3. 全量验证：`pnpm fmt && pnpm lint && pnpm typecheck && pnpm test`；
   手动冒烟：单用户登录 → 建项目 → 建 issue → 评论（含 #N 引用）→
   拖 kanban → 双开浏览器验证 SSE → agent PAT 走 API 发评论。

**Commit**: `chore: slice-1 polish and docs`

## 风险与提前决策

- **@hono/zod-openapi 与 zod v4**：若版本不兼容，降级方案为
  `@hono/zod-validator` + 手写精简 openapi.json（API 面不变）。
- **PGlite 并发**：单连接串行执行，编号并发测试意在验证事务正确性
  而非并行度；postgres:// 路径同套测试跑一遍（CI 可选）。
- **`#N` 解析在代码块内误报**：本切片接受（纯正则），如成噪音在
  后续切片改为 markdown AST 解析。
- **虚拟列表测高抖动**：react-virtual `measureElement` 动态测量；
  图片加载引起的高度变化用 `onLoad` 触发 re-measure。
