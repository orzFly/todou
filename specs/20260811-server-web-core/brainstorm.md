# todou — Server + Web Core（切片 1 设计稿）

Status: **approved in dialogue, pending redline** · Date: 2026-08-11

todou 是一个可自托管的 todo 系统：一个 `project` 就是一块 GitHub-Issues
风格的看板，人类和 AI agent（machine user）从第一天起就在同一块板上协作。

本 spec 覆盖**切片 1：完整 server + Web 前端**。CLI、OIDC/forward
认证、真 Postgres 生产化、S3 后端属于后续切片（见 §9 路线图）。

## 1. 架构总览与 monorepo

```
projects/
├── shared/    ★新增  zod schemas（实体+DTO）、TS 类型、typed API client、事件常量
├── server/          Hono REST + SSE · Drizzle(pg-core) · 存储抽象 · clipanion 入口
├── web/             React 19 + Vite · TanStack Router/Query · shadcn/ui (Tailwind v4)
└── cli/             本切片不动（占位保留），下一切片基于 shared 的 client 实现
```

技术栈（已确认）：Hono + zod + Drizzle（pg-core）+ SSE + TanStack
Router/Query + dnd-kit + @tanstack/react-virtual + react-markdown +
shadcn/ui + Tailwind v4。纯 TS、零 codegen。

**Server 分层**：`routes`（Hono 路由 + zod 校验）→ `services`（领域逻辑，
含事件写入与 bus 发布）→ `db`（Drizzle repo）。横切：`auth` 中间件、
`storage` 接口、进程内 `events` 总线 → SSE 端点。

**三个可插拔点，完全正交，各由配置独立决定**：

| 插拔点 | 本切片实现 | 后续切片 |
| --- | --- | --- |
| DB（两层：系统库 + 项目库，驱动由 URL scheme 决定：`pglite://` / `postgres://`） | 系统库 + 项目库 `shared`/`dedicated` 两种放置；PGlite 与 postgres 驱动 | 生产 PG 硬化、PGlite worker threads 转正、按 project 路由管理 UI |
| 认证（`auth.mode`） | `single`（零输入登录为内置 `user`） | `oidc`、`forward` |
| 存储（`storage.backend`） | `fs` | `s3`（presigned URL） |

**两层数据库架构**（redline 评审补充的需求）：**系统库**存全局数据
（users、sessions、tokens、项目注册表、members）；**项目库**存单个
project 的业务数据（issues、comments、events、statuses、labels、附件
元数据）。放置策略由配置决定——`shared`：项目数据与系统库同库（按
project_id 区分）；`dedicated`：按 `url_template` 路由——值是启动时
`Function()` 编译的 JS 模板字面量，`${}` 内可写任意逻辑：一 project
一库（PGlite 一文件，天生横向分表）、按 id 区间/自定义规则路由到不同
PostgreSQL 服务器等都由用户表达（项目库表恒带 project_id，多 project
共用一个目标库天然安全）。服务层通过 `DbRouter`
（`system()` / `forProject(id)`）访问，
对放置策略透明。多开 PGlite 时以 worker threads + IPC 利用多核为实验
特性（feature flag，默认关）。

**零构建约束**：`@todou/shared` 的 `exports` 直接指向 `.ts` 源码；pnpm
workspace 符号链接解析到 `node_modules` 之外的真实路径，Node 24 type
stripping 与 Vite 均可直接消费，无构建步骤。全仓 `erasableSyntaxOnly`。

## 2. 数据模型（Drizzle pg-core，系统/项目两套 schema）

**系统库 schema**：

```
users            id · kind(human|machine) · login(唯一) · display_name · email?
                 · owner_id? → users（kind=machine 必填，指向所属 human）
                 · oidc_subject?（oidc 模式用，本切片留空）
                 · is_instance_admin(bool) · created_at
sessions         id · user_id → users · expires_at        （web cookie 会话）
tokens (PAT)     id · user_id → users · name · token_hash · prefix(展示用)
                 · expires_at? · revoked_at? · last_used_at?
projects         id · slug(唯一) · name · description
                 · database_url?（按 project 路由的覆盖项，空 = 按配置放置）
project_members  project_id ⨯ user_id（唯一）· role(admin|writer|reader)
```

