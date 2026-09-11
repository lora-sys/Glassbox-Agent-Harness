# Glassbox

![Glassbox Personal Agent：把每一次对话变成更好的自己](./assets/readme/glassbox-hero.png)

Glassbox 是一个正在演进中的 Personal Agent 工作台。

目标是让你拥有一个长期存在的 Agent。你在 Workbench 里管理它、使用它、检查它做过什么、为什么这样做、学到了什么。以后其他人可以通过微信、QQ 等渠道访问这个 Agent，但只能看到和使用你明确授权的部分。

**权限是第一原则。** Channel 只是入口，Canvas 只是工作视图。真正的核心是 Agent Runtime、Identity、Authorization、Conversation、Memory、LongTask、Trace、Eval 和持续沉淀的个人资产。

> 当前代码仍然主要是本地 Coding Agent Harness。README 会明确区分已经实现的能力和目标架构，不把未来功能写成现状。

## 当前开发阶段

当前唯一 Active Plan：[`Plan 03 — Personal Agent Foundation`](./.plans/03-personal-agent-foundation.md)

长期阶段顺序记录在 [`.plans/roadmap.md`](./.plans/roadmap.md)。文档站与交互式学习规范记录在 [`docs/`](./docs/README.md)。这些不是当前 P3 的额外实现要求。

![Plan 03：身份、权限、会话、持久化与执行证据闭环](./assets/readme/glassbox-p3-architecture.png)

这一阶段只做地基：

```text
Identity
  ↓
Authorization
  ↓
Conversation
  ↓
Turso persistence
  ↓
Run / Authorization Trace
```

完成 Plan 03 之前，不抢跑真实微信、QQ、Mail、Calendar、Memory 自动沉淀、Skill evolution、AGY、LongTask、Eval、Arena、智能路由或完整向量检索。

这一阶段的验收标准很直接：

> 同一个 Agent 可以同时服务 Owner 和 Visitor。两个人的 Conversation 可以持久恢复。公开资源两个人都能用，Owner 私有资源 Visitor 永远拿不到，并且每一次 Allow、Deny、Approval 都可以在 Trace 里解释。

## 产品目标

目标系统只有一个长期存在的 Personal Agent。

```text
Workbench / 微信 / QQ / Email
             │
             ▼
      Identity Resolution
             │
             ▼
        Authorization
             │
             ▼
   Conversation + Personal Agent
             │
    ┌────────┼────────┐
    │        │        │
  Tools    Workers  LongTask
    │        │
    │      AGY / Codex / Claude Code
    │
    └────────┼───────────────┐
             ▼               │
            Run              │
             ▼               │
      Raw Trace / Evidence   │
             ▼               │
      Experience Mining ◀────┘
             ▼
   Memory / Skills / Assets
             ▼
 Journal / Review / Eval
```

微信 Bot、QQ Bot、Workbench 都只是入口，不是不同 Agent。

Codex、Claude Code、AGY、OpenHarness 等属于 Provider、Worker 或专业执行能力，也不是产品身份本身。

## 权限是 P0

Personal Agent 对外开放以后，最危险的问题不是答错，而是越权。

所有受保护操作都要先落到：

```text
Principal × Resource × Action × Context → Decision
```

Decision 只有：

```text
ALLOW
DENY
REQUIRES_APPROVAL
```

没有明确授权就是 `DENY`。

必须遵守这些规则：

- 身份识别不等于授权
- 先授权，再组 Context
- 未授权数据不能先进入模型，再靠 Prompt 要求模型保密
- Tool 执行时再次做授权判断
- 外部消息、邮件、网页、MCP、Worker 输出全部视为不可信输入
- Worker 权限只能缩小，不能比调用者更大
- Approval 不能替代 Permission
- Grant、Revoke、Deny、Approval 都进入可审计 Trace
- 自动沉淀 Memory、Skill、Asset 不能扩大原始数据的可见范围

目标权限关系参考 `openfga/openfga`，但核心 Domain 保持在 Glassbox 自己的 TypeScript 代码中。

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

这些能力不会推倒重来。它们会逐步成为 Personal Agent Runtime 的执行和观察底座。

目前还没有完成的目标能力包括：

```text
Identity / Authorization Domain
Turso durable state
Conversation Domain
Remote Channels
Memory promotion
Authorized hybrid retrieval
Skill evolution
Asset Library
Journal / Monthly Review
Mail / Calendar
AGY Worker
LongTask Engine
Efficient Agent Runtime
Execution Routing
Eval Workbench
Arena
Documentation Learning Site
```

## 核心对象

长期模型会围绕这些概念演进：

