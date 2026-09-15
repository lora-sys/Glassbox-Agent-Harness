# Plan 03 — Personal Agent Foundation

Status: ACTIVE

This is the only active implementation plan in the repository.

## Goal

Deliver a usable Personal Agent on Windows through QQ group mentions and verified Owner private chat. The phase focuses on PI-driven execution with extensible API protocols and multi-model configuration (以 PI 为主，API 可扩展，模型多配置), durable Conversations and delivery state, protected context, Trace inspection, and bounded Run-linked Eval. Vite+ and source reuse are explicit implementation requirements. 外部本机执行器不在当前执行路径，agy-staff remains the execution center.

The acceptance sentence is:

> The Owner can request and continue work from a designated QQ group or private chat, choose a configured model profile, inspect and cancel work, receive its outcome, reopen the Conversation after restart, and inspect the same Run in Trace and Eval without private contents crossing into group output.

## The closed loop

Plan 03 starts with a usable Owner-only QQ assistant. The broader isolation and authorization flow below is the final foundation gate, not a prerequisite for the first QQ milestone:

```text
Owner / Visitor request
        ↓
Resolve identity
        ↓
Resolve Principal + Conversation
        ↓
Authorization
        ↓
Load only authorized context
        ↓
Personal Agent Run
        ↓
Protected Tool re-authorization
        ↓
Result
        ↓
Persist Conversation + authorization state in Turso
        ↓
Write Run + AuthorizationDecision evidence to Trace
        ↓
Restart
        ↓
Resume the same Conversations with the same permission boundaries
```

The loop is successful only when all of these are true at the same time:

- Owner and Visitor reach the same Agent identity
- each Principal gets an isolated Conversation
- public resources work for both
- Owner-private resources never enter Visitor-visible model context
- a Visitor cannot indirectly borrow Owner authority through a Tool or prompt injection
- protected Tool calls recheck current authorization
- revocation takes effect without rewriting old evidence
- Turso survives restart and restores identity, relationships, grants, and Conversations
- every Allow, Deny, and approval path can be explained from Trace without logging denied private contents

QQ is introduced in the first milestone with minimal identity and isolation checks. Later Channels reuse the resulting boundaries. Memory, retrieval, routing, Mail, Calendar, Workers, LongTask, and Eval can all reuse the same Principal, Authorization, Conversation, persistence, and evidence boundaries.

## What P3 must leave behind

P3 is complete only if it leaves reusable product boundaries, not only a passing test suite.

The phase should stabilize the smallest useful contracts around:

```text
Principal
Resource reference
Action
AuthorizationDecision
Conversation identity
Session identity
Run identity
Authorized Context
Protected Tool execution
Durable structured state
Trace evidence
```

These do not need to become a generic framework or a frozen public API. They do need to be explicit enough that P4 can attach a real Channel without inventing a second trust model, and the documentation Learning Lab can demonstrate the same concepts without inventing contradictory fake semantics.

P3 should also leave one deterministic synthetic acceptance fixture that represents the whole closed loop:

```text
one Agent
Owner
Visitor
one public Resource
one Owner-private Resource
one public Tool
one Owner-only Tool
Grant / Revoke
restart
AuthorizationDecision + Run evidence
```

The same fixture may be reused by automated tests, local acceptance UI, examples, and later documentation demos. Production data must never be required for this fixture.

## Why this phase comes first

Remote channels, Memory, retrieval, routing, Mail, Calendar, Workers, LongTask, Eval, Journal, Skill evolution, and Asset Library all depend on one thing being correct first: who is acting and what that Principal is allowed to see or do.

Build the minimal identity and isolation checks alongside the first QQ milestone. The other higher layers remain deferred.

## Scope

In scope:

