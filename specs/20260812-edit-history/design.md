# Edit history with diffs — 系统设计

> 设计稿见 [brainstorm.md](./brainstorm.md)；本文件落到模块与代码层面。
> 契约细节见 [api.md](./api.md)。

## 1. 总览

```
server
 ├─ db/project-schema.ts      revisions 表（新）+ issues.body_edited_at（迁移 0002）
 ├─ services/revisions.ts     记录 / 级联删除 / 列表配对（新模块）
 ├─ services/issues.ts        updateIssue：body 真变更 → 落 revision + body_edited_at
 ├─ services/comments.ts      updateComment：no-op 守卫 + 事务化 + 落 revision
 │                            deleteComment：级联删 revisions
 └─ routes/issues.ts          两条 GET revisions 路由（reader）
        │
        ▼
shared
 ├─ schemas/revision.ts       Revision / RevisionPage / RevisionQuery（新）
 ├─ schemas/issue.ts          Issue + body_edited_at
 └─ client.ts                 getIssueRevisions / getCommentRevisions（新方法）
        │
        ▼
web
 ├─ components/ui/popover.tsx           shadcn 式 Popover 包装（radix-ui 已有，无新依赖）
 ├─ components/shared/revision-history.tsx  "(edited)" 触发 → 修订列表 popover → diff 对话框
 ├─ components/timeline/comment-item.tsx    接入 history + 行内编辑（铅笔）
 └─ pages/issue-detail.tsx    BodyBlock 接入 history；透传 viewer 权限
        │
cli
 ├─ commands/comment.ts       CommentEditCommand（新）
 └─ commands/issue.ts         title_changed 渲染 + (edited) 标记
```

新第三方依赖：仅 web 加 `@pierre/diffs`（peer 依赖 react/react-dom，
React 19 兼容）。timeline 查询、游标、SSE 均不动。

## 2. server

### 2.1 schema 与迁移（`db/project-schema.ts`）

```ts
export const revisions = pgTable(
  "revisions",
  {
    id: id(),
    projectId: projectId(),
    // 多态 subject：TS 层 enum、库里存 text——将来加 'spec_file' 只改代码
    subjectType: text("subject_type", {
      enum: ["issue_body", "comment"],
    }).notNull(),
    subjectId: bigint("subject_id", { mode: "number" }).notNull(),
    // 被替换掉的旧内容（编辑前快照）
    body: text("body").notNull(),
    // 执行这次编辑的人（把旧内容替换掉的 actor）
    actorId: bigint("actor_id", { mode: "number" }).notNull(),
    agentContext: jsonb("agent_context").$type<AgentContext | null>(),
    createdAt: createdAt(),
  },
  (t) => [
    index("revisions_subject_idx").on(
      t.projectId,
      t.subjectType,
      t.subjectId,
      t.id,
    ),
  ],
);
```

`issues` 加 `bodyEditedAt: timestamp("body_edited_at", { withTimezone:
true })`（nullable）。多态所致无外键；清理走 service 层（见 2.3）。

迁移：`drizzle-kit generate --config drizzle.project.config.ts` →
`drizzle/project/0002_*.sql`（一张新表 + 一列）。PGlite/auto_migrate 环境
启动时自动应用。

### 2.2 `services/revisions.ts`（新）

```ts
type SubjectType = "issue_body" | "comment";

// 事务内插入一条快照（调用方已判定内容真的变化）
recordRevision(tx, {
  projectId, subjectType, subjectId,
  body,          // 编辑前的旧内容
  actorId, agentContext,
}): Promise<void>

// 事务内级联清理（deleteComment 用；将来 spec_file 同样适用）
deleteRevisionsFor(tx, subjectType, subjectId): Promise<void>

// 读取 + 配对：newest-first 取 limit 行；
// body_before = rows[i].body
// body_after  = i === 0 ? currentBody : rows[i-1].body
// actor 经 getUserRefs 解析，缺失回落 ghost（沿用现有惯例）
listRevisions(ctx, db, {
  projectId, subjectType, subjectId, currentBody, limit,
}): Promise<Revision[]>

// 面向路由的两个入口（内部 requireProject(..., "reader")）：
listIssueRevisions(ctx, actor, slug, number, query): Promise<RevisionPage>
listCommentRevisions(ctx, actor, slug, number, commentId, query): Promise<RevisionPage>
```