**项目库 schema**（shared 放置时这些表与系统库同库；dedicated 时每
project 一库。所有表保留 project_id 列，使同一套 schema/查询在两种
放置下通用）：

```
project_meta     project_id(唯一) · next_issue_number · schema_version
statuses         id · project_id · name · category(open|closed) · position · color
labels           id · project_id · name · color   （project 内名字唯一）
issues           id · project_id · number(project 内唯一) · title · body(md)
                 · status_id · author_id · created_at · updated_at
issue_assignees  issue_id ⨯ user_id
issue_labels     issue_id ⨯ label_id
comments         id · issue_id · author_id · body(md) · created_at · edited_at?
issue_events     id · issue_id · actor_id · type · payload(jsonb) · created_at
attachments      id · issue_id · uploader_id · filename · content_type · size
                 · storage_key · created_at
```

**跨库引用规则**：项目库中对 user 的引用（author_id、actor_id、
uploader_id、assignee 的 user_id）是**逻辑 ID，不建外键**（dedicated
放置下物理上不可能）；service 层从系统库批量取用户摘要做 enrich（带
短 TTL 缓存）。项目库内部（status_id、label_id 等）保留真外键。issue
编号计数器放在项目库 `project_meta`，保证 issue 创建在单库事务内完成。

- **agent 就是 `users.kind = machine`**，成员/指派/评论复用同一套外键；
  UI 依据 kind 渲染徽章。每个 machine user **必须归属一个 human
  owner**（`owner_id`）；agent 的创建、PAT 签发、改名、停用等管理权归
  owner 与 instance admin。删除 human 前需先处理其名下 agent。
- 单用户模式的内置 `user` 是首次启动 seed 的一行普通 human 用户。
- **PAT 只存 hash**，明文仅签发瞬间返回一次；`prefix` 用于列表识别。
- **Issue 编号**：`projects.next_issue_number` 事务内自增；对外 API 用
  `slug + number` 定位，内部用 id。
- **新建 project 自动 seed**：Todo(open) / In Progress(open) /
  Done(closed)；status 可增删改排序，被 issue 引用的 status 删除前必须迁移。
- 主键 `bigint identity`，时间戳 `timestamptz`。

### issue_events 类型枚举（GitHub 风格 action 行）

| type | 触发 | payload |
| --- | --- | --- |
| `opened` | issue 创建（timeline 首条） | — |
| `closed` | status 切到 closed 类别 | `{from, to}` |
| `reopened` | closed 类别切回 open 类别 | `{from, to}` |
| `status_changed` | 同类别内列间移动 | `{from, to}` |
| `title_changed` | 改标题 | `{from, to}` |
| `label_added` / `label_removed` | 标签变更 | `{label}` |
| `assigned` / `unassigned` | 指派变更 | `{user}` |
| `referenced` | 被其他 issue/comment 以 `#N` 提到（同 project） | `{by_issue, by_comment?}` |
| `attachment_added` | 附件上传 | `{attachment}` |

事件由 service 层在对应动作的**同一事务**内写入。`referenced` 在保存
issue body / comment 时解析 markdown 中的 `#N`，事件落在**被引用**的
issue 时间线上。**Timeline = comments ⨯ issue_events 按时间归并**。

## 3. 认证与 API

**请求身份解析**（与 auth.mode 正交的两条路径）：

1. `Authorization: Bearer todou_pat_…` → 查 hash → user（human 或
   machine）。**无效 PAT 一律 401，绝不降级**——single 模式下同样真实。
2. Cookie session → sessions 表 → human user。
3. 都没有 → 401；web 端跳转登录路由。

**登录永远是显式的**（无隐式身份降级），mode 只决定登录这步要什么凭证：

```
POST /api/auth/login    single: 零输入，直接为内置 user 建 session
                        oidc / forward: 后续切片
POST /api/auth/logout   销毁 session（各模式一致）
```

