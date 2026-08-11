# Design: todou server + web core

基于已批准的 [brainstorm.md](brainstorm.md)。本文补充实现级设计：模块划分、
第三方库选型、关键机制。API 明细见 [api.md](api.md)，执行步骤见 [plan.md](plan.md)。

## 1. 约束回顾

- Node 24 直跑 `.ts`（native type stripping），全仓 `erasableSyntaxOnly`，
  **无构建步骤**（web 由 Vite 开发服务器承载，静态托管属后续切片）。
- pnpm workspace：`projects/{shared,server,web,cli}`；cli 本切片不动。
- `@todou/shared` 的 `exports` 指向 `.ts` 源码；pnpm 符号链接解析到
  `node_modules` 外的真实路径，Node 与 Vite 均可直接消费。

## 2. 数据库架构：系统库 + 项目库（redline 评审补充）

### 两层划分

- **系统库**（唯一）：users、sessions、tokens、projects 注册表、
  project_members。鉴权、成员、"我的项目"列表只读系统库。
- **项目库**（每 project 一个逻辑库）：project_meta（issue 编号计数器、
  schema_version）、statuses、labels、issues、issue_assignees、
  issue_labels、comments、issue_events、attachments。

两套 drizzle pg-core schema、两套迁移目录。**项目库所有表保留
project_id 列**，同一套 schema 与查询（恒带 project_id 过滤）在两种
放置下通用——服务层对放置完全透明。

### 放置策略（配置）

```toml
[database]
system = "pglite://./data/system"        # 或 postgres://…

[database.projects]
placement = "shared"                     # shared | dedicated
url_template = "pglite://./data/projects/{id}"   # dedicated 必填
max_open = 32                            # dedicated PGlite LRU 打开上限
workers = false                          # 实验：worker threads 承载 PGlite
```

- `shared`：项目库物理上就是系统库连接（一切同库，按 project_id 区分）。
- `dedicated`：`url_template` 占位符支持 **`{id}`**（一 project 一库）与
  **`{id%N}`**（取模分桶，N 个库分摊全部 project）。项目库表恒带
  project_id 且查询恒过滤，**共桶天然安全**；桶粒度对 service 层不可见。
  PGlite 与 PostgreSQL 同一套模板机制（后者即按 id/桶路由不同库/服务器）。
- **按 project 覆盖**：注册表 `projects.database_url` 非空时优先于
  template（支持"个别大项目单独放一台服务器"）。本切片 router 读取该列，
  管理 API/UI 后置。

### DbRouter

```
db/
├── system-schema.ts     系统库表定义
├── project-schema.ts    项目库表定义
├── driver.ts            url → drizzle 实例（pglite:// | postgres://）
├── router.ts            DbRouter：system() · forProject(projectId)
└── migrations/
    ├── system/          drizzle-kit 生成（配置 A）
    └── project/         drizzle-kit 生成（配置 B）
```

- `forProject(id)`：查放置（注册表覆盖 → 配置模板）→ 解析出**最终
  URL**（`{id}` / `{id%N}` 展开）→ **句柄缓存以 URL 为键**（分桶时多个
  project 命中同一句柄）；dedicated PGlite 按 `max_open` LRU 关闭空闲。
- **provision**（project 创建事务的一部分，见 §4 一致性）：解析目标
  URL → **幂等**确保库存在且迁移到位（分桶时桶库可能已被先前 project
  建好）→ 写 project_meta + seed 三 status。
- `migrate` 子命令：迁移系统库 → 遍历注册表迁移所有项目库。
  `pglite://` 打开时默认自动迁移；`postgres://` 需显式（可配置覆盖）。

### 跨库一致性（明确取舍）

- 项目库对 user 的引用（author/actor/uploader/assignee）是**逻辑 ID，
  无外键**；service 从系统库批量取 `UserRef`（id/login/display_name/
  kind/owner）做 enrich，进程内短 TTL（~30s）缓存。删除 user 前先检查
  其名下 agent 与成员关系（系统库内可保证），项目库中的历史引用保留
  （显示为 ghost 用户）。