`listCommentRevisions` 先按 issue number 载入 issue、再校验 comment 属于
该 issue（404 否则），与现有 `loadCommentForWrite` 的查询方式一致但只需
reader 角色。

截断语义：`limit` 只丢更老的整条修订，窗口内每条的 before/after 都齐备
（第 i 条的 after 来自第 i-1 条，全在窗口内）。

### 2.3 写路径变更

- `services/issues.ts` `updateIssue`：事务内，当 `input.body !==
  undefined && input.body !== before.body` 时——`recordRevision(tx,
  { subjectType: "issue_body", subjectId: before.id, body: before.body,
  … })`，且 `patch.bodyEditedAt = new Date()`。不发任何 timeline 事件
  （用户明确不要）。`title_changed` 等现有事件逻辑不动。
- `services/comments.ts` `updateComment`：加 no-op 守卫——`input.body ===
  row.body` 时直接返回现有行（200），不落 revision、不 bump
  `edited_at`、不发 SSE、不 recordReferences（修正现状：no-op 也会盖
  `edited_at`）。真变更路径改为事务：update body+editedAt、
  recordRevision（body=旧值）、recordReferences 同事务，之后照旧
  publish。
- `services/comments.ts` `deleteComment`：改为事务，删 comment 行 +
  `deleteRevisionsFor(tx, "comment", id)`。
- `toIssue` / Issue DTO 带出 `body_edited_at`。

### 2.4 路由（`routes/issues.ts`）

```
GET /{slug}/issues/{number}/revisions                    (reader)
GET /{slug}/issues/{number}/comments/{commentId}/revisions  (reader)
```

`request: { params, query: RevisionQuery }`，响应 `RevisionPage`，
OpenAPI 注册方式与现有路由一致。

## 3. shared

### 3.1 `schemas/revision.ts`（新）

```ts
export const Revision = z.object({
  id: Id,
  actor: UserRef,
  created_at: Timestamp,
  body_before: z.string(),
  body_after: z.string(),
  agent_context: AgentContext.nullable(),
});
export const RevisionPage = z.object({ items: z.array(Revision) });
export const RevisionQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
```

`index.ts` re-export。

### 3.2 其余

- `schemas/issue.ts`：`Issue` 加 `body_edited_at: Timestamp.nullable()`
  （与 server 同一提交落地，避免响应校验过渡态）。
- `client.ts`：`getIssueRevisions(slug, number, query?)` 与
  `getCommentRevisions(slug, number, commentId, query?)`，风格照抄
  `getTimeline`（query 拼 searchParams）。

## 4. web

### 4.1 修订历史（GitHub 式）

- `components/ui/popover.tsx`（新）：shadcn 式包装，`import { Popover as
  PopoverPrimitive } from "radix-ui"`，与 `dialog.tsx` 同款写法；
  `radix-ui` 统一包已在依赖里，无新增。
- `components/shared/revision-history.tsx`（新）：

  ```tsx
  <RevisionHistory
    editedAt={string}          // 触发文案 "(edited)" + title=时间
    filename={"description.md" | "comment.md"}
    queryKey={…}               // ["revisions", slug, number] / [..., commentId]
    fetch={() => api.getIssueRevisions(…)}
  />
  ```

  - 触发器：可点击的 "(edited)" 文本（沿用现处的样式，加 hover
    underline）。popover 打开时才发起 useQuery（`enabled: open`，
    `staleTime: 0`——打开即新鲜，无需失效联动）。
  - 列表项：`UserChip`（编辑者）+ `AgentContextBadge` + 相对时间，
    newest-first。
  - 点击列表项 → `Dialog`（现有 ui/dialog）内渲染 diff：

  ```tsx
  import { MultiFileDiff } from "@pierre/diffs/react";
  // 模块级常量，遵循库的 props 稳定性指引
  const DIFF_OPTIONS = {
    theme: { dark: "pierre-dark", light: "pierre-light" },
    diffStyle: "stacked",
  } as const;

  <MultiFileDiff
    oldFile={{ name: filename, contents: rev.body_before }}
    newFile={{ name: filename, contents: rev.body_after }}
    options={DIFF_OPTIONS}
  />
  ```

  `oldFile`/`newFile` 对象用 `useMemo` 按选中修订生成。

