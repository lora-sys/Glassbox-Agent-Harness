# Glassbox

![Glassbox Personal Agent：把每一次对话变成更好的自己](./assets/readme/glassbox-hero.png)

Glassbox 是一个正在演进中的 Personal Agent 工作台。

目标是让你拥有一个长期存在的主 Agent。你在 Workbench 或 QQ 里和它对话，它可以直接回答，也可以把需要真正开发的工作登记成 Task，交给 Herdr 里的 Pi、Codex、Claude Code 等 coding worker。你不需要自己盯着每一个 workspace、worktree 和 Agent，主 Agent 应该知道现在有多少消息、多少任务、谁在工作、谁卡住、哪些结果等验收。

其他人也可以访问同一个 Agent，但只能看到和使用被明确授权的部分。

**权限是第一原则。** Channel 只是入口，Herdr 是执行现场，Canvas 是工作视图。真正的产品状态由 Glassbox 管理，包括 Identity、Authorization、Conversation、Task、Run、Trace，以及后续的 Rules、Skills、Taste、Memory、LongTask、Eval。

> 当前仓库正在把已有 Coding Agent Harness 收口成第一个真实可用的 Personal Agent + Agent Operations 闭环。README 会区分已经实现的能力和当前正在实现的能力。

## 当前开发阶段

当前唯一 Active Plan：[`Plan 03 — QQ Personal Agent Closed Loop`](./.plans/03-personal-agent-foundation.md)

开发顺序以 [`AGENTS.md`](./AGENTS.md) 和当前 P3 Plan 为准。长期阶段顺序记录在 [`.plans/roadmap.md`](./.plans/roadmap.md)。Runtime 边界记录在 [`docs/runtime-strategy.md`](./docs/runtime-strategy.md)，Herdr / Task / worker 边界记录在 [`docs/agent-operations.md`](./docs/agent-operations.md)。学习层方向记录在 [`docs/memory-taste.md`](./docs/memory-taste.md)。

P3 结束时要得到两个连在一起的真实闭环。

Personal Agent 闭环：

```text
测试环境
  ↓
Lora PI Kit MVP
  ↓
Pi SDK Runtime
  ↓
Identity + Authorization
  ↓
Conversation + Turso
  ↓
NapCat / OneBot QQ Channel
  ↓
QQ 私聊 + 群聊
  ↓
Trace + 重启恢复 + 去重 + 重连
  ↓
真实 QQ 验收
```

Agent Operations 闭环：

```text
消息 / 工作请求
  ↓
Main Agent
  ↓
Attention Queue + Task Registry
  ↓
Ops Tools
  ↓
HerdrBridge
  ↓
Herdr workspace / worktree / pane / coding Agent
  ↓
working / blocked / done events
  ↓
Ops Reconciler
  ↓
TaskAttempt + WorkerBinding
  ↓
Review
  ├─ Accept → DONE
  └─ Rework → 下一次 TaskAttempt
```

P3 的验收目标：

> 真实 Owner 和 Visitor 可以通过 QQ 私聊和测试群使用同一个 Glassbox Personal Agent。底层由 Pi SDK + Lora PI Kit 执行。Ingress、Context、Tool、Delivery 四道服务端硬权限阀门生效。主 Agent 能看到自己的消息、Task、Attention 和 worker 状态，可以把至少一个真实开发任务派给 Herdr 管理的 coding Agent，观察 working / blocked / done，验收或返工，并在重启和 Herdr 重连后保持正确的 Task 真相。

## 当前闭环

```text
QQ 私聊 / 群聊
       ↓
     NapCat
       ↓
    OneBot 11
       ↓
Glassbox QQ Channel
       ↓
   Ingress Gate
       ↓
Identity Resolution
       ↓
Conversation Resolver
       ↓
Authorization Engine
       ↓
   Context Gate
       ↓
Authorized Context
       ↓
Pi SDK + Lora PI Kit
       ↓
    Tool Gate
       ↓
Direct Run
   或
Task + Attention
       ↓
HerdrBridge
       ↓
Herdr coding worker
       ↓
Review / Rework / Accept
       ↓
  Delivery Gate
       ↓
     NapCat
       ↓
    QQ 回复
       ↓
Turso + Raw Trace
```