- `Agent`
- `User`
- `Principal`
- `ChannelIdentity`
- `Relationship`
- `Permission`
- `AuthorizationDecision`
- `Conversation`
- namespaced inbound message deduplication and explicit outbound delivery
- bounded Run-linked Eval samples, scores, and evidence
- Vite+ workspace migration and source provenance for copied implementations
- separation of `Conversation`, `Session`, and `Run`
- server-side default-deny authorization
- authorized context assembly boundary
- protected Tool execution boundary
- Turso-backed durable structured state
- authorization decisions written to inspectable evidence without leaking protected contents
- current release: Owner group mentions and private chat, configuration, execution, status, cancellation, delivery, persistence, Trace and fixed Eval
- subsequent release: separate user-owned records, group sharing and fine-grained grants
- one deterministic P3 acceptance fixture reusable by tests and later learning demos
- focused restart, isolation, denial, revocation, and confused-deputy tests
- a minimal inspection surface sufficient to see Principal, Conversation, Decision, authorized Context, Tool outcome, and Trace during acceptance

Out of scope for Plan 03:

- real WeChat integration
- real Mail or Calendar integration
- full Memory extraction or consolidation
- vector or hybrid retrieval
- semantic cache
- smart model routing or execution routing
- Context Budget optimization beyond what is necessary to keep existing Provider flows correct
- TokenJuice-style Tool-result projection
- Serverless deployment work
- Skill evolution
- Asset Library
- durable LongTask engine
- general Eval workbench, model-judge infrastructure and experiment scheduling beyond this phase's bounded acceptance loop
- Arena
- multi-Agent product semantics
- collaborative Canvas features
- OpenFGA as a required production service
- building or deploying the full documentation site
- large UI redesign

These are later consumers of the foundation, not prerequisites for it.

## Required invariants

### Authorization

All protected access is evaluated as:

```text
Principal × Resource × Action × Context → Decision
```

Decision is exactly one of:

```text
ALLOW
DENY
REQUIRES_APPROVAL
```

No matching grant means `DENY`.

### Context safety

Unauthorized data is filtered before model context assembly.

The forbidden pattern is:

```text
load private data → send to model → tell model not to reveal it
```

The required pattern is:

```text
resolve principal
→ authorize
→ load only authorized data
→ assemble context
→ execute model or tool
```

### Identity

A channel or Workbench identifier resolves identity. It does not grant permission by itself.

Binding two identities together is a trusted operation and must not silently merge permissions.

### Delegation

Any future Worker boundary must satisfy:

```text
worker_permissions ⊆ delegated_permissions ⊆ caller_permissions
```

Plan 03 does not need a real Worker, but the authorization model must not make this impossible later.

### Approval

Approval cannot manufacture permission. A Principal must already have an authorization path that permits the Action after approval.

### Revocation

Revocation applies to the next protected operation.

A cached UI state, stale Conversation, resumed Provider Session, old model context, or previous approval must not preserve authority after the relevant grant is revoked.

### Evidence

Authorization evidence records the decision and reason, but denial logs must not copy protected resource contents.

### Persistence

Restart must preserve durable Agent, User, identity, relationship, permission, Conversation, and authorization metadata.

Raw Trace remains separate append-only evidence. Do not move all trace payloads into SQL merely because Turso is introduced.

## Suggested domain shape

Do not treat this as frozen schema. Keep it small and adjust when tests reveal a better boundary.

```text
Agent
  id
  ownerUserId

User
  id
  kind

ChannelIdentity
  id
  userId
  channel
  externalId

Conversation
  id
  agentId
  userId
  channelIdentityId?
  createdAt
  updatedAt

Relationship
  principalId
  relation
  resourceType
  resourceId

AuthorizationDecision
  id
  principalId
  resourceType
  resourceId
  action
  decision
  reason
  approvalId?
  conversationId?
  runId?
  createdAt
```

Do not add a generic policy DSL unless the first real rules require it.

## P3 acceptance fixture

Use synthetic, stable identifiers and contents so tests and demonstrations can tell the same story.

A useful minimum fixture is:

```text
Agent
  agent:lora

Principals
  principal:owner
  principal:visitor

Resources
  resource:public-profile
  resource:private-project

Tools
  tool:public-status
  tool:owner-private-project-read
```

Expected behavior:

```text
Owner + public-profile       → ALLOW
Owner + private-project      → ALLOW
Visitor + public-profile     → ALLOW
Visitor + private-project    → DENY
Visitor + owner-only Tool    → DENY
Grant Visitor private read   → next operation ALLOW
Revoke that Grant            → next operation DENY
restart                      → identities, Conversations and current grants remain correct
```