- 接入点：
  - `comment-item.tsx`：`(edited)` span 替换为 `RevisionHistory`。
  - `issue-detail.tsx` `BodyBlock`：`issue.body_edited_at` 非空时在头部
    渲染 `RevisionHistory`。

### 4.2 评论编辑（新增能力）

- `comment-item.tsx` 加铅笔按钮，可见条件：`viewer.id ===
  comment.author.id || viewer.isAdmin`（server 端本就强制，UI 只做
  镜像）。`viewer` 由 `issue-detail.tsx` 从 `meQuery` + `membersQuery`
  推出（member.role === "admin"；实现时核对 members 响应确有 role
  字段），经 `Timeline` 透传。
- 编辑态：正文换 `Textarea` + Save/Cancel，照抄 `BodyBlock` 模式，调用
  现有 `api.updateComment`，成功后 invalidate `["timeline", slug,
  number]`。

## 5. cli

- `commands/comment.ts` 加 `CommentEditCommand`：
  - `paths = [["comment", "edit"]]`，位置参数 `<number> <commentId>`，
    `--body` / `--body-file`（复用 `readBody`），`--json`。
  - 调 `client.updateComment`，人类输出 `edited comment <id> on #<n>`。
  - `commands/index.ts` 注册。
- `commands/issue.ts` `renderTimelineItem`：
  - `title_changed` 特判：`renamed "from" → "to"`（payload.from/to 均为
    string），不再走通用 `k=v` dump。
  - comment 行：`item.edited_at` 非空时 `commented` 后缀 ` (edited)`。

## 6. 测试设计

| 层 | 覆盖 |
| --- | --- |
| server revisions | 编辑 body/comment 各两次 → GET 配对正确（含最新条 after=当前值）；no-op 保存 → 200、无 revision、edited_at/body_edited_at 不变、无 SSE；limit 截断后窗口内配对完整；删 comment → revisions 级联清空；reader 可读、writer 非作者非 admin 改 comment 仍 403（现有行为回归）；comment 不属于该 issue → 404；actor 已删 → ghost |
| server issues | body 变更设置 body_edited_at 且 DTO 带出；title-only 编辑不落 revision |
| web | RevisionHistory 的纯逻辑（触发条件、列表项标签/相对时间）单测，风格同 describeEvent 测试；canEditComment 判定（作者/admin/其他人） |
| cli | title_changed 渲染 `renamed "a" → "b"`；(edited) 标记；comment edit 命令 fetch stub 断言 PATCH 路径与 body |
| 真机 | dogfood：web 里改 body/评论各两次，验证 popover 列表、diff 对话框、暗色主题；CLI `comment edit` + `issue view` 输出 |

## 7. 兼容性与边界

- 旧数据：历史从上线起记录；此前的编辑（仅 `edited_at` 标记）无法追溯，
  popover 对"有 edited_at 但零条 revision"的 comment 显示空列表提示
  （"history predates tracking"）。
- 响应体量：64 KiB body × 100 条上限 ≈ 13 MB 极端值，默认 limit 50、
  上限 100，接受（dogfood 规模）。
- 并发编辑：revision 插入与 body 更新同事务，last-write-wins 与现状
  一致。
- 未来 spec 文件：新 `subject_type` 直接复用本表与
  record/list/delete 三个 service 入口；分组版本（"spec v3 = 这五个
  文件"）届时由 spec 自己的表指向 revision id，本表保持扁平。
