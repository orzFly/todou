# Design: todou server + web core

基于已批准的 [brainstorm.md](brainstorm.md)。本文补充实现级设计：模块划分、
第三方库选型、关键机制。API 明细见 [api.md](api.md)，执行步骤见 [plan.md](plan.md)。

## 1. 约束回顾

- Node 24 直跑 `.ts`（native type stripping），全仓 `erasableSyntaxOnly`，
  **无构建步骤**（web 由 Vite 开发服务器承载，静态托管属后续切片）。
- pnpm workspace：`projects/{shared,server,web,cli}`；cli 本切片不动。
- `@todou/shared` 的 `exports` 指向 `.ts` 源码；pnpm 符号链接解析到
  `node_modules` 外的真实路径，Node 与 Vite 均可直接消费。

## 2. 模块划分

### projects/shared

```
src/
├── index.ts            汇总导出
├── schemas/            zod v4 schema（同时是类型来源与校验器）
│   ├── common.ts       ID、cursor 分页、错误响应、时间戳
│   ├── user.ts         User（kind、owner）、Me
│   ├── token.ts        PAT（签发请求/响应、列表项）
│   ├── project.ts      Project、Member、Status、Label
│   ├── issue.ts        Issue、过滤参数、创建/更新 DTO
│   ├── timeline.ts     Comment、IssueEvent（含 type 枚举与 payload 判别联合）
│   └── attachment.ts   Attachment
├── events.ts           SSE 事件名常量 + payload 类型（{entity, id, action}）
└── client.ts           TodouClient：typed fetch 封装，每个端点一个方法；
                        支持 cookie（web）与 Bearer PAT（agent/未来 CLI）
```

### projects/server

```
src/
├── index.ts            clipanion 入口：ServeCommand、MigrateCommand
├── config.ts           smol-toml + ENV(TODOU_*) + zod → Config
├── app.ts              组装 Hono app（不 listen，供测试用 app.request()）
├── bootstrap.ts        启动流程：驱动选择、（pglite 默认）自动迁移、
│                       single 模式 seed 内置 user
├── errors.ts           NotFound/Forbidden/Conflict/Validation 领域错误
│                       + 全局错误映射中间件
├── db/
│   ├── schema.ts       drizzle pg-core 表定义（单一事实来源）
│   ├── index.ts        驱动工厂：pglite:// | postgres:// → Db（统一类型）
│   └── migrations/     drizzle-kit 生成的 SQL（提交进仓库）
├── auth/
│   ├── session.ts      session 创建/校验/销毁（token 存 sha256 hash）
│   ├── pat.ts          PAT 生成（todou_pat_ + 32B 随机）、sha256 校验
│   └── middleware.ts   Bearer → PAT；Cookie → session；写 c.var.currentUser
├── services/           领域逻辑（事务边界、issue_events 写入、bus 发布）
│   ├── users.ts  agents.ts  tokens.ts
│   ├── projects.ts  members.ts  statuses.ts  labels.ts
│   ├── issues.ts  comments.ts  timeline.ts  references.ts
│   └── attachments.ts
├── routes/             Hono 子应用，zod-openapi 定义（镜像 api.md）
├── events/bus.ts       进程内 typed event bus（Map<projectId, Set<subscriber>>）
├── routes/sse.ts       GET /projects/:slug/events（hono streamSSE + 心跳）
└── storage/
    ├── types.ts        StorageBackend：put/getStream/delete/urlFor
    └── fs.ts           分片路径 ab/cd/<uuid>；大小限制来自配置
```

### projects/web

```
src/
├── main.tsx  router.tsx        TanStack Router 实例与路由树
├── api/
│   ├── client.ts               shared TodouClient 实例（同源 /api）
│   ├── queries.ts              每资源的 queryOptions / mutation hooks
│   └── useProjectEvents.ts     SSE → queryClient.invalidateQueries 映射
├── routes/                     login / projects / project(list) / board /
│                               issue / project-settings / agents-settings
├── components/
│   ├── ui/                     shadcn/ui 生成组件
│   ├── issue/                  IssueTable、FilterBar、StatusPill、LabelChip
│   ├── board/                  KanbanBoard、KanbanColumn、KanbanCard（dnd-kit）
│   ├── timeline/               Timeline（react-virtual 变高虚拟化）、
│   │                           CommentItem、EventRow、CommentComposer
│   └── shared/                 UserChip（agent 徽章）、MarkdownView
└── styles.css                  Tailwind v4 入口（@import "tailwindcss"）
```

## 3. 第三方库

| 库 | 用途 | 备注 |
| --- | --- | --- |
| hono + @hono/node-server | HTTP 框架 / Node 适配 | |
| @hono/zod-openapi | zod 路由定义 → /api/openapi.json | 与 zod v4 兼容版本 |
| zod | schema/校验（shared 共用） | |
| drizzle-orm | ORM（pg-core 单方言） | drizzle-kit 仅 dev 生成迁移 |
| @electric-sql/pglite | 内嵌 Postgres（pglite://） | drizzle-orm/pglite 驱动 |
| pg (node-postgres) | postgres:// 驱动 | 同一 schema，轻度验证 |
| smol-toml | TOML 解析 | |
| @tanstack/react-router / react-query / react-virtual | 路由 / 数据 / 虚拟化 | |
| @dnd-kit/core + sortable | kanban 拖拽 | |
| react-markdown + remark-gfm | 评论/正文渲染 | |
| tailwindcss v4 + @tailwindcss/vite + shadcn/ui | UI 体系 | shadcn 以生成源码方式进仓库 |
| lucide-react、sonner | 图标、toast | shadcn 生态默认 |
| vitest + @testing-library/react + happy-dom | 测试 | |

