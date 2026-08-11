# Proposal: todou server + web core

用户原始需求与问答实录。Date: 2026-08-11

## 原始需求（逐字记录）

> create git repo and commit initial commit (layout) first. then start
> /brainstorm ing.
> don't use prettier, add latest typescript, and maybe biome. use erasable
> syntax only. do not build. use mono repo layout - pnpm workspace,
> projects/\*. a server of backend, and React, shadcn frontend, vite. vitest
> for testing.
> also we have to do a client CLI (with clipanion for args parsing, same for
> server entry) for agent consume.
>
> the project should have users (OpenID login, or in local mode - bypass and
> always use a `user` user). server should have support for S3 attachment or
> local FS attachment. Sqlite (generally use for local mode) or Postgresql
> (production - multi use, but not limited to). toml and ENV configuration
> for both server and client CLI (preserves user token for CLI). in the
> system can have `project`s. a project means a todo board, and behaves like
> a issue tracker - just what GitHub issues like. issues can have comments,
> labels, status. A list view, kanban view. live update (maybe
> tanstack/query, as well). virtual comments rendering (if have a lot of
> comments - which may looks like a ... agent/chat transcript) the project
> can add agents (machine users), which can be added to project, and behave
> like a user to comment and do actions.

背景：项目名 todou = ToDo + u，读作「土豆」（见 docs/codename.md）。

## 问答实录

### Q1 首个切片

**问**：第一份 spec（也就是第一个实现循环）应该覆盖哪个切片？后续切片会各自有自己的 spec。

- **本地核心 + CLI（推荐）**：server 核心（local 模式、SQLite、FS 附件、TOML+ENV 配置）+ REST API + CLI 基本命令。最快让你和 agent 用起来（dogfooding），Web/OIDC/PG/S3/agent 徽章等后续切片再做。
- **本地核心 + Web 最小版**：server 核心 + 最小 Web（list view + issue 页），CLI 放到第二个切片。适合你想先看到界面的情况。
- **Agent 优先**：server 核心 + machine user/PAT + CLI（含 --json），完全面向 agent 消费，Web 整体后置。
- **整个产品一份 spec**：不拆分，一份大 spec 覆盖全部功能再统一实现。风险：spec 巨大、实现周期长、返工代价高。

**答**：整个 server + web。CLI后续再进行

### Q2 Server 边界

**问**：第一份 spec 里的 server，生产级能力（OIDC 登录、PostgreSQL、S3 附件）要包含到什么程度？

- **全部实现**：OIDC + local 两种模式、SQLite + PostgreSQL 双方言、FS + S3 双后端，全部在第一个实现循环内完成。
- **抽象到位，先实现 local 一侧（推荐）**：认认真真把 auth / db / storage 三层抽象接口定好，但第一循环只实现 local + SQLite + FS；OIDC/PG/S3 作为后续切片插入现成接口，不动核心代码。
- **双 DB 优先，认证存储后置**：SQLite + PostgreSQL 两种方言第一循环就支持（早验证双方言可行性），OIDC 和 S3 后置。

**答**：先做local/sqlite/fs。local这个要注意，只是网页自动登陆到user，agent身份、CLI鉴权这种不影响，还是走正常path（绝不是CLI也强制user）。

### Q3 Web 范围

**问**：Web 前端在第一个实现循环里要做到什么程度？（原始需求里提到：list view、kanban view、实时更新、长评论虚拟渲染）

- **全部四样都要**：list + kanban + 实时更新（SSE/WS + TanStack Query）+ 评论虚拟渲染，一次到位。spec 和实现量最大。
- **list + issue 页先行，kanban/实时第二波**：第一循环：list view + issue 详情（含评论、虚拟渲染）；kanban 和实时更新作为紧随其后的小切片。
- **能用就行的最小版**：list view + issue 详情（普通渲染，不做虚拟化），其余全部后置。最快上线，但距离完整产品最远。

**答**：全部四样都要

### Q4 Status 模型

**问**：Issue 的 status 怎么建模？（kanban 的列就是 status，所以这也决定了看板结构）

- **每个 project 可配置（推荐）**：每个 project 有自己的有序 status 集（默认 Todo / In Progress / Done），每个 status 标注 open|closed 类别，方便"open issues"过滤。类似 GitHub Projects 的自定义列。
- **固定 open/closed + 独立 kanban 列**：Issue 只有 open/closed（纯 GitHub Issues 风格），kanban 列是另一个独立字段。模型更接近 GitHub，但两套状态容易让人困惑。
- **全局固定三列**：所有 project 统一 Todo / In Progress / Done，不可配置。最简单，但灵活性差。

**答**：每个 project 可配置（推荐）