The private fixture content must be distinctive enough that a test can prove it never appears in Visitor model context, Tool results, denial messages, or redacted Trace output.

## 本阶段实施方案

状态为 In progress。以下是唯一有效的当前实施顺序。源码与兼容性证据见 [复用清单](findings/03-p3.2-source-reuse-map.md)，当前模块和领域共识见 [CONTEXT.md](../CONTEXT.md)。

| 切片 | 状态 | 当前证据 |
| --- | --- | --- |
| A0 工具链与 Windows 基线 | In progress | 已确认写死的 Linux 路径与同时启动两个 Provider 的问题，正在迁移和修复，尚未通过验收 |
| A1 模型执行与多配置边界 | In progress | 以 PI 为核心模型运行时，固定测试 38 项通过；支持 PI 兼容协议；执行器以模型多配置为主，不再接入本机外部适配器 |
| A2 身份、会话与持久化 | In progress | libSQL 领域模块通过 11 项临时数据库测试，主服务已接 Run 调度；完整发布重启验收待补 |
| A3 QQ 渠道 | In progress | OneBot 协议 31 项固定测试及配置 UI 已完成；假 OneBot 到实际领域记录的整链测试通过，真实 QQ 联调待完成 |
| A4 任务控制与投递 | In progress | RunService 26 项测试通过，取消回执不等待执行器退出；群与私聊隔离、入站去重与 Trace 索引已联通 |
| A5 Trace、Eval 与统一管理入口 | In progress | 增量 Trace 28 项测试通过；模型配置完成 Chrome 宽窄屏和 CLI 同源读取；运行记录页、固定 Eval 与完整 Chrome 验收进行中 |

### 交付给用户的行为

- 在配置好的 QQ 群 @机器人发起任务。普通群消息和机器人消息不触发执行。
- 本人私聊机器人，使用明确授权的私人资料，保持连续对话。群会话和私聊会话分开，不能继承彼此的 Provider Session、工具输出或记忆。
- 选择配置好的模型提供商（以 PI 为主，API 可扩展，模型多配置）。先显式选择，不做自动智能路由。外部本机执行器不再接入。
- 收到接收确认和任务编号，查询进度、取消、继续会话，获得成功或失败结果和必要附件。
- 重启后查看原会话、任务和投递结果。中断的执行有明确状态，需要显式继续或重试，不假装从断点自动执行成功。
- 在现有 Workbench 检查连接、模型配置状态，查看对应 Run、Trace 和 Eval 结果。
- 通过统一 CLI 或 WebUI 管理上述配置与执行。两个入口共用同一个服务端配置存储和领域 API。

### 可扩展边界

| 边界 | 最小职责 | 首批实现 |
| --- | --- | --- |
| ChannelAdapter | 连接、收消息、消息标准化、发送、连接健康与能力声明 | OneBot、QQ 官方。NapCat 与 SnowLuma 是 OneBot 的不同实现配置 |
| ModelProvider | 模型清单、凭据引用、模型请求、流式结果、usage 与错误 | 复制 PI 核心的模型协议实现闭包 |
| ExecutionAdapter | start、events、cancel、可选 resume，以及支持能力 | 复制的 PI 模型工具循环、多模型提供商配置适配 |
| Tool boundary | 输入验证、当前授权、受控执行和结果可见范围 | 复用现有工具机制，首批文件与项目任务在明确工作目录内执行 |
| Conversation store | 身份与会话隔离、消息去重、配置与上下文快照引用 | Turso/libSQL 的本地持久化路径 |
| Trace projection | 追加证据、增量投影、脱敏、授权查询 | 现有 Trace 加 trajectory-panel 的所需实现 |
| Eval scorer | 固定样本、可版本化判定、Run 与 Trace 关联 | 身份、隔离、路由、取消、重启、投递与执行结果断言 |

这些边界放在 apps/server 中，出现真实跨进程消费者才移入 packages/contracts。不建立通用插件内核，不复制一个新 agent-runtime package。Provider-specific 元数据留在适配器内，通用契约不再引用已废弃的 codex/types。