QQ Bot、Workbench 和以后其他 Channel 都只是同一个 Personal Agent 的入口，不是不同 Agent。

Pi、Codex、Claude Code、Herdr worker、AGY 等属于 Runtime、Worker 或执行基础设施，也不是产品身份本身。

## Runtime strategy

Pi 是当前 Personal Agent 主 Runtime 路线。

Glassbox 直接通过 `@earendil-works/pi-coding-agent` SDK 嵌入 Pi：

```text
earendil-works/pi
      ↓
Lora PI Kit
      ↓
Pi SDK
      ↓
Glassbox Runtime Boundary
```

Lora PI Kit 单独维护，负责：

```text
Pi Extensions
Pi package manifest
selected Skills
prompts
presets
model / thinking profiles
trace / usage hooks
install / doctor / sync scripts
Pi compatibility metadata
```

`lora-sys/skills` 继续作为可复用 Agent Skills 的来源。Lora PI Kit 负责选择和安装，不默认复制一套 Skill 源码。

Glassbox 负责：

```text
Agent identity
Principal
Channel identity
Authorization
Conversation
Task / TaskAttempt / Attention
WorkerBinding
Taste / Memory truth
Turso state
Run
Audience / Delivery policy
Raw Trace
```

NapCat 和 OneBot Transport 属于 Glassbox Channel 层。Herdr 属于 Agent Operations 层。它们都不放进 Lora PI Kit。

改 Pi 时遵循：

```text
settings / project config
→ Pi package
→ Skill
→ Extension
→ custom Tool
→ Pi SDK
→ upstream contribution
→ 最后才考虑小范围 core patch
```

P3 不以 RPC 作为主要 Pi 接入方式。Codex 和 Claude Code 继续保留，既可以作为兼容 Runtime，也可以作为 Herdr 中的 coding worker。

完整规则见 [`docs/runtime-strategy.md`](./docs/runtime-strategy.md)，Pi 上游索引见 [`upstream/pi/SOURCES.md`](./upstream/pi/SOURCES.md)。

## Agent Operations

Herdr 是 P3 选定的 coding worker 执行现场。

Glassbox 和 Herdr 双向通信：

```text
Glassbox → Herdr
  看 session / workspace / worktree
  创建或打开 worktree
  启动 coding Agent
  发任务
  等待状态
  读取结果
  在明确授权下继续或取消

Herdr → Glassbox
  workspace / worktree / pane 变化
  Agent working
  Agent blocked
  Agent done
  worker 消失或被替换
  连接断开 / 恢复
```

但是 Herdr 的状态不能直接替代 Glassbox Task 状态。

```text
Herdr agent = done
≠
Glassbox Task = DONE
```

正常路径是：

```text
Herdr done
→ Task = REVIEW
→ 主 Agent / 人验收
→ ACCEPT → DONE
或
→ REWORK → 新的 TaskAttempt
```

P3 增加这些核心对象：

```text
AttentionItem
Task
TaskAttempt
WorkerBinding
AgentOpsSnapshot
```

主 Agent 可以通过 `AgentOpsSnapshot` 快速知道：

```text
多少消息没回答
多少 Task open
多少正在 running
多少 worker blocked
多少结果等 review
多少 approval 等处理
```

需要细节时再调用 Ops Tools，例如：

```text
ops_status
task_list
task_get
task_create
task_delegate
worker_status
worker_read
worker_prompt
task_accept
task_rework
task_cancel
```

这些也是受保护的 Glassbox Actions。QQ 用户不能因为主 Agent 能控制 Herdr，就自动获得读取任意 pane、停止任意 Agent、删除 worktree 或访问其他 Task 结果的权限。

Herdr 长连接集成走本地 socket API。启动或重连时遵守：

```text
events.subscribe
→ 等订阅 ACK
→ session.snapshot
→ 和 Turso 中的 WorkerBinding / TaskAttempt 对账
→ 再持续消费事件
```

监控断开不能被解释成任务成功或失败。

`aorumbayev/herdr-workflows` 可以跑短的线性阶段，例如：

```text
implement
→ test
→ review command
```

但 Task 是否验收、是否返工、过去的 TaskAttempt 历史，仍然由 Glassbox 管。

完整规则见 [`docs/agent-operations.md`](./docs/agent-operations.md)，上游索引见 [`upstream/herdr/SOURCES.md`](./upstream/herdr/SOURCES.md)。