single 模式下 web 登录页自动调 `/auth/login` 秒过，用户无感知。

**授权**：project 级 `admin / writer / reader`；agent 在 project 内的
权限即其 member role，与 owner 权限无关。任何 human 可建 project；
agent 管理权在 owner + instance admin。

**REST 资源**（`/api` 前缀，zod schema 在 `@todou/shared`）：

```
GET    /me                            当前身份（human/machine 通用）
POST   /me/tokens                     给自己签 PAT（为 CLI 切片铺路）
POST   /agents                        创建 agent（owner = 当前用户）
GET    /agents?owner=me               管理列表
POST   /agents/:id/tokens             签发 PAT · DELETE /tokens/:id 吊销
CRUD   /projects · /projects/:slug/{members,statuses,labels}
GET    /projects/:slug/issues         过滤: status/label/assignee/category/q
                                      （q = title/body ILIKE）cursor 分页 + 排序
POST   /projects/:slug/issues
GET/PATCH /projects/:slug/issues/:number   标题/正文/status/指派/标签
GET    /projects/:slug/issues/:number/timeline   评论⨯事件归并流
                                      双向 cursor（before/after，支持跳到最新）
POST   /projects/:slug/issues/:number/comments
POST   /projects/:slug/attachments    multipart → {id, url}
GET    /attachments/:id/download      fs: 鉴权后流式返回（s3 将 302 presigned）
GET    /projects/:slug/events         SSE 事件流（project member 鉴权）
```

**错误约定**：统一 `{ error: { code, message, details? } }`；service 层
类型化领域错误（NotFound / Forbidden / Conflict / Validation）由全局
中间件映射状态码；zod 失败自动 422 + 字段级 details；未知异常 500 +
结构化日志。

**OpenAPI**：路由由 zod 定义生成 `/api/openapi.json`，服务后续 CLI 与
agent 消费。

## 4. 实时更新与 Web 应用

**SSE 管道**：service 写事务完成后向进程内 event bus 发布
`{project, entity, id, action}`（`issue.updated`、`comment.created`、
`timeline.appended` 等）；SSE 端点按 project 过滤 + 鉴权后转发。
**事件只带指针不带数据**——客户端按映射失效 TanStack Query 缓存重取，
避免推送体积与权限泄漏，断线重连的补偿就是全量 refetch。单进程内存
bus 足够（PGlite 本就单进程）；未来多实例部署换 `pg NOTIFY`，接口不变。

**路由**（TanStack Router；过滤器状态在 search params，链接可分享）：

```
/login
/projects                       项目列表
/projects/:slug                 list view（默认）?status=&label=&assignee=&q=
/projects/:slug/board           kanban view
/projects/:slug/issues/:number  issue 详情 + timeline
/projects/:slug/settings        成员 / status / label 管理
/settings/agents                agent 管理（创建、签 token、归属展示）
```

**关键交互**：

- **List**：shadcn Table + 过滤工具栏；行内快速改 status/label。
- **Kanban**：列 = status（按 position），dnd-kit 拖拽；落下即 PATCH，
  乐观更新 + 失败回滚 toast。
- **Issue timeline**：react-virtual 变高虚拟列表 + 双向 infinite query
  （对接 before/after cursor）。默认落在最新一页（聊天式），向上滚动
  加载历史；SSE 新事件到达时在底部则自动跟随，否则显示「↓ 有新消息」
  浮标。评论 react-markdown + GFM；事件行 GitHub 风格灰字。
- **发评论**：乐观插入尾部，失败标记重试。
- **agent 徽章**：头像角标 + `agent · belongs to @owner` tooltip，
  全站统一组件。

shadcn/ui + Tailwind v4 本切片正式接入 web 包（纯 Vite 侧，不影响
server/CLI 零构建）。

## 5. 配置

三层：默认值 → TOML → ENV 覆盖；整体过 zod 校验，schema 放 server 包
（CLI 切片时抽到 shared）。TOML 解析用 `smol-toml`。