- issue 编号计数器在项目库 `project_meta` → 创建 issue 是**单库事务**。
- project 创建跨两库：先写注册表（系统库）→ provision 项目库；provision
  失败则回滚注册表行（补偿删除）。project 删除反向：先移除注册表行
  （不可再路由到）→ dedicated `{id}` 放置删库文件；**分桶/shared 放置
  改为删该 project_id 的行**（桶库被其他 project 共享，不可删库）；
  失败仅遗留孤儿数据，记日志。
- `referenced`（`#N`）只在同 project 内解析——天然单库。
- 跨 project 聚合/全局搜索不在本切片范围（架构上未来可对 dedicated
  做 fan-out 或引入索引服务）。

### PGlite 多核（实验 spike）

PGlite 是 WASM、单连接，查询执行占用所在线程 CPU。dedicated 多库时，
把每个 PGlite 实例放进 worker_thread、主线程经 MessagePort IPC 代理，
可以让多个 project 的查询并行利用多核。

- 设计钩子：`driver.ts` 内部区分 host——`inline`（默认，进程内实例）
  与 `worker`（`workers = true`）。对上层暴露的都是满足
  drizzle-orm/pglite 所需查询接口的对象；worker host 是一个实现
  `query/exec/transaction` 的 IPC 代理。
- **Spike 验收**：代理对象能通过项目库全部集成测试 + 简单多库并发
  benchmark 对比。若 drizzle 驱动依赖 PGlite 内部结构导致代理不可行，
  记录结论，退化方案为 worker 内跑「SQL 文本 + 参数」粗粒度协议。
- 默认关闭，不阻塞其余阶段。

## 3. 模块划分

### projects/shared

```
src/
├── index.ts            汇总导出
├── schemas/            zod v4 schema（同时是类型来源与校验器）
│   ├── common.ts       ID、cursor 分页、错误响应、时间戳
│   ├── user.ts         User/UserRef（kind、owner）、Me
│   ├── token.ts        PAT（签发请求/响应、列表项）
│   ├── project.ts      Project、Member、Status、Label
│   ├── issue.ts        Issue、过滤参数、创建/更新 DTO
│   ├── timeline.ts     Comment、IssueEvent（type 枚举 + payload 判别联合）
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
├── app.ts              组装 Hono app（不 listen，供测试 app.request()）
├── bootstrap.ts        启动：DbRouter 构建、系统库迁移、single seed `user`
├── errors.ts           NotFound/Forbidden/Conflict/Validation + 全局映射
├── db/                 见 §2（two-schema + driver + router + migrations）
├── auth/
│   ├── session.ts      session 创建/校验/销毁（token 存 sha256 hash）
│   ├── pat.ts          PAT 生成（todou_pat_ + 32B 随机）、sha256 校验
│   └── middleware.ts   Bearer → PAT；Cookie → session；写 c.var.currentUser
├── services/           领域逻辑（事务边界、issue_events 写入、bus 发布、
│   │                   系统库 user enrich + TTL 缓存）
│   ├── users.ts  agents.ts  tokens.ts            （系统库）
│   ├── projects.ts  members.ts                   （系统库 + provision）
│   ├── statuses.ts  labels.ts  issues.ts  comments.ts
│   ├── timeline.ts  references.ts  attachments.ts （项目库）
│   └── user-refs.ts    批量 UserRef 查询 + 缓存
├── routes/             Hono 子应用，zod-openapi 定义（镜像 api.md）
├── events/bus.ts       进程内 typed event bus（Map<projectId, Set<sub>>）
├── routes/sse.ts       GET /projects/:slug/events（streamSSE + 心跳）
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

## 4. 第三方库

| 库 | 用途 | 备注 |
| --- | --- | --- |
| hono + @hono/node-server | HTTP 框架 / Node 适配 | |
| @hono/zod-openapi | zod 路由定义 → /api/openapi.json | 与 zod v4 兼容版本 |
| zod | schema/校验（shared 共用） | |
| drizzle-orm | ORM（pg-core，两套 schema） | drizzle-kit 仅 dev，两份配置 |
| @electric-sql/pglite | 内嵌 Postgres（pglite://） | drizzle-orm/pglite 驱动 |
| pg (node-postgres) | postgres:// 驱动 | 同一方言，轻度验证 |
| smol-toml | TOML 解析 | |
| @tanstack/react-router / react-query / react-virtual | 路由 / 数据 / 虚拟化 | |
| @dnd-kit/core + sortable | kanban 拖拽 | |
| react-markdown + remark-gfm | 评论/正文渲染 | |
| tailwindcss v4 + @tailwindcss/vite + shadcn/ui | UI 体系 | shadcn 以生成源码进仓库 |
| lucide-react、sonner | 图标、toast | shadcn 生态默认 |
| vitest + @testing-library/react + happy-dom | 测试 | |
| node:worker_threads | PGlite worker host（spike） | 无第三方依赖 |

**不引入**：密码哈希库（PAT/session token 高熵随机，`node:crypto`
sha256 足够）；uuid 库（`crypto.randomUUID()`）。

## 5. 关键机制

### 身份与凭证

- **PAT**：`todou_pat_<base64url 32B>`；DB 存 `sha256(token)`；`prefix`
  存前 12 字符供展示。校验：Bearer → hash 查表 → revoked/expired →
  last_used_at 节流更新（每分钟至多一次）。
- **Session**：`todou_session` httpOnly SameSite=Lax cookie；高熵随机、
  DB 存 hash；TTL 30 天滑动续期。
- **single 模式登录**：`POST /auth/login` 且 `auth.mode=single` → 为
  内置 `user` 建 session；其他 mode 返回 400（后续切片实现）。

### Issue 编号与事件

- 编号：项目库 `UPDATE project_meta SET next_issue_number =
  next_issue_number + 1 … RETURNING` 与 insert 同事务（单库）。
- `issue_events` 与业务写入同事务落库；**事务提交后**才向 bus 发布
  SSE 指针事件。
- `#N` 引用：保存 body/comment 时 `/(^|\W)#(\d+)\b/` 提取，同 project
  解析，去重、排除自引用，写 `referenced` 事件。