## 权限是 P0

权限不能靠 Prompt。

每一次受保护操作必须能回答：

```text
Who
  谁在操作

Where
  在哪个 Channel、私聊或群聊、哪个 Conversation

What
  要执行什么 Action

How
  通过哪个 Runtime、Tool、Worker、Operation

Resource
  涉及哪个受保护资源

Audience
  结果准备发给谁

Conversation / Run
  属于哪一次会话和执行
```

Authorization 只有：

```text
ALLOW
DENY
REQUIRES_APPROVAL
```

没有明确授权就是 `DENY`。

P3 有四道不可绕过的服务端硬阀门。

### Ingress Gate

消息进入 Pi 之前检查身份、Channel、群、激活状态、重复事件以及调用 Agent 的权限。

### Context Gate

调用 `session.prompt(...)` 之前过滤受保护数据。未授权内容不能先进入模型，再靠 Prompt 要求模型保密。

### Tool Gate

每个受保护 Tool 或 Ops Action 在真正执行前重新鉴权。Lora PI Kit 可以使用 Pi `tool_call` hook 做阻断桥接，但 Glassbox Authorization Engine 才是权限源。

QQ Runtime 使用显式 Tool allowlist。P3 不向远程 QQ 开放 unrestricted `bash`、`powershell` 或 unrestricted Herdr terminal control。

### Delivery Gate

结果离开 Glassbox 发往 QQ 前再次检查 Audience。

```text
Owner 有权读取私人数据
≠
Owner 有权把私人数据发送到整个 QQ 群
```

Worker output 和 Task result 也不能绕过 Delivery Gate。

## Conversation

私聊和群聊不能共用“Conversation 一定属于一个 userId”的假设。

P3 使用 scope-based Conversation：

```text
Conversation
  id
  agentId
  channel
  scopeType
  scopeKey
```

例如：

```text
QQ 私聊
  scopeType = direct
  scopeKey = qq:user:<qq-id>

QQ 群聊
  scopeType = group
  scopeKey = qq:group:<group-id>
```

群 Conversation 可以由多人共享，但每一个 Run 都记录真实 Principal。

保持这些边界：

```text
ChannelIdentity ≠ User
User ≠ Principal
Conversation ≠ Principal
Conversation ≠ Pi Session
Pi Session ≠ Run
Task ≠ Run
Task ≠ Worker
TaskAttempt ≠ Herdr pane
Herdr Agent state ≠ Task acceptance
Actor permission ≠ Delivery permission
```

## 测试环境

P3 使用自动化测试和真实集成验收。

### 自动化环境

不依赖真实 QQ，也不消耗真实模型额度：

```text
Fake OneBot Gateway
Fake Owner
Fake Visitor
Fake Group
Disposable Turso / SQLite
isolated Pi agentDir
Lora PI Kit test preset
recording / deterministic fake model
FakeHerdrBridge
deterministic Herdr event fixtures
synthetic protected resources
Raw Trace capture
```

测试 Pi 必须使用独立目录。Herdr domain tests 默认使用 `FakeHerdrBridge`，协议测试使用专门的 disposable Herdr session 和测试仓库。

```text
.glassbox-test/
  pi/
    settings.json
    models.json
    skills/
    extensions/
    sessions/
  db/
    p3-test.db
  fixtures/
    users.json
    groups.json
    resources.json
    onebot-events/
    herdr-events/
  worktrees/
  traces/
```

不得写入用户正常的 `~/.pi/agent`、真实 Personal Agent 状态、生产 QQ 会话、生产 Herdr workspace 或真实可写用户仓库。

### 真实 QQ + Herdr 验收环境

准备：

```text
Bot QQ
Owner QQ
Visitor QQ
Test QQ Group
  Bot
  Owner
  Visitor

Dedicated Herdr test session
Disposable test repo / worktree
At least one real supported coding Agent
```

真实验收检查 NapCat 登录、OneBot 事件、私聊、群聊 `@bot`、群回复、Pi 执行、Herdr task delegation、working / blocked / done、review / rework、重连、重启和最终 Delivery。

## 从本地测试到服务器

现在可以在本机跑测试，但生产目标是 Linux Server。

目标形态：

