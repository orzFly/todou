# Edit history with diffs — 契约参考

## 1. HTTP 契约

### 新端点

```
GET /api/projects/{slug}/issues/{number}/revisions
GET /api/projects/{slug}/issues/{number}/comments/{commentId}/revisions
```

- 权限：reader（与读 issue/timeline 相同）。
- Query：`limit`（int，1–100，默认 50）。
- comment 不属于该 issue、或 issue/comment 不存在 → 404。

响应（两端点同构，newest-first）：

```jsonc
{
  "items": [
    {
      "id": 12,
      "actor": {                     // UserRef：这次编辑的执行者
        "id": 3, "login": "claude-agent",
        "display_name": "…", "kind": "agent", "owner": null
      },
      "created_at": "2026-08-12T10:00:00.000Z",  // 编辑发生时刻
      "body_before": "编辑前全文",
      "body_after": "编辑后全文",     // 服务端配对：更新一条的 before，最新一条 = 当前正文
      "agent_context": { "agent": "claude-code", "model": "…" }  // 或 null
    }
  ]
}
```

语义：一条 item = 一次真实变更的编辑。`limit` 截断只丢更老的编辑，
返回窗口内每条的 before/after 完整。

### 行为变更（无新写端点）

| 端点 | 变更 |
| --- | --- |
| `PATCH /{slug}/issues/{number}` | `body` 与现值不同 → 落 revision（编辑前快照）+ 置 `body_edited_at`；不发 timeline 事件 |
| `PATCH …/comments/{commentId}` | body 相同 → 200 no-op（不落 revision、不 bump `edited_at`、不发 SSE）；不同 → 事务内落 revision + `edited_at` |
| `DELETE …/comments/{commentId}` | 级联删除该 comment 的 revisions |

### DTO 变更

- `Issue` 增加 `body_edited_at: string | null`（时间戳，最近一次 body
  变更；从未变更为 null）。

## 2. shared schema / client

```ts
// schemas/revision.ts（新）
Revision      = { id, actor: UserRef, created_at, body_before, body_after,
                  agent_context: AgentContext | null }
RevisionPage  = { items: Revision[] }
RevisionQuery = { limit?: number }   // coerce，1–100，默认 50

// client.ts（新方法）
client.getIssueRevisions(slug, number, query?)             → RevisionPage
client.getCommentRevisions(slug, number, commentId, query?) → RevisionPage
```

## 3. CLI 面变更

| 项 | 说明 |
| --- | --- |
| `todou comment edit <number> <commentId> --body/--body-file`（新） | 包装 PATCH comment；`--json` 输出更新后的 comment |
| `todou issue view` | `title_changed` 渲染为 `renamed "old" → "new"`；被编辑过的 comment 显示 `(edited)` |

CLI 不提供 history 查看；需要时走
`todou api get /projects/{slug}/issues/{n}/revisions`。