```toml
# todou.toml（--config 指定，默认 ./todou.toml；ENV 前缀 TODOU_）
[auth]
mode = "single"              # single | oidc | forward（后两者后续切片）
# [auth.oidc]   issuer / client_id / client_secret / …
# [auth.forward] user_header = "Remote-User"

[http]
port = 8637                  # TODOU_HTTP_PORT（web dev 默认 8636）

[database]
system = "pglite://./data/system"   # TODOU_DATABASE_SYSTEM；postgres:// 亦可
# auto_migrate 默认：pglite=true · postgres=false（系统库/项目库同规则）

[database.projects]
placement = "shared"                # shared | dedicated
# dedicated 时必填。值为 JS 模板字面量，启动时 Function() 编译，
# ${} 内可写任意逻辑（作用域提供 project = {id, slug}）：
# url_template = "pglite://./data/projects/${project.id}"
# url_template = "postgres://${project.id > 100 ? 'pg-b' : 'pg-a'}/todou_${project.id}"
# max_open = 32          # dedicated PGlite 的 LRU 打开上限
# workers = false        # 实验：worker threads 承载 PGlite（多核）

[storage]
backend = "fs"               # fs | s3（后续切片）
path = "./data/attachments"
max_upload_mb = 20
```

## 6. 附件存储

`StorageBackend` 接口：`put / getStream / delete / urlFor`。本切片实现
`fs`：`storage_key = 分片路径/uuid`（如 `ab/cd/<uuid>`）；原始文件名只
存 DB，下载时 sanitize 后放 Content-Disposition；下载需 project member
鉴权；大小上限来自配置。s3 后端（presigned 上传/下载）为后续切片。

## 7. 迁移与运维

- **两套迁移**（系统库 / 项目库各一），drizzle-kit 生成 SQL 进仓库；
  `todou-server migrate` 迁移系统库 + 遍历注册表迁移全部项目库。
- dedicated 项目库在 project 创建时 provision（建库/建文件 + 迁移 +
  seed），打开时校验 `project_meta.schema_version`。
- `pglite://` 默认打开时自动迁移；`postgres://` 必须显式执行
  （`database.auto_migrate` 可覆盖两者默认）。
- server 入口 clipanion：`serve`、`migrate`，后续按需加管理子命令。
- 优雅关闭：断开 SSE、落盘 PGlite。
- 本切片运行方式：`todou-server serve` + `vite dev`（proxy `/api`）。
  web 静态产物构建与托管属于生产化切片。

## 8. 测试（Vitest）

- **server**：对**真 PGlite** 跑集成测试（每 suite 一个内存实例 + 迁移，
  无 mock）；路由用 `app.request()` 进程内打请求，覆盖鉴权矩阵（PAT
  有效/吊销/过期、single 登录、role 403）；`#N` 引用解析、issue 编号
  并发自增、timeline 归并等单测。**核心 service 套件在 shared 与
  dedicated 两种放置下各跑一遍**（参数化 test helper），保证放置透明。
- **shared**：schema parse/serialize 单测。
- **web**：Testing Library + happy-dom；重点：timeline 归并渲染、kanban
  乐观更新/回滚、SSE→invalidate 映射 hooks。
- E2E（Playwright）后续切片。

## 9. 路线图（后续切片，各自独立 spec）

1. **（本切片）server + web core**
2. **CLI**：clipanion 命令集、`--json`、`todou login`（TOML 存 token）、
   基于 shared 的 typed client
3. **生产认证**：`auth.mode = oidc`（openid-client）+ `forward`（反代
   身份头）、真 PG 生产硬化
4. **S3 存储后端**：presigned 上传/下载
5. **Agent 增强**：MCP server（`todou mcp`）、webhook/通知等

## 10. 明确不做（本切片）

OIDC / forward 认证 · S3 · CLI · E2E 测试 · web 静态托管 · 全文搜索
（q 仅 ILIKE）· 通知/邮件 · 多实例横向扩展（SSE bus 单进程）·
PGlite worker threads 转正（本切片仅 spike + feature flag）·
按 project 路由（`projects.database_url`）的管理 UI/API（列保留，
本切片仅 router 读取）