```text
Linux Server
├── Glassbox server
├── Pi SDK + Lora PI Kit
├── NapCat
├── Herdr session server
├── coding Agents / worktrees
└── Turso-compatible durable state
```

Glassbox 和 Herdr 在同一主机时走本地 control boundary。以后你可以通过 SSH 远程进入。Moshi 可以作为 Herdr 的远程观察和人工介入客户端，但 Glassbox 的正确性不能依赖 Moshi、桌面 GUI 或 Herdr sidebar 状态。

本地和服务器使用同一套：

```text
Task
TaskAttempt
AttentionItem
WorkerBinding
HerdrBridge
OpsReconciler
Authorization
Trace
```

## Canary 安全测试

Owner Private Resource 放入唯一测试字符串：

```text
PRIVATE_CANARY_7F92A1
```

自动测试主动尝试通过这些路径套取：

```text
Visitor 私聊
Visitor 群聊
Owner 群聊
Prompt Injection
Tool 间接读取
unauthorized worker_read
Herdr worker result
伪造 identity
stale authorization
Revoke 后继续访问
跨 Conversation 复用
跨群复用
Delivery Gate 绕过
```

如果 canary 出现在任何未授权的 Pi Context、Tool Result、Worker Result、QQ 输出、公开 Trace 或 denial 文本里，P3 失败。

## 当前已经实现

现有仓库已经证明了 Coding Agent 执行和观察闭环：

- Codex Provider Adapter
- Claude Code Provider Adapter
- Session 和多 Turn 执行
- HTTP 和 WebSocket Runtime
- Raw Trace、Replay 和 Derived State
- Approval
- Secret Screening
- Real repo 运行和文件变化检查
- Editable Task 和 Editable System Instruction
- Token Usage
- tldraw Canvas Projection
- Inspector
- Playwright E2E
- 大 Session 性能验证

这些能力不会推倒重来。当前 P3 会在它们之上接入 Pi SDK、Lora PI Kit、硬权限、Turso Conversation、QQ Channel 和 Herdr Agent Operations。

## P3 当前要完成

```text
Test harness
Lora PI Kit MVP
Pi SDK Runtime
Identity / Authorization
Ingress / Context / Tool / Delivery Gates
scope-based Conversation
Turso durable state
Attention Queue
Task Registry
TaskAttempt
WorkerBinding
AgentOpsSnapshot
HerdrBridge
Herdr events + snapshot reconciliation
Ops Tools
review / rework / accept
NapCat / OneBot Channel
QQ private chat
QQ group chat
message dedupe
restart / reconnect
Trace
real QQ + Herdr acceptance
```

## 后续能力

P3 完成后先进入：

```text
Feedback Ledger
Taste learning
Taste confidence + global/project scope
Task-aware Taste retrieval
Semantic Memory
Episodic Memory
Authorized retrieval
```

再继续：

```text
Mail / Calendar
additional Channels
full Durable LongTask / DAG / checkpoints / retry policy
AGY Worker
Efficient Runtime
Execution Routing
Eval Workbench
Skill evolution
Asset Library
Journal / Monthly Review
Arena
Documentation Learning Site implementation
```

## Rules / Skills / Taste / Memory

Glassbox 不把所有长期信息都叫 Memory。

稳定分层是：

```text
Rules
  硬约束、明确要求、权限和项目规则

Skills
  可复用、可验证的做事流程

Taste
  从长期行为里学到的个人偏好

Memory
  关于事实、决策、事件和过去工作的长期知识
```

保持：

```text
Rules ≠ Skills ≠ Taste ≠ Memory
```

Taste 重点观察：

```text
accept
reject
edit
revert
反复纠正
明确正向反馈
明确负向反馈
```

一次修改只是一条 Evidence，不能直接成为永久偏好。

Taste 至少有两层 Scope：

```text
global
  个人长期偏好

project
  当前项目特有偏好
```

每个被晋升的 Taste 都要有 confidence、支持/反向 evidence、时间和 provenance。

当前任务只检索相关 Taste，不把所有偏好塞进模型。

例如 React + TypeScript 任务只需要相关的 React、TypeScript、Frontend Architecture、Testing 偏好，不需要同时注入 Python、CLI、Database 的 Taste。

Taste 的长期真相存在 Glassbox / Turso。

