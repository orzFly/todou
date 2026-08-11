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

## Phase 1 — shared schemas + 配置 + 双层 DB 基础

1. shared `schemas/*`：common（ID/cursor/error）、user（含 UserRef）、
   token、project（含 status/label/member）、issue（含过滤 DTO）、
   timeline（event type 枚举 + payload 判别联合）、attachment；
   `events.ts` SSE 常量。单测。
2. server `config.ts`：默认值 → TOML（`--config`，默认 ./todou.toml）→
   `TODOU_*` ENV → zod 校验。含 `[database] system`、`[database.projects]
   placement/url_template/max_open/workers`、`[auth] mode`（本切片仅
   `single`）。单测（含 dedicated 缺 url_template 报错）。
3. server `db/`：`system-schema.ts` + `project-schema.ts`（见 brainstorm
   §2）；`driver.ts`（pglite:// | postgres:// → drizzle 实例，host 先只有
   inline）；`router.ts`（`system()`/`forProject(id)`：注册表覆盖 →
   模板解析——支持 `{id}` 与 `{id%N}` 取模分桶——句柄**按最终 URL**
   缓存、dedicated PGlite LRU）。
4. 两份 drizzle-kit 配置生成 `migrations/system/` 与 `migrations/project/`
   首个迁移进仓库；clipanion `migrate` 子命令（系统库 + 遍历注册表迁移
   项目库）；`bootstrap.ts`（pglite 自动迁移 + single seed 内置 `user`）。
5. 测试基建：`pglite://memory` helper，**参数化放置模式**（shared /
   dedicated-per-project / dedicated-bucketed）供后续 suite 复用；router
   单测（`{id}`/`{id%N}` 模板解析、URL 键缓存去重、LRU、覆盖列）。

**Commit**: `feat(server): config, two-tier db schemas, router, migrations`

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

1. `projects.ts`：注册表 CRUD + **provision 流程**（dedicated：幂等
   确保目标库存在并迁移——分桶时桶库可能已存在——→ project_meta +
   seed 三 status；失败补偿删除注册表行）；删除反向（先摘注册表；
   `{id}` 放置删库文件，分桶/shared 放置删该 project_id 的行）。
2. `members.ts`（系统库）；`statuses.ts`/`labels.ts`（项目库；status
   排序、被引用删除 → 409）。
3. 角色守卫 helper（reader/writer/admin + instance admin 旁路，只读
   系统库）。
4. 测试（shared/dedicated 双放置跑）：CRUD、权限矩阵、provision 失败
   补偿、status 删除保护、slug 冲突 409。

**Commit**: `feat(server): projects with provisioning, members, statuses, labels`

## Phase 4 — issues / comments / timeline / 事件

1. `issues.ts`：`project_meta` 编号事务分配、创建（`opened` 事件）、
   PATCH 差异 → 事件（closed/reopened/status_changed/title_changed/
   label_*/(un)assigned）、列表过滤 + cursor 分页。
2. `comments.ts` + `references.ts`（`#N` → `referenced` 事件，去重、
   排除自引用）。
3. `timeline.ts`：归并 + 双向 keyset cursor + `last=1`；`user-refs.ts`
   系统库批量 enrich + 30s TTL 缓存（含 ghost 用户兜底）。
4. 测试（双放置）：编号并发（Promise.all 20 个不重号）、事件正确性、
   引用解析边界（代码块内 `#N` 误报为已知取舍）、timeline 排序与双向
   翻页、enrich 缓存。

**Commit**: `feat(server): issues, comments, timeline, issue events`

## Phase 5 — 附件（fs）

1. `storage/types.ts` + `storage/fs.ts`（分片路径、大小限制）。
2. 上传（multipart）/下载路由 + member 鉴权 + `attachment_added` 事件。
3. 测试：上传下载往返、超限、无权限 403、文件名 sanitize。

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

## Phase 8 — PGlite worker host（spike，时间盒 ≤1 天，可跳过不阻塞）

1. `driver.ts` 增加 `worker` host：worker_thread 内跑 PGlite，主线程
   MessagePort 代理实现 drizzle-orm/pglite 所需查询接口。
2. `[database.projects] workers = true` 时启用（默认 false）。
3. 验收：项目库集成测试在 worker host 下全绿 + 多库并发 benchmark
   （对比 inline）。若代理不可行，记录结论与退化方案后关闭该 flag。

**Commit**: `feat(server): experimental worker-hosted pglite` 或
`docs: worker-pglite spike findings`

