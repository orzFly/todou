# API: todou server + web core

前缀 `/api`。除标注 `公开` 外均需身份（session cookie 或 `Authorization:
Bearer todou_pat_…`）。错误统一：

```json
{ "error": { "code": "not_found", "message": "…", "details": { } } }
```

401 未认证 · 403 无权限 · 404 不存在 · 409 冲突 · 422 校验失败（details
含字段错误）。列表分页统一 cursor 风格：`?cursor=&limit=`，响应
`{ items, next_cursor }`（timeline 特殊，见下）。

## Auth

| 方法 路径 | 说明 |
| --- | --- |
| POST `/auth/login` 公开 | `auth.mode=single`：无输入，为内置 `user` 建 session，Set-Cookie。其他 mode 本切片 400 `unsupported_auth_mode` |
| POST `/auth/logout` | 销毁当前 session |
| GET `/me` | 当前身份：`{ id, kind, login, display_name, is_instance_admin, owner? }` |
| POST `/me/tokens` | 给自己签 PAT。req `{ name, expires_at? }` → **明文 token 仅此一次** `{ id, token, prefix, name }` |
| GET `/me/tokens` · DELETE `/me/tokens/:id` | 列出（仅 prefix）/ 吊销 |

## Agents（machine users）

| 方法 路径 | 说明 |
| --- | --- |
| POST `/agents` | 创建 agent，owner=当前 human。req `{ login, display_name }`。machine 用户不能调用（403） |
| GET `/agents?owner=me` | 我名下（instance admin 可 `?owner=all`） |
| PATCH `/agents/:id` · DELETE `/agents/:id` | 改名/停用；仅 owner 或 instance admin |
| POST `/agents/:id/tokens` · GET 同 · DELETE `/agents/:id/tokens/:tokenId` | 为 agent 签发/列出/吊销 PAT；仅 owner 或 instance admin |

## Projects / Members / Statuses / Labels

| 方法 路径 | 说明 |
| --- | --- |
| POST `/projects` | req `{ slug, name, description? }`；创建者成为 admin；自动 seed 三 status |
| GET `/projects` | 我可见的（是 member 的）项目 |
| GET/PATCH/DELETE `/projects/:slug` | 详情/更新（admin）/删除（admin） |
| GET/PUT/DELETE `/projects/:slug/members/:userId` · GET `/members` | role ∈ admin\|writer\|reader；管理需 admin；agent 也经此加入 |
| CRUD `/projects/:slug/statuses` | `{ name, category: open\|closed, color, position }`；删除被引用的 status → 409（需先迁移 issue）；PATCH 支持排序 |
| CRUD `/projects/:slug/labels` | `{ name, color }`；project 内 name 唯一 |

## Issues

| 方法 路径 | 说明 |
| --- | --- |
| GET `/projects/:slug/issues` | 过滤 `status`（id 多值）、`category=open\|closed`、`label`（多值）、`assignee`、`q`（title/body ILIKE）；`sort=created\|updated\|number` `order=asc\|desc`；cursor 分页 |
| POST `/projects/:slug/issues` | req `{ title, body?, status_id?, assignees?, labels? }` → 事务内分配 number、写 `opened` 事件（writer+） |
| GET `/projects/:slug/issues/:number` | 详情（含 status、labels、assignees、attachment 列表） |
| PATCH `/projects/:slug/issues/:number` | 部分更新 `{ title?, body?, status_id?, assignees?, labels? }`；差异自动落 issue_events（status_changed/closed/reopened、title_changed、label_added/removed、assigned/unassigned）（writer+，见权限矩阵） |

## Timeline / Comments

| 方法 路径 | 说明 |
| --- | --- |
| GET `/projects/:slug/issues/:number/timeline` | 评论⨯事件归并流。参数 `before` / `after`（不透明 cursor）、`limit`（默认 50）、`last=1`（最新一页）。响应 `{ items, prev_cursor?, next_cursor? }`；item 为判别联合：`{ type: "comment", … }` \| `{ type: "event", event_type, payload, … }`，均含 `author/actor` 摘要 |
| POST `/projects/:slug/issues/:number/comments` | req `{ body }`（writer+；解析 `#N` → 在被引用 issue 写 `referenced` 事件） |
| PATCH/DELETE `/projects/:slug/issues/:number/comments/:id` | 作者本人或 project admin；编辑置 `edited_at`。（实现注：两层库架构下 comment id 无法脱离 project 定位，故路径挂在 project 下） |

## Attachments

| 方法 路径 | 说明 |
| --- | --- |
| POST `/projects/:slug/attachments` | multipart `file` + `issue_number`；≤ `storage.max_upload_mb`；写 `attachment_added` 事件 → `{ id, url, filename, size, content_type }` |
| GET `/projects/:slug/attachments/:id/download` | project member 鉴权；fs 后端流式返回 + Content-Disposition（s3 后端将 302，后续切片）。（实现注：同 comment，附件路径挂在 project 下） |

## SSE

`GET /projects/:slug/events`（member 鉴权，`text/event-stream`，30s 心跳）

```
event: change
data: { "entity": "issue" | "comment" | "timeline" | "label" | "status"
        | "member" | "project",
        "id": 123, "action": "created" | "updated" | "deleted",
        "issue_number": 42 }        // timeline/comment 事件附带
```

客户端失效映射（web 侧约定）：`issue.*` → `['issues', slug, *]` +
`['issue', slug, number]`；`timeline.*` → `['timeline', slug, number]`；
`label/status/member/project` → 对应配置查询。

## OpenAPI

`GET /api/openapi.json` 公开 — 由 @hono/zod-openapi 自动生成。

## 权限矩阵（project 内）

| 操作 | reader | writer | admin |
| --- | --- | --- | --- |
| 读 issues/timeline/附件/SSE | ✓ | ✓ | ✓ |
| 建/改 issue、评论、上传附件 | | ✓ | ✓ |
| 改他人评论、删评论 | | 本人的 | ✓ |
| members/statuses/labels/project 管理 | | | ✓ |

instance admin 隐含所有 project 的 admin；agent 权限完全由其 member role
决定，与 owner 无关。