Lora PI Kit 可以负责把相关 Taste 注入 Pi、转发可用 Feedback Signal，但不能成为 Taste 数据库。以后 Codex、Claude Code 等 Runtime 应该复用同一份 Glassbox Taste。

Memory 保留至少两类：

```text
Semantic Memory
  事实、决策、关系、长期项目知识

Episodic Memory
  有意义的历史 Run / Task / Conversation / 失败 / 结果
```

如果一段 Procedural Knowledge 已经稳定成可复用、可验证的流程，应该晋升成 Skill，而不是继续塞在泛化 Memory 里。

学习闭环：

```text
Agent 输出
↓
用户行为
↓
FeedbackEvent
↓
TasteCandidate
↓
confidence + scope 更新
↓
按当前任务检索相关 Taste
↓
Runtime Context
↓
下一次执行
```

Memory Retrieval 和 Taste Retrieval 都必须先做 Authorization Scope，再进入模型可见 Context。

P4 不只看“存了多少 Memory”，而要测它有没有减少用户纠正：

```text
Correction Rate
Revert Rate
Taste Hit Rate
Preference Compliance
False Preference Rate
Scope Leakage Rate
```

完整设计见 [`docs/memory-taste.md`](./docs/memory-taste.md)。Command Code 的 Taste 思路作为参考，见 [`upstream/command-code/SOURCES.md`](./upstream/command-code/SOURCES.md)。

## Learning and Asset Loop

Glassbox 不会把所有聊天记录直接塞进 Memory，也不会因为一次成功执行就自动生成永久 Skill 或永久 Taste。

目标链路：

```text
Real Work
   ↓
Run / Task / Raw Trace / Feedback
   ↓
Experience Mining
   ├── Taste Candidate
   ├── Memory Candidate
   ├── Skill Candidate
   └── Asset Candidate
             ↓
 Scope + Confidence + Value + Permission + Dedup
             ↓
      Eval / Verification
             ↓
           Promote
             ↓
 Taste / Memory / Skills / Assets
```

每一个高价值 Taste、Memory、Validated Skill、Asset、Journal 或 Review 都应该能回到产生它的 Feedback、Run、Task 和 Trace。

## Skill evolution

目标流程：

```text
Successful Runs / Tasks
      ↓
Skill Candidate
      ↓
Deduplicate / Merge
      ↓
Extract Procedure + Preconditions + Failure Modes
      ↓
Generate Eval Cases
      ↓
Verify
      ↓
Validated Skill
```

主要参考：

- `AMAP-ML/SkillClaw`
- `Zhang-Henry/CoEvoSkills`
- `MineDojo/Voyager`

验证通过且属于通用 Pi 工作流的 Skill，可以进入 `lora-sys/skills` 或由 Lora PI Kit 选择安装。涉及 Glassbox 权限、产品状态或证据语义的逻辑留在 Glassbox。

## Journal 和周期复盘

Agent 会有自己的可读 Journal，但 Journal 不是模型私有思维过程。

Daily Journal 和 Monthly Review 都应该是正式 Run / Task 产生的可追溯 Asset。

主要参考：

- `joonspk-research/generative_agents`
- `usememos/memos`

## Mail 和 Calendar

Mail 和 Calendar 后续作为原生 Domain，而不是给模型 unrestricted MCP。

Mail 参考 `resend/resend-skills`。

Calendar 参考 `calcom/cal.diy`。

两者默认都是 Private Resource。

## LongTask

P3 已经建立最小的 Task / TaskAttempt / WorkerBinding 基础。

后续 LongTask 在这个基础上增加：

```text
steps
dependency DAG
event history
checkpoint
retry policy
waiting
signal
child task
worker job
cancellation
continuation
lease / heartbeat
restart recovery
```

主要参考 `temporalio/sdk-typescript`。

## Efficient Agent Runtime

P3 先完成可用闭环。更复杂的效率层放到后续阶段。

`TokenRhythm/opensquilla` 是主要参考，后续研究：

```text
Context Budget Governor
Tool Result Budget
Tool Result Projection
Token Estimation
Hybrid Retrieval
Execution Routing
Thinking-depth selection
Prompt / Context compression policy
Duplicate retrieval prevention
Routing observability
```

Router 可以决定怎样更省或更强，不能改变 Principal，也不能扩大授权范围。