**不引入**：密码哈希库（PAT/session token 都是高熵随机值，`node:crypto`
sha256 即可，无需慢哈希）；uuid 库（`crypto.randomUUID()`）。

## 4. 关键机制

### 身份与凭证

- **PAT**：格式 `todou_pat_<base64url 32B>`；DB 存 `sha256(token)`；
  `prefix` 存前 12 字符供列表展示。校验顺序：Bearer 头 → hash 查表 →
  检查 revoked/expired → 更新 last_used_at（节流：每分钟至多一次）。
- **Session**：`todou_session` httpOnly SameSite=Lax cookie；值为高熵随机，
  DB 同样存 hash；TTL 30 天滑动续期。
- **single 模式登录**：`POST /auth/login` 无 body 时且 `auth.mode=single`
  → 为内置 `user` 建 session。其他 mode 留 400/未实现（后续切片补）。

### Issue 编号与事件

- 编号：`UPDATE projects SET next_issue_number = next_issue_number + 1
  WHERE id = $1 RETURNING next_issue_number` 与 insert 同事务。
- `issue_events` 由 service 在业务写入的**同一事务**内落库；事务提交后
  才向 bus 发布 SSE 指针事件（避免客户端 refetch 读不到）。
- `#N` 引用：保存 issue body / comment 时以 `/(^|\W)#(\d+)\b/` 提取，
  同 project 内解析为 issue，去重后在被引用 issue 上写 `referenced` 事件
  （引用自身除外；同一来源对同一目标只记一次）。

### Timeline 双向分页

- 归并读取 comments ∪ issue_events，keyset cursor =
  `(created_at, kind, id)` 编码为不透明 base64。
- 参数：`before` / `after` + `limit`（默认 50）；`?last=1` 取最新一页
  （聊天式初始定位）。响应含 `prev_cursor` / `next_cursor`。

### SSE

- 事件体只有指针：`{entity: "issue"|"comment"|"timeline"|"label"|…,
  id, action: "created"|"updated"|"deleted", issue_number?}`。
- `hono/streaming` streamSSE；30s 心跳注释行防代理断流；连接时校验
  project member；断线由浏览器 EventSource 自动重连，web 侧重连后
  invalidate 该 project 全部查询（补偿）。
- bus 为进程内 Map；多实例部署换 `pg NOTIFY` 属后续切片（接口已隔离）。

### 驱动工厂与迁移

- `database.url` scheme 分发：`pglite://path` → drizzle-orm/pglite；
  `postgres://…` → drizzle-orm/node-postgres。对外统一为 `Db` 类型别名。
- 迁移：drizzle-kit 生成 SQL 进仓库；`migrate` 子命令按驱动选择对应
  migrator。auto_migrate 默认：pglite=true、postgres=false。
- 测试用 `pglite://memory`（内存实例）每 suite 起新库跑迁移。

### Web 数据流

- 所有请求经 shared `TodouClient`（同源 `/api`，vite dev proxy → :3000）。
- 查询键约定：`['projects']`、`['project', slug]`、
  `['issues', slug, filters]`、`['timeline', slug, number]`、
  `['agents']`…；SSE 指针事件按约定映射 invalidate。
- 乐观更新：kanban 移动与发评论；失败回滚 + sonner toast。
- Timeline：双向 `useInfiniteQuery` + react-virtual 动态测高；
  底部跟随策略：距底 < 1 屏时新项自动滚动，否则显示「↓ 新消息」浮标。

## 5. 错误处理与日志

- 领域错误类 → 全局中间件映射：NotFound→404、Forbidden→403、
  Conflict→409、Validation→422、未认证→401；未知→500 + 结构化日志。
- 响应统一 `{ error: { code, message, details? } }`；zod 校验失败自动
  422 并附字段级 details。
- hono logger 中间件输出请求日志；SIGINT/SIGTERM 优雅关闭
  （停接新连接 → 断 SSE → 关闭 PGlite/pg pool）。

## 6. 测试策略

- **server 集成**：真 PGlite（内存）+ 迁移，`app.request()` 进程内打
  HTTP；覆盖鉴权矩阵（PAT 有效/吊销/过期/格式错、single 登录、role
  403）、issue 编号并发、`#N` 引用、timeline 归并与双向 cursor、
  status 删除保护、附件上传下载权限。
- **shared 单测**：schema 解析/拒绝、client 请求形状（mock fetch）。
- **web 组件**：Timeline 归并渲染与跟随策略、Kanban 乐观更新/回滚、
  SSE→invalidate hook（mock EventSource）。
- E2E 后续切片。