### Timeline 双向分页

- comments ∪ issue_events 归并，keyset cursor `(created_at, kind, id)`
  → 不透明 base64。参数 `before`/`after` + `limit`（默认 50）、`last=1`
  取最新页。响应含 `prev_cursor`/`next_cursor`。items 的 author/actor
  为系统库 enrich 的 UserRef。

### SSE

- 事件只带指针：`{entity, id, action, issue_number?}`。
- streamSSE + 30s 心跳；连接时校验 member；EventSource 自动重连，web
  重连后 invalidate 该 project 全部查询（补偿）。
- bus 进程内 Map；多实例部署换 `pg NOTIFY` 属后续切片（接口已隔离）。

### Web 数据流

- 请求经 shared `TodouClient`（同源 `/api`，vite dev proxy → :3000）。
- 查询键：`['projects']`、`['project', slug]`、`['issues', slug,
  filters]`、`['timeline', slug, number]`、`['agents']`…；SSE 指针
  事件按约定映射 invalidate。
- 乐观更新：kanban 移动、发评论；失败回滚 + sonner toast。
- Timeline：双向 `useInfiniteQuery` + react-virtual 动态测高；距底
  < 1 屏新项自动跟随，否则「↓ 新消息」浮标。

## 6. 错误处理与日志

- 领域错误 → 全局映射：NotFound→404、Forbidden→403、Conflict→409、
  Validation→422、未认证→401；未知→500 + 结构化日志。
- 响应统一 `{ error: { code, message, details? } }`；zod 失败自动 422。
- hono logger；SIGINT/SIGTERM 优雅关闭（停接新连接 → 断 SSE → 关闭
  全部 PGlite 句柄 / pg pool）。

## 7. 测试策略

- **server 集成**：真 PGlite（内存）+ 两套迁移，`app.request()` 进程内
  打 HTTP。**核心 service/route 套件参数化，在 shared 与 dedicated 两种
  放置下各跑一遍**。覆盖：鉴权矩阵、issue 编号并发、`#N` 引用、timeline
  归并与双向 cursor、status 删除保护、附件权限、project
  provision/删除补偿、user enrich（含 ghost 用户）。
- **shared 单测**：schema 解析/拒绝、client 请求形状（mock fetch）。
- **web 组件**：Timeline 归并渲染与跟随、Kanban 乐观更新/回滚、
  SSE→invalidate hook（mock EventSource）。
- **spike**：worker host 通过项目库集成测试 + 多库并发 benchmark。
- E2E 后续切片。