### Q5 Agent 范围

**问**：第一循环（server + web，无 CLI）里，agent / machine user 要做到什么程度？

- **数据模型 + API + 管理 UI（推荐）**：machine user 建模、PAT 签发/吊销 API，加上 web 里的管理页（创建 agent、发 token、加入 project、徽章展示）。agent 用 PAT 调 REST API 即可干活，不等 CLI。
- **模型 + API，UI 后置**：数据层和 REST 鉴权完整支持 machine user + PAT，但管理操作暂时靠 server 管理命令（todou-server agent create），web 只展示徽章。
- **只留模型占位**：user 表里有 kind=machine 字段和 token 表，但签发/管理全部留到 agent 专属切片。第一循环 agent 完全不可用。

**答**：数据模型 + API + 管理 UI（推荐）

### Q6 技术栈

**问**：选哪套技术栈？（选完我就按这套写设计稿，单项想换可以在 Other 里说）

- **方案 A（推荐）**：Hono + zod + Drizzle/SQLite + SSE + TanStack Router/Query + dnd-kit + react-virtual + projects/shared 共享包。纯 TS、零 codegen，和零构建约束最契合。
- **方案 B**：Fastify + Kysely + WebSocket + React Router v7。更保守成熟，但胶水代码多、类型体验弱一些。
- **方案 C**：Hono + tRPC 双 API 表面。web 类型体验最好，但要为 agent 另维护 REST，不推荐。

**答**：方案A。你刚说的pglite不错

### Q7 DB 方言

**问**：PGlite 怎么用？它可以彻底替掉 SQLite：本地模式跑内嵌 PGlite（文件持久化、零安装），生产跑真 Postgres——两边同一个 PG 方言，Drizzle 只需一份 pg-core schema，双 schema 维护成本直接消失。代价：PGlite 是 WASM 单连接（单进程内使用，本地单用户场景没问题）。

- **PGlite 替掉 SQLite（推荐）**：本地 = PGlite，生产 = PostgreSQL，全线 PG 方言、一份 schema、一套迁移。不再支持 SQLite。
- **SQLite 主、PGlite 备选**：维持原计划 SQLite 为本地默认，PGlite 只作为可选驱动。需要维护双方言 schema。
- **三个都支持**：SQLite + PGlite + PostgreSQL 全支持。灵活性最高但维护成本最大，不推荐。

**答**：PGlite 替掉 SQLite（推荐）
（注：此决定修订了原始需求中的 "Sqlite (generally use for local mode)"。）

## 设计稿分节评审记录

- **第 1 节（架构总览与 monorepo）**：OK，继续下一节
- **第 2 节（数据模型）**：machine user should belong to a human user；除了comments还要有github那种，action -> issue opened, closed, referenced by, 这种什么的
  - 修订（owner_id + issue_events 类型枚举）后：OK，继续下一节
- **第 3 节（认证与 API）**：「local 模式下浏览器请求自动视为内置 user」改为——就搞一个local登陆的接口，可以换内置user的session。这样对于任何模式来说，都是登陆，只是local模式可以什么输入都不要就直接登陆成功
- **第 4 节（实时 + Web）**：OK，继续最后一节
- **第 5 节（配置、存储、错误处理、测试）**：不要顶层mode，不如搞个[auth] mode="single"，意义更明确。真实用户就 mode="oidc"，甚至还可以支持那种forward auth (header) mode="forward"
  - 修订（[auth] mode = single/oidc/forward，DB/存储/认证三点正交，自动迁移改挂 DB 驱动）后：OK，写文档吧

## Redline 评审批注（2026-08-11，design.md）

> 总的来说我有个新的想法：
> 就是有个系统数据库，然后，
> 任何和project相关的信息，分数据库：
> pqlite可以公用系统数据库，也可以每个project一个单独的pqlite，这样天生横向分表了。
> 然后pgsql也可以作系统数据库，然后proejct也可以公用同一个pgsql（同系统数据库），或者per project id进不同的服务器。
>
> 我感觉这个对架构变化比较大，要提前规划。
> 多开pqlite的情况下，看看能否开worker thread，然后ipc来实现充分利用多核心

含义（已并入设计）：数据库架构改为**系统库 + 项目库**两层。系统库存
全局数据（用户、会话、token、项目注册表、成员）；每个 project 的业务
数据（issues、comments、事件、statuses、labels、附件元数据）按配置放置：
`shared`（与系统库同库）或 `dedicated`（每 project 独立 PGlite 文件，
或按 project id 路由到不同 PostgreSQL 服务器）。多开 PGlite 时研究用
worker threads + IPC 利用多核（实验性，feature flag，不阻塞主线）。