## Phase 9 — web 基础

1. Tailwind v4（@tailwindcss/vite + styles.css）+ shadcn/ui 初始化
   （components.json，基础组件：button/input/table/dialog/select/badge/
   dropdown-menu/tooltip/sonner…）。
2. TanStack Router 路由树 + QueryClient + shared `TodouClient`（同源
   /api，vite proxy → :3000）。
3. 登录流：401 → `/login` → single 模式自动调 `/auth/login` 秒过 → 回跳。
4. 布局壳（顶栏：项目切换、用户菜单）+ `/projects` 列表页 + 建项目对话框。

**Commit**: `feat(web): app shell, tailwind + shadcn, login flow, projects page`

## Phase 10 — list view

1. `/projects/:slug`：IssueTable + FilterBar（状态/标签/指派/类别/搜索，
   全部落 search params）+ cursor 翻页。
2. 行内改 status/label（dropdown，乐观更新）；新建 issue 对话框。
3. UserChip（agent 徽章 + owner tooltip）、StatusPill、LabelChip 组件。
4. 组件测试：过滤参数 ↔ URL、行内乐观更新回滚。

**Commit**: `feat(web): issue list view with filters`

## Phase 11 — issue 详情 + 虚拟 timeline

1. `/projects/:slug/issues/:number`：标题/正文（MarkdownView）、侧栏
   （status/labels/assignees 编辑）。
2. Timeline：双向 useInfiniteQuery（before/after cursor，初始 `last=1`）
   + react-virtual 动态测高；EventRow（灰字 action 行）/CommentItem。
3. 底部跟随：距底 < 1 屏自动滚动，否则「↓ 新消息」浮标。
4. CommentComposer 乐观发布 + 失败重试标记。
5. 组件测试：归并渲染、跟随策略、乐观评论。

**Commit**: `feat(web): issue page with virtualized timeline`

## Phase 12 — kanban

1. `/projects/:slug/board`：列 = status（position 排序），dnd-kit 拖拽。
2. 落下 → PATCH status（乐观移动，失败回滚 + toast）。
3. 列头显示 open/closed 类别与计数。
4. 组件测试：拖拽结果映射、回滚。

**Commit**: `feat(web): kanban board`

## Phase 13 — 实时

1. `useProjectEvents`：EventSource 连接 `/projects/:slug/events`，指针
   事件 → invalidate 映射（见 api.md）；重连后全量 invalidate 补偿。
2. Timeline 接入 `timeline.*` 事件（在底部则平滑追加）。
3. 测试：mock EventSource → invalidate 断言。

**Commit**: `feat(web): SSE live updates`

## Phase 14 — 设置页

1. `/projects/:slug/settings`：members（增删改 role，可加 agent）、
   statuses（增删改排序，删除被引用时提示迁移）、labels。
2. `/settings/agents`：创建 agent、签发 token（明文一次性展示 + 复制）、
   吊销、归属展示。
3. 组件测试：token 一次性展示流程。

**Commit**: `feat(web): project settings and agent management`

## Phase 15 — 收尾

1. 空态/加载骨架/错误 toast 巡检；优雅关闭复核（含关闭全部项目库句柄）。
2. README 更新（运行方式：`todou-server serve` + `pnpm --filter
   @todou/web dev`；两种放置的配置示例）；AGENTS.md 若命令有变则同步。
3. 全量验证：`pnpm fmt && pnpm lint && pnpm typecheck && pnpm test`；
   手动冒烟：单用户登录 → 建项目（dedicated 放置验证一次）→ 建 issue →
   评论（含 #N 引用）→ 拖 kanban → 双开浏览器验证 SSE → agent PAT 走
   API 发评论。

**Commit**: `chore: slice-1 polish and docs`

## 风险与提前决策

- **@hono/zod-openapi 与 zod v4**：若版本不兼容，降级方案为
  `@hono/zod-validator` + 手写精简 openapi.json（API 面不变）。
- **双层库跨库一致性**：project 创建/删除是跨库操作，采用补偿式
  （设计 §2）；其余写路径均为单库事务。
- **PGlite 并发**：单实例单连接串行；dedicated 放置下不同 project 天然
  并行（inline host 下仍共享主线程 CPU——worker spike 即为此而设）。
- **`#N` 解析在代码块内误报**：本切片接受（纯正则），如成噪音后续改
  markdown AST。
- **虚拟列表测高抖动**：react-virtual `measureElement` 动态测量；图片
  `onLoad` 触发 re-measure。
