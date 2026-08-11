# CLI（切片 2）— 原始需求与澄清记录

## 来源

Issue：https://todou.example/projects/todou/issues/1
（`todou` 项目 #1，标题「CLI (slice 2): todou client for humans and agents」）

Issue 正文（原样）：

> 路线图切片 2（specs/20260811-server-web-core/brainstorm.md §9）。
>
> - clipanion 命令集：`todou project list` · `todou issue list/create/view/edit/close` · `todou comment add` · `todou label …` · `todou attach <file>` · `todou login` / `todou whoami`
> - 所有读命令支持 `--json`（稳定 schema，面向 agent）
> - `todou login`：浏览器换 PAT，存入 `~/.config/todou/config.toml`；`TODOU_SERVER` / `TODOU_TOKEN` 环境变量可覆盖（CI 友好）
> - 基于 `@todou/shared` 的 TodouClient（bearer 模式已就绪）
> - 配置 schema 从 server 抽到 shared

## 澄清问答

### Q1 登录流程

**问**：`todou login` 的浏览器换 PAT 流程，你倾向哪种实现？

- **localhost 回调（推荐）**：CLI 起一个一次性 localhost 监听，打开浏览器到
  web 端一个「授权 CLI」页面；页面用已有 cookie 会话调 POST /me/tokens 签
  PAT，然后回调发给 CLI 自动写入配置。需要 web 端加一个小页面，server 不加
  新端点。headless 场景退化为手动粘贴。
- **纯手动粘贴**：CLI 打印 Settings → Tokens 页面的 URL，用户自己创建 PAT
  后粘贴回终端。零 server/web 改动，最简单，但每次登录都要手动复制。
- **device-code 流程**：CLI 向 server 申请一次性授权码，用户在浏览器输入/
  确认，CLI 轮询取 token。对无本地端口的远程 shell 最友好，但需要 server
  新增端点和状态存储，改动最大。

**答**：localhost 回调（推荐）。

### Q2 命令范围

**问**：命令面的范围怎么划？议题里列了 project list / issue 全套 / comment
add / label … / attach / login / whoami，但没说 label 之外的项目管理命令
（status、member、agent、token）要不要。

- **议题清单 + status list（推荐）**：严格按议题：project list、issue
  list/create/view/edit/close、comment add、label list/create/edit/delete、
  attach、login/whoami；另加 status list（issue edit/close 需要知道有哪些
  状态）。member/agent/token 管理留给后续切片。
- **只做 issue 工作流**：issue list/create/view/edit/close + comment add +
  attach + login/whoami；label/status 只读（list），不做 CRUD。最小可用，
  但比议题写的范围小。
- **对齐 web 全功能**：再加上 project create/edit、member 管理、agent/token
  管理。CLI 一步到位，但切片变大，很多命令短期用不上。

**答**：议题清单 + status list（推荐）。

### Q3 JSON 形状

**问**：`--json` 的稳定 schema 怎么定？

- **直透 REST 响应（推荐）**：--json 时原样输出 API 返回的 JSON（即
  @todou/shared 里已有的 zod schema）。契约只有一份，API 稳定则 CLI 稳定，
  零映射代码。写命令（create/edit/close）也支持 --json，输出受影响的实体，
  方便 agent 拿到新 issue 的 number。
- **CLI 专属扁平 schema**：为 CLI 单独设计一层扁平化输出（如 status 只给
  名字不给对象）。对 jq 用户更友好，但多一层需要维护的契约，API 变更时容易
  漏同步。

**答**：直透 REST 响应（推荐）。

### Q4 多环境

**问**：`~/.config/todou/config.toml` 要支持多个 server 吗？你至少有本地
开发和 dogfood 两个环境。

- **多 server 表（推荐）**：配置里按 origin 存多个 server（各自的 token）+
  一个默认指针；`--server <origin|别名>` 或 TODOU_SERVER 选择，TODOU_TOKEN
  覆盖 token。login 多次不互相踩。
- **单 server**：配置只存一组 server+token，换环境靠重新 login 或纯环境
  变量。实现最简，但切换体验差。

**答**：多 server 表（推荐）。

### Q5 project 上下文

**问**：issue/label 等命令怎么确定目标 project？每条命令都打
`--project todou` 比较繁琐。

- **flag + 默认值（推荐）**：`-p/--project <slug>` 显式指定；配置里每个
  server 可记一个默认 project（`todou project use <slug>` 写入）；
  TODOU_PROJECT 环境变量可覆盖。agent 用环境变量/flag，人用默认值。
- **纯显式 flag**：没有隐式状态，每条命令必须 -p。对 agent 无所谓，对人
  繁琐，但永远不会误打到错的 project。
- **cwd 绑定**：像 git 一样，在目录里放 .todou 文件绑定 project，命令按
  cwd 向上查找。最顺手但多一套发现机制，跨目录操作时容易意外。

**答**（自定义，原文）：可以 -p/--project。不要在配置里弄默认project，这个
很奇怪。然后做cwd绑定，cwd绑定考虑用.git里的remote绑定到server/project，
绑定信息考虑落在 todou的配置里，这样不污染仓库

### Q6 命令架构

**问**：命令层怎么组织？这决定了 ~20 条命令的代码形态和后续加命令的成本。

- **基类 + 手写命令（推荐）**：一个 ApiCommand 基类包办 server/token/project
  解析、client 构造、--json、错误→退出码；每条命令是一个小类，只写 flags +
  一个 execute。clipanion 原生形态，特殊命令（login、attach）不需要绕过抽象。
- **声明式命令表**：用一张数据表声明 name/flags/handler，运行时生成 clipanion
  命令类。样板最少，但和 clipanion 的类模型相抖，类型推导变弱，login/attach
  这种特殊命令还是要开后门。
- **通用透传层**：只做极薄的 REST 映射（接近 `todou api GET
  /projects/x/issues`）+ 通用格式化。代码最少，但人类 UX 差，达不到议题要求
  的命令面，基本只能作为附加逃生舱而非主体。

**答**（自定义，原文）：基类+手写命令+通用透传层

## 设计分段确认

设计按三段展示（§1 包结构/配置/上下文解析、§2 命令面明细、§3 login 流程/
shared 抽取/错误处理/测试/明确不做），三段均获回答「对，继续」/「对，写
spec」，无修改意见。