属于通用 Pi 工作流的效率机制优先进入 Lora PI Kit。涉及受保护 Context、Task truth、Taste / Memory truth、产品级 Routing Policy、权限范围、Audience 或证据语义的机制继续由 Glassbox 控制。

## Eval 和实验工作台

以后可以比较：

```text
Glassbox + Pi + Lora PI Kit
Herdr-managed Pi worker
Codex
Claude Code
AGY
```

第一阶段 Eval 类型：

```text
Benchmark
Differential Eval
Invariant Eval
Taste Eval
Task / Worker Eval
```

主要参考 `UKGovernmentBEIS/inspect_ai`。

## Arena

后续可以把 Agent 放进多人游戏、协作和社交模拟环境。每局仍然是可追溯 Run，也受 Glassbox Authorization 控制。

主要参考：

- `google-deepmind/open_spiel`
- `sotopia-lab/sotopia`

## Canvas 的位置

Canvas 保留，但不再定义整个产品。

```text
Raw Trace
→ Derived State
→ Canvas Objects
→ tldraw projection
```

移动、连接、分组、缩放和批注不能暗中改变 Agent 执行、Task 状态和权限。

## 文档站与交互式学习

Glassbox 计划有独立的公开文档与学习站。

每个重要概念尽量按下面路径组织：

```text
Explain
→ Visualize
→ Manipulate
→ Observe State Transition
→ Inspect Evidence
→ Link to Real Implementation
```

能力必须标记：

```text
Implemented
Experimental
Planned
```

P3 完成后，第一批真实概念可以覆盖：

```text
Owner vs Visitor
Private vs Group Audience
Permission vs Approval
Authorize Before Context
Tool Gate
Delivery Gate
Conversation vs Pi Session vs Run
Task vs TaskAttempt vs Run
Attention Queue
Herdr state vs Task acceptance
Review / Rework
Raw Trace → Derived State → Canvas
```

P4 再加入：

```text
Rules vs Skills vs Taste vs Memory
Taste confidence
Global vs Project scope
Feedback → Taste Candidate
Task-aware Taste Retrieval
Authorized Memory Retrieval
```

完整站点规范见 [`docs/README.md`](./docs/README.md)，交互 Demo 课程表见 [`docs/interactive-demos.md`](./docs/interactive-demos.md)。

## 上游参考

成熟项目已经解决好的机制优先研究和复用。`upstream/` 保存选择性的只读参考代码，生产代码不能直接 import。

| 上游 | 主要参考 |
| --- | --- |
| `earendil-works/pi` | 主 Agent Runtime、SDK、Packages、Extensions、Skills、Tools |
| `herdrdev/herdr` | Agent Operations、workspace/worktree/pane、coding Agent lifecycle、socket API、snapshot/event reconciliation |
| `aorumbayev/herdr-workflows` | Herdr 内短线性阶段流程，不作为 Task 真相 |
| `NapNeko/NapCatQQ` | QQ Runtime、OneBot 接入 |
| `botuniverse/onebot-11` | OneBot 11 事件和 API Contract |
| `CommandCodeAI/command-code` | Taste：accept/reject/edit 信号、global/project scope、持续偏好学习 |
| `pingdotgg/t3code` | Claude Code、权限、Resume |
| `HKUDS/OpenHarness` | Agent Loop、Tools、Skills、Memory、Channels、QQ |
| `keli-wen/agy-staff` | AGY Worker、后台 Job、Continue、Restart |
| `TokenRhythm/opensquilla` | Context Budget、Tool Result Budget、Hybrid Retrieval、Routing |
| `Javis603/token-monitor` | Runtime 发现、Token/Cost、Quota、Health |
| `joyehuang/trajectory-panel` | Trajectory、Timeline、Redaction、Turso Sync |
| `UKGovernmentBEIS/inspect_ai` | Eval、Dataset、Scorer、Experiment Runner |
| `temporalio/sdk-typescript` | Durable LongTask |
| `tursodatabase/turso` | Structured Agent State |
| `openfga/openfga` | Fine-grained Authorization |
| `zhibao-dev/Learning-Multi-Factor-Memory` | Memory Value、Forgetting、Hygiene |
| `langchain-ai/langmem` | Memory Types、Consolidation |
| `AMAP-ML/SkillClaw` | Skill Evolution |
| `Zhang-Henry/CoEvoSkills` | Skill Verification |
| `MineDojo/Voyager` | Skill Library |
| `joonspk-research/generative_agents` | Reflection |
| `usememos/memos` | Journal UX |
| `resend/resend-skills` | Agent Email |
| `calcom/cal.diy` | Calendar / Scheduling |
| `dagster-io/dagster` | Asset / Lineage |
| `google-deepmind/open_spiel` | Multi-player Games |
| `sotopia-lab/sotopia` | Social Multi-Agent Environment |