```text
Agent
User
Principal
ChannelIdentity
Relationship
Permission
Conversation
Memory
Skill
Asset
Tool
Session
Run
WorkerJob
LongTask
JournalEntry
Experiment
EvalSuite
EvalRun
```

几个边界必须保持清楚：

```text
Identity ≠ Authorization
Permission ≠ Approval
Channel ≠ Agent
Conversation ≠ Session
Session ≠ Run
LongTask ≠ Run
WorkerJob ≠ LongTask
Provider / Worker ≠ Personal Agent
Raw Trace ≠ Derived State
Canvas ≠ Execution State
```

## Learning and Asset Loop

Glassbox 不希望把所有聊天记录都塞进 Memory，也不希望模型成功一次就自动生成永久 Skill。

真正的成长链是：

```text
Real Work
   │
   ▼
Raw Trace
   │
   ▼
Experience Mining
   │
   ├── Memory Candidate
   ├── Skill Candidate
   └── Asset Candidate
             │
             ▼
 Value + Permission + Dedup
             │
             ▼
      Eval / Verification
             │
             ▼
           Promote
             │
    ┌────────┼────────┐
    │        │        │
 Memory    Skills   Asset Library
```

每一个高价值 Memory、Validated Skill、Asset、Journal 或 Monthly Review 都应该能回到产生它的 Run 和 Trace。

## Memory

Memory 计划区分：

```text
Semantic Memory
Episodic Memory
Procedural Memory
```

并且至少支持：

```text
private
public
user
conversation
```

Memory Candidate 会考虑 future utility、goal relevance、reliability、reuse、novelty、staleness、contradiction 和 privacy risk，再决定是否晋升。

Retrieval 以后会在授权范围内组合 lexical search、vector search、source weighting、temporal decay、diversity reranking 和 context budget。权限过滤发生在受保护内容进入模型可见检索结果之前。

主要参考：

- `zhibao-dev/Learning-Multi-Factor-Memory`
- `langchain-ai/langmem`
- `TokenRhythm/opensquilla`

## Skill evolution

Skill 的目标流程：

```text
Successful Runs
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

## Journal 和周期复盘

Agent 会有自己的可读 Journal，但 Journal 不是模型私有思维过程。

Daily Journal 和 Monthly Review 都应该是正式 Run 产生的可追溯 Asset，可以下钻到真实 Run、Eval 和 Trace。

主要参考：

- `joonspk-research/generative_agents`
- `usememos/memos`

## Mail 和 Calendar

Mail 和 Calendar 计划作为原生 Domain，而不是给模型 unrestricted MCP。

Mail 参考 `resend/resend-skills` 的 Agent inbox、安全 Webhook 和 Approval 模式。

Calendar 参考 `calcom/cal.diy` 的 Availability、Scheduling 和冲突处理。

两者默认都是 Private Resource。

## LongTask

长任务不能依赖一个 HTTP 请求或者一个进程一直活着。

目标语义包括：

```text
stable task id
steps
event history
checkpoint
retry
waiting
signal
child task
worker job
cancellation
continuation
```

主要参考 `temporalio/sdk-typescript`。

## Efficient Agent Runtime

权限和持久化地基完成以后，Glassbox 还需要一层可测量的运行效率系统。

`TokenRhythm/opensquilla` 是这一层的重要上游参考，重点研究：

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

Glassbox 的 Router 最终不应该只返回一个模型名，而应该返回明确的执行策略：

```text
ExecutionPolicy
  modelTier
  provider
  model
  thinkingLevel
  promptPolicy
  contextBudget
  retrievalBudget
  toolBudget
  workerPolicy
  ensemblePolicy
  costCeiling