### A0 工具链与 Windows 运行基线

按 Vite+ 官方迁移流程从 workspace 根迁移。当前 Vite 7、Vitest 3 的兼容升级与迁移属于同一个验证切片。保留项目 AGENTS，统一脚本、锁文件、Vite 和 Vitest 解析、Oxlint、Oxfmt、类型检查和构建。apps/server 仍是 Node 服务，启动命令通过 vp run 调用。

产物包括可复现的安装、前后端启动和检查入口，以及跨平台路径和进程解析。验收 vp install、启用类型检查的 vp check、vp test、web build 与 server 类型或构建检查。具体 workspace 命令在迁移后写入 README，不把预期命令冒充已存在命令。验证 Windows 含空格路径、harness 未安装、启动失败和端口占用。macOS/Linux 保持可移植，分别验证后才声明支持。

### A1 源码复制与执行边界

以 PI 为主，API 可扩展，模型多配置。复制 PI 模型 API 和 Agent 循环的必要依赖闭包，保留许可证与来源，改写上游内部包路径。外部本机适配器不再接入，agy-staff 为执行主线。渠道与会话适配按现有需求复用参考实现。

API provider 配置包含协议、base URL、model 与 credential reference。支持用户在 WebUI 与 CLI 中扩展多模型与凭证，密钥不进入浏览器返回、群消息或 Trace。streaming、cancel、resume、tools、attachments 按实际支持声明，不支持就返回明确结果。

先使用固定响应验证文本流、工具参数分片、失败、取消和无支持能力，使用真实配置的 API 模型进行端到端验证。禁止生产路径 import upstream，禁止残留 PI 或其他完整框架包引用；普通基础 SDK 和数据库驱动例外。

模型执行路径必须能约束工作目录、配置加载和受保护工具，才可用于群任务。不能用上游的 unrestricted 模式代替 Glassbox 的隔离。暂时无法证明群隔离时，该入口明确返回不支持，不把私人执行环境暴露给群。

### A2 身份、会话和数据库

数据范围由可信的 connection、bot account、chat type、group、sender 和 thread 确定。Owner 绑定在本机管理入口完成，不能接受聊天正文或昵称声称的身份。QQ 官方应用标识与 OneBot QQ 号分开，跨入口绑定需要验证。

私聊和每个群中各个调用者分别持有 Conversation，Provider Session 不跨范围复用。群执行环境不能自动发现 Owner 私人工作目录、全局记忆、历史会话或个人配置文件。受保护的文件读取和工具结果同样受输出目标约束，不能只在初始 Prompt 过滤一次。

Turso/libSQL 先持久化 agents、principals、channel identities、conversations、messages、runs、deliveries、authorization decisions、trace cursors 和 eval results。只为当前字段建表，配置密钥保存引用。用事务保存接收去重和入队意图。Raw Trace 继续在本地追加写，数据库保存索引和可重建派生数据，游标可以重放修复，不能假定文件和数据库天然原子一致。

验收两类聊天互不串上下文、撤销后下一次受保护操作拒绝、重复事件不重复启动任务、数据库关闭重开、追加文件尾部不完整记录的恢复。

### A3 QQ 群 @ 与本人私聊

先落地一个 OneBot 适配器，支持带 Token 的本地连接、事件验证、群 @判断、私聊路由、文本、回复引用、必要附件与重连。连接默认仅本机可达，远端接入必须显式配置。

首先使用 NapCat 在 Windows 完成两个真实流程，再以相同协议测试 SnowLuma。官方 QQ 通过独立适配器接入腾讯身份、事件、鉴权和发送规则，复用领域流程。三者分别记录能力与验证结果，只有实际通过才标记可用。

本阶段的完成门槛包含一个真实 QQ 实现的群 @和本人私聊。官方 QQ 的真实账号能力或审核未就绪时，适配器与固定协议验收可以完成，但真实联调单独标记待完成，不能声称全部入口已验收。登录、机器人凭据与测试群由本人提供，不发送至其他群。

### A4 任务控制和可靠投递

