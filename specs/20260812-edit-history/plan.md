# Edit history with diffs — 实施计划

> 依据 [brainstorm.md](./brainstorm.md) 与 [design.md](./design.md)，契约见
> [api.md](./api.md)。每步 `pnpm fmt && pnpm lint && pnpm typecheck &&
> pnpm test` 全绿后按 AGENTS.md 惯例提交（conventional prefix +
> `Spec: specs/20260812-edit-history` 行 + Co-Authored-By）。

## 步骤 1 — server+shared：revisions 表与写路径捕获

1. `db/project-schema.ts`：新增 `revisions` 表（design §2.1）+
   `issues.bodyEditedAt` 列；`drizzle-kit generate --config
   drizzle.project.config.ts` 生成 `drizzle/project/0002_*.sql`。
2. 新建 `services/revisions.ts`：`recordRevision(tx, …)` 与
   `deleteRevisionsFor(tx, subjectType, subjectId)`（design §2.2 前半）。
3. `services/issues.ts` `updateIssue`：事务内 body 真变更 →
   recordRevision（subject `issue_body`，body=旧值，带 actor/
   agentContext）+ `patch.bodyEditedAt = new Date()`；`toIssue` 带出
   `body_edited_at`。
4. `services/comments.ts`：
   - `updateComment` 加 no-op 守卫（body 相同 → 返回现有行，不写库、
     不 publish、不 recordReferences）；真变更路径事务化并
     recordRevision。
   - `deleteComment` 事务化并级联 `deleteRevisionsFor`。
5. `@todou/shared` `schemas/issue.ts`：`Issue` 加
   `body_edited_at: Timestamp.nullable()`（与本步 server 同提交）。
6. server 测试（`test/issues.test.ts` 或新 `revisions.test.ts`）：
   - body 编辑落 revision、置 body_edited_at；title-only 编辑不落；
   - comment 编辑落 revision；no-op → 200、无 revision、`edited_at`
     不变、无 SSE 事件（订阅 bus 断言）；
   - 删 comment → revisions 清空（直查表断言）。

提交：`feat(server): capture body revisions on issue and comment edits`

## 步骤 2 — server+shared：revision 读取端点

1. `@todou/shared`：新建 `schemas/revision.ts`（`Revision` /
   `RevisionPage` / `RevisionQuery`，design §3.1），`index.ts`
   re-export；`client.ts` 加 `getIssueRevisions` /
   `getCommentRevisions`。
2. `services/revisions.ts` 补 `listRevisions`（newest-first 配对 +
   ghost 回落）与 `listIssueRevisions` / `listCommentRevisions`
   （reader 校验、comment 归属校验）。
3. `routes/issues.ts`：注册两条 GET 路由（api.md §1）。
4. server 测试：
   - 编辑 issue body 两次 + comment 两次 → GET 配对正确（最新条
     `body_after` = 当前正文，第二条 after = 第一条 before）；
   - `limit=1` 截断后窗口内配对完整；
   - reader 可读；comment 不属于该 issue → 404；actor 删除 → ghost。
5. shared 测试：client 方法请求路径与 query 拼接（沿用现有 fetch stub
   风格）。

提交：`feat(server): revision history endpoints with before/after pairing`

## 步骤 3 — web：修订历史 popover 与 diff 对话框

1. `projects/web` 加依赖 `@pierre/diffs`。
2. 新建 `components/ui/popover.tsx`（radix-ui 包装，照 `dialog.tsx`
   写法）。
3. 新建 `components/shared/revision-history.tsx`（design §4.1）：
   "(edited)" 触发器 → popover 修订列表（UserChip + AgentContextBadge +
   相对时间，打开才 fetch）→ 点击项弹 Dialog 渲染 `MultiFileDiff`
   （stacked、pierre 双主题、`description.md`/`comment.md` 文件名）。
   空列表（feature 上线前的编辑）显示 "history predates tracking"。
4. 接入：`comment-item.tsx` 的 `(edited)` 换成 `RevisionHistory`；
   `issue-detail.tsx` `BodyBlock` 在 `body_edited_at` 非空时渲染。
5. web 测试：修订列表标签/触发条件的纯函数单测（`describeEvent` 测试
   同款风格）。
6. 手动冒烟：dev server 里编辑 body 看 popover + diff（含系统暗色）。

提交：`feat(web): edit history popover with pierre diffs`

## 步骤 4 — web：评论行内编辑

1. `issue-detail.tsx`：由 `meQuery` + `membersQuery` 推出
   `viewer = { id, isAdmin }`（核对 members 响应的 role 字段），经
   `Timeline` 透传到 `CommentItem`。
2. `comment-item.tsx`：作者或 admin 可见铅笔按钮；编辑态 Textarea +
   Save/Cancel（照 BodyBlock 模式），调 `api.updateComment`，成功后
   invalidate `["timeline", slug, number]`。
3. web 测试：`canEditComment` 判定（作者 / admin / 其他人）。

提交：`feat(web): inline comment editing`

## 步骤 5 — cli：comment edit 与 issue view 润色

1. `commands/comment.ts` 加 `CommentEditCommand`（design §5），
   `commands/index.ts` 注册。
2. `commands/issue.ts` `renderTimelineItem`：`title_changed` 特判
   `renamed "from" → "to"`；comment 行按 `edited_at` 加 `(edited)`。
3. cli 测试：新命令 PATCH 路径/请求体断言（fetch stub）；两处渲染的
   format 断言。

提交：`feat(cli): comment edit command and richer issue view`

## 步骤 6 — 真机验证与收尾

1. 按 [docs/deploy.md](../../docs/deploy.md) 更新 `todou` 主机部署
   （`./deploy.sh`）。
2. dogfood 真机走查：web 编辑 issue body 两次、编辑/新增评论各一，
   验证 popover 列表、diff 对话框、评论铅笔编辑、no-op 保存不产生
   (edited)；CLI `comment edit`、`issue view` 新渲染。
3. 在 todou#16 留言总结实现要点并关闭该 issue。

无提交（部署 + 验证）；如走查发现问题，修复按对应步骤的提交前缀补交。