```

Router 可以决定怎样更省或更强，不能改变 Principal，也不能扩大授权范围。

Tool Result 可以为模型生成压缩投影，但完整 Raw Trace 和证据不能因此被删除。

这一层必须用 Eval 证明价值，例如比较 Router 开关前后的任务成功率、权限 invariant、Token、Cost 和 Latency，而不是只声称“更省 Token”。具体顺序见 [`.plans/roadmap.md`](./.plans/roadmap.md)，源码索引见 [`upstream/opensquilla/SOURCES.md`](./upstream/opensquilla/SOURCES.md)。

## Eval 和实验工作台

以后可以直接告诉 Agent：

```text
测一下当前 Agent 的 GitHub repo 分析能力。
用 100 条任务。
比较当前版本、Codex、Claude Code 和 AGY。
每个样本跑 3 次。
检查任务成功率、权限 invariant、成本和延迟。
```

Agent 先生成 Eval Draft，只有明确 `Start Eval` 才执行。

第一阶段 Eval 类型：

```text
Benchmark
Differential Eval
Invariant Eval
```

主要参考 `UKGovernmentBEIS/inspect_ai`。

## Arena

以后可以把 Agent 放进多人游戏、协作和社交模拟环境。每局都是可追溯 Run，也可以成为 Eval 或 Episodic Memory 来源。

主要参考：

- `google-deepmind/open_spiel`
- `sotopia-lab/sotopia`

Arena 同样受 Glassbox Authorization 控制。

## Canvas 的位置

Canvas 保留，但不再定义整个产品。

可能的工作视图包括：

```text
Conversation
Project
Timeline
Canvas
Trace
Experiment
Memory
Skills
Assets
Journal
Permissions
```

Canvas 是投影。移动、连接、分组、缩放和批注都不能暗中改变 Agent 执行和权限。

## 文档站与交互式学习

Glassbox 计划有一个独立的公开文档与学习站，目标不是把 README 搬到网页上，而是让别人真正理解关键概念。

每个重要概念尽量按下面的学习路径组织：

```text
Explain
→ Visualize
→ Manipulate
→ Observe State Transition
→ Inspect Evidence
→ Link to Real Implementation
```

文档页面必须明确标注：

```text
Implemented
Experimental
Planned
```

第一批交互 Demo 会围绕 P3 的真实概念：

```text
Owner vs Visitor
Permission vs Approval
Authorize Before Context
Conversation vs Session vs Run
Raw Trace → Derived State → Canvas
```

后续再加入 Memory Retrieval Lab、Context Budget Simulator、Tool Result Projection、Execution Routing Lab、Router Eval 和 LongTask State Machine。

公开 Demo 默认使用 synthetic deterministic fixtures，不读取真实 Personal Agent Memory、私人 Conversation、生产凭证或私有 Trace。

完整站点规范见 [`docs/README.md`](./docs/README.md)，交互 Demo 课程表见 [`docs/interactive-demos.md`](./docs/interactive-demos.md)。

## 上游参考

成熟项目已经解决好的机制优先研究和复用。`upstream/` 保存选择性的只读参考代码，生产代码不能直接 import。

| 上游 | 主要参考 |
| --- | --- |
| `pingdotgg/t3code` | Provider、Claude Code、权限、Resume |
| `HKUDS/OpenHarness` | Agent Loop、Tools、Skills、Memory、Channels、QQ |
| `keli-wen/agy-staff` | AGY Worker、后台 Job、Continue、Restart |
| `TokenRhythm/opensquilla` | Context Budget、Tool Result Budget、Hybrid Retrieval、Routing、Token-efficient Projection |
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
  server/        当前 Runtime、Provider、Trace、State、WebSocket
  web/           当前 React + tldraw Workbench
    e2e/         历史与现行浏览器回归测试

packages/
  contracts/     真正跨边界时才放 Contract
  shared/        小而稳定的共享工具

.plans/
  03-personal-agent-foundation.md
  roadmap.md
  findings/

docs/
  README.md
  interactive-demos.md

assets/
  readme/

upstream/
  t3-code/
  opensquilla/
```

不要为了未来架构提前创建空 package。文档站真正开始实现以前也不提前创建 `apps/docs`。

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

现有 `apps/web/e2e/` 中包含一些需要真实 Provider、预置 Session 或历史 Fixture 的回归脚本。不要把全量 E2E 当成每个改动的默认检查。新 Phase 3 测试优先使用 Fake Channel、Fake Tool 和 disposable Turso database。

开发环境的客户端通过相对路径 `/api` 和 `/ws` 访问 Runtime。不要把新的绝对开发路径或机器专属目录写进代码。

## Agent 开工顺序

如果你是进入这个仓库工作的 Coding Agent，按这个顺序读：

1. `AGENTS.md`
2. `.plans/03-personal-agent-foundation.md`
3. 当前任务相关的 `.plans/findings/`
4. 相关 `upstream/` 或上游项目
5. 当前实现和 focused tests

不要从旧 Git 历史恢复已经删除的 Plan、Ticket、Template 或 debug 文件，除非当前问题确实需要它们。

## 当前状态

Glassbox 还很早，但方向已经收口。

下一步不是继续扩 Canvas，也不是同时接十个聊天渠道。现在只做一个可证明的 Personal Agent Foundation：**身份明确、权限分明、Conversation 可持久恢复、Turso 保存长期状态、所有授权决策可追溯。**

这层正确以后，再让真实 Channel、Memory、Retrieval、Mail、Calendar、Skill、LongTask、Efficient Runtime、Eval 和 Arena 逐层接进来。文档与交互式学习可以先做信息架构和设计，但不能把计划能力写成已实现。

## License

MIT. See [`LICENSE`](./LICENSE).