同一 Conversation 的执行串行处理，不同 Conversation 使用有限并发。接收后先持久化，再给出任务编号。使用运行事件更新状态，支持查询、取消和明确的继续或重试。进度消息按渠道能力节流，不能每个 token 发一条 QQ 消息。

每个输出带明确的入口、账号、目标和来源 Run。投递状态至少区分 pending、sending、sent、failed、unknown。结果未知时不盲目重发，已确认的投递不重发，不自动跨适配器绕过发送限制。失败任务也要有可查询状态，不能依赖最后一条 QQ 消息才能知道结果。

取消只在底层确认后显示 cancelled；超时且无法确认时保留中间或未知状态。重启把遗留 running 状态核对为 interrupted 或仍在运行，不能凭旧状态显示成功。非幂等工具不得自动重跑，继续能力按执行器声明判断。

### A5 Trace、最小 Eval 和检查界面

每个 Run 关联输入来源、执行配置、授权决定、工具事件、产物引用、usage、错误、取消与投递记录。Raw Trace 保留已采集证据；派生 Timeline 可以更新和分页，但不能回写原始文件。敏感值在记录边界排除，后续脱敏和截断只用于允许访问的显示视图。

复制 trajectory-panel 的增量解析和批量索引机制，保留现有 reducer、Inspector 与 Canvas。界面复用现有组件，补连接状态、配置、任务列表、Trace 检查和 Eval 结果，不重新设计整个工作台。正常调用和查询使用相同服务器权限边界，密钥不在前端展示。

统一 WebUI 以管理入口为首页，显示连接健康、正在执行的任务和需要处理的失败。导航包含会话、渠道、模型与执行器、任务与 Trace、Eval、工作区。Canvas 和 Inspector 作为工作区与任务检查视图继续使用。尚未实现的后续模块不提供可点击的空页面。

首次配置在本机完成 Owner 绑定、QQ 连接、模型或本机执行器选择、工作目录授权。表单明确区分未保存、已保存、检查中、可连接、连接失败和未验证。密钥只提交到服务器，查询接口只返回是否已配置。连接检查不等于真实任务验收。任何开始、取消、重试或发送操作都有明确按钮，界面不能因编辑配置隐式执行。

界面从领域 API 获取分页数据和能力声明，不自行推断权限或任务状态。服务器拒绝、连接中断、空数据、重复提交、窄屏和键盘操作都属于验收。使用 Chrome 检查配置、任务详情、失败恢复和 Trace/Eval 证据链，记录实际运行结果。

统一 CLI 覆盖服务启动、诊断、配置、渠道、会话、任务、Trace 和 Eval，命令分组参考统一管理面。CLI 调用与 WebUI 相同的管理 API，支持 JSON 输出和准确的退出码。密钥通过私密输入或凭据引用配置，不通过可被进程列表读取的命令行参数传入。服务独占配置写入，离线命令必须先取得相同数据目录的独占权，不能各写一份配置。Pi TUI 只提供后续交互组件的参考。

参考 Inspect AI 的样本、目标、评分与证据结构，使用现有测试执行器运行固定 Eval。每个结果记录 sampleId、runId、trace 引用、scorer version、期望、观测与判定。统计耗时、调用数和 token 时说明来源，未提供的指标保持未知，不伪造为零。第一批不使用付费模型裁判。

### 本阶段发布验收

以下是必须同时交付的闭环，不能仅通过 UI 截图宣称完成。

1. Windows 安装和启动可复现，Vite+ 检查、构建与确定性测试通过。
2. 指定群 @触发任务，无 @和机器人消息不触发；本人私聊可连续对话。
3. API 模型配置与多模型提供商能力状态真实；实际启用的 PI 执行路径有验收证据。
4. 群与私聊的历史、文件、工具结果、附件和 Trace 查询不串数据。
5. 状态查询、取消、继续和重试都有底层结果，完成与失败有对应投递记录。
6. 重复入站、断线、模型失败、QQ 发送失败和发送结果未知均有固定测试。
7. 数据库与服务重启后，会话、任务、投递和 Trace 索引可恢复，未完成的执行不会显示成功。
8. 固定 Eval 覆盖以上场景，结果能定位到对应 Run 和 Trace。真实 QQ 与真实模型调用验收单独记录，不能用 mock 结果替代。
9. 复制文件的来源与许可证齐全，运行时不依赖 upstream checkout。
10. WebUI 与 CLI 修改同一份配置。通过一个入口保存后，另一个入口立即读取相同值。两者的任务控制、权限拒绝与错误结果一致。