Vendoring 时必须记录 Source Repo、Commit、License、原始路径和复制原因，并保留上游要求的版权与 License Notice。

## 仓库结构

```text
apps/
  server/        Runtime、Channel、Authorization、Task/Ops、Trace、State、WebSocket
  web/           React + tldraw Workbench
    e2e/         浏览器回归测试

packages/
  contracts/     真正跨边界时才放 Contract
  shared/        小而稳定的共享工具

.plans/
  03-personal-agent-foundation.md
  roadmap.md
  findings/

docs/
  README.md
  runtime-strategy.md
  agent-operations.md
  memory-taste.md
  tech-stack.md
  data-observability.md
  interactive-demos.md

assets/
  readme/

upstream/
  pi/
  herdr/
  command-code/
  t3-code/
  opensquilla/
  token-monitor/
```

Lora PI Kit 在 P3.1 开始时创建为独立仓库。不要把 Pi Core 复制进 Glassbox，也不要把 QQ Transport、Authorization、Task state、Taste/Memory truth 或 Turso 塞进 Lora PI Kit。

## 开始开发

要求 Node.js `>=22.18.0`。

安装：

```bash
npm install
```

启动 Runtime：

```bash
npm run dev:server
```

另一个终端启动 Web：

```bash
npm run dev:web
```

运行当前 Server 测试：

```bash
npm run test:server
```

开发时只运行当前任务需要的测试。P3 自动验收优先使用 Fake OneBot、Fake identities、isolated Pi agentDir、FakeHerdrBridge 和 disposable Turso。

开发环境客户端通过相对路径 `/api` 和 `/ws` 访问 Runtime。不要把机器专属路径写进产品状态。

## Agent 开工顺序

如果你是进入这个仓库工作的 Coding Agent，按这个顺序读：

1. `AGENTS.md`
2. `.plans/03-personal-agent-foundation.md`
3. 改 Runtime 方向时读 `docs/runtime-strategy.md`
4. 改 Task / Herdr / worker / Ops 时读 `docs/agent-operations.md`
5. 改 Rules / Skills / Taste / Feedback / Memory / Retrieval 时读 `docs/memory-taste.md`
6. 改工具链时读 `docs/tech-stack.md`
7. 当前任务相关的 `.plans/findings/`
8. 相关 `upstream/` 或上游项目
9. 当前实现和 focused tests

不要从旧 Git 历史恢复已经被新 P3 取代的旧 Plan 语义。

## 当前状态

当前唯一目标是完成 P3 的 QQ Personal Agent + Agent Operations Closed Loop。

现在不把“基础模块写完”当成完成。真正完成意味着：

```text
真实 QQ 私聊可用
真实 QQ 群聊可用
Pi SDK + Lora PI Kit 真正执行
Owner / Visitor 身份正确
四道硬权限阀门生效
私人数据无法通过群聊或 worker 泄露
Conversation 重启恢复
QQ 重复事件不会重复回复
NapCat 重连后继续工作
主 Agent 能看到 Task / Attention / worker 总状态
能把真实 Task 派给 Herdr coding Agent
能观察 working / blocked / done
worker done 后进入 REVIEW 而不是自动 DONE
能验收和返工
Herdr 重连后 snapshot 对账恢复状态
Glassbox 重启后 Task / TaskAttempt / WorkerBinding 不丢
Trace 可以解释整条执行链和 Task 生命周期
```

P3 完成后进入 `P4 — Memory, Taste and Authorized Retrieval`，先建立 Feedback/Taste 学习，再接 Semantic / Episodic Memory 和授权检索。之后再进入更多 Channel、完整 Durable LongTask、Eval 和效率层。

## License

MIT. See [`LICENSE`](./LICENSE).