### 下一阶段

先通过上述本人可用版本，再开放其他用户独立保存、读取和删除内容，明确群共享范围与来源，增加细粒度 grants、approval 和 revocation。自动学习、完整 Memory、Skill 演进、Arena、通用评测平台和耐久 LongTask 不进入本阶段。

## Test matrix

At minimum cover:

```text
default deny
explicit allow
requires approval
cross-user read
private/public scope
identity spoof attempt
identity binding does not grant authority
revocation
stale authorization state
confused deputy
protected Tool call
replayed approval
duplicate request or retry
restart and resume
denial trace redaction
fixture private-content non-leak assertion
```

Use fake resources, fake channels, and fake protected Tools for most tests.

Use fake channels, tools, providers, and disposable databases for deterministic checks. Real QQ acceptance requires a designated test bot and group; do not send to unrelated users or groups.

## Upstream references for this phase

Read before implementing:

- `openfga/openfga`: relation-based authorization model and tuple semantics
- `HKUDS/OpenHarness`: channel identity, session routing, permissions, and agent boundary patterns
- `tursodatabase/turso`: durable SQLite-compatible state
- `earendil-works/pi`: TypeScript model providers and agent loop
- existing `.plans/findings/`: current Glassbox Trace, state, provider, and WebSocket evidence

`TokenRhythm/opensquilla` is an approved post-foundation efficiency reference, not a Plan 03 implementation dependency. Do not add smart routing, vector retrieval, semantic caching, TokenJuice-style projection, or Serverless work to this phase just because OpenSquilla provides useful mechanisms for later phases.

Full reference checkouts are available under the ignored upstream/repos directory. They are not runtime imports. Prefer an existing package or protocol integration; copy only the source needed for a concrete slice, preserving its commit, original path, license, and notices.

## Code placement guidance

Prefer incremental modules under `apps/server/src/` such as:

```text
auth/
identity/
conversation/
persistence/
```

These names are guidance, not mandatory architecture.

Do not create `packages/agent-runtime` or another shared package until more than one real runtime consumer requires it.

Keep provider-specific behavior near provider boundaries; legacy external adapters remain isolated.

Keep Canvas changes minimal during this plan. The acceptance target is runtime correctness, persistence, authorization evidence, and a small truthful inspection surface.

Do not build a second authorization simulator for the UI or docs. If an acceptance UI needs to display a Decision, it should reflect the real server-side decision or deterministic fixture semantics used by the tests.

## Full foundation completion gate

The Owner release is governed by the current-phase acceptance section above. Plan 03 as a whole is complete only when all of these are true:

- the Owner-only QQ flow and configured completion notification work on Windows
- other users can manage their own records without receiving the Owner's personal context
- QQ adapters preserve separate identities and explicit delivery routing

- default-deny authorization is enforced server-side
- Owner and Visitor isolation is covered by automated tests
- unauthorized content is excluded before context assembly
- protected Tool execution rechecks authorization
- Conversation is durable and distinct from Session and Run
- Turso-backed state survives restart in tests
- authorization decisions are inspectable and do not leak denied contents
- Grant and Revoke affect the next protected operation correctly
- the deterministic P3 acceptance fixture proves the closed loop end to end
- the fixture can support later documentation demos without inventing different authorization semantics
- existing provider behavior has focused regression coverage
- no real WeChat, Mail, Calendar, Memory retrieval, smart routing, Worker, durable LongTask engine, general Eval platform, Serverless, or documentation-site deployment dependency was required to prove the foundation

When this gate passes, the next runtime plan is `P4 — Multi-channel Expansion` from `.plans/roadmap.md`, unless the roadmap is deliberately changed first.

The Documentation / Learning Lab may then mark the proven P3 concepts as `Implemented` and build the first interactive lessons from the same contracts and deterministic fixture.
