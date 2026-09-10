# Glassbox

<p align="center">
  <img src="./assets/readme/hero-v1.webp" width="100%" alt="Glassbox personal agent workbench with inspectable runs, permissions, memory, experiments, and long-running tasks" />
</p>

Glassbox 正在从本地 Coding Agent 观察与控制工作台，演进成一个长期存在的 Personal Agent 工作台。

目标是拥有一个真正长期存在的 Agent。Owner 在 Glassbox 里管理它、使用它、检查它的工作和成长。其他人可以通过微信、QQ 等聊天渠道访问这个 Agent，但只能看到和使用 Owner 明确授权的部分。

Channel 只是入口。Canvas 只是工作视图。核心是 Agent Runtime、Identity、Authorization、Memory、Skills、Assets、LongTask、Trace 和 Eval。

> 当前仓库还没有完成下面所有目标能力。本文明确区分现有能力和目标架构。

## 产品目标

```text
                   Personal Agent
                         │
        ┌────────────────┼────────────────┐
        │                │                │
     Memory            Skills           Assets
        │                │                │
        └────────────────┼────────────────┘
                         │
                 Authorization
                         │
                 Agent Runtime
                         │
        ┌────────────────┼────────────────┐
        │                │                │
      Tools          LongTasks         Workers
        │                                 │
 GitHub / Mail /                    Codex / Claude
 Calendar / MCP                     Code / AGY
                         │
             ┌───────────┼───────────┐
             │           │           │
         Workbench      微信         QQ
                         │
                         ▼
                Run / Raw Trace
                         │
          ┌──────────────┼──────────────┐
          │              │              │
       Timeline        Canvas        Experiment
```

这里始终只有一个 Personal Agent。

微信 Bot、QQ Bot 和 Workbench 都只是不同入口。Codex、Claude Code、AGY 和其他执行 Agent 是 Provider 或 Worker，不是产品身份本身。

## 当前已经实现

当前代码仍然以本地 Coding Agent 工作台为主，已有：

- Codex 和 Claude Code Provider Adapter
- Session 和多 Turn 执行
- HTTP 和 WebSocket Runtime
- Raw Trace、Replay 和 Derived State
- Approval 流程
- Secret Screening
- Real repo 运行和文件变更检查
- Editable Task 和 Editable System Instruction
- Token Usage 统计
- tldraw Canvas Projection 和 Inspector
- Playwright E2E
- 大型 Session 性能验证

这些能力会保留，并逐步成为 Personal Agent Runtime 的基础。

AGY、微信、QQ、Turso、LongTask Engine、Learning Loop、Asset Library 和 Eval Runner 目前属于目标能力，不要把它们写成已经实现。

## 权限是第一原则

Personal Agent 对外开放以后，最重要的规则不是模型聪不聪明，而是不能越权。

所有访问都必须先回答一个问题：

```text
Principal
  谁在请求

Resource
  他想访问什么

Action
  他想做什么

Context
  当前渠道、会话、任务和授权条件是什么
```

授权结果只有：

```text
ALLOW
DENY
REQUIRES_APPROVAL
```

默认是 `DENY`。

### 身份和角色

角色只提供默认关系，不直接替代资源授权。

第一版可以有：

```text
Owner / Boss
Trusted User
Member
Visitor
Public
Worker
Service
```

Boss 拥有 Agent，但其他角色获得的权限必须是显式授予的子集。

例如：

```text
Bob
  can read       public assets
  can use        web search
  can use        public research skill
  cannot read    private memory
  cannot read    personal calendar
  cannot send    owner email
  cannot write   owner GitHub
```

### 权限落到资源

Memory、Asset、Conversation、Project、Calendar、Mail、Tool、Skill、LongTask 和 Worker 都应该能独立授权。

```text
Memory #123
  owner: lora
  visibility: private

Asset #456
  visibility: public

Project #789
  viewer: alice

Tool github-read
  allowed: trusted

Tool github-write
  allowed: owner
  approval: required
```

不能只靠 `admin / user / guest` 三个角色解决所有问题。

### 先授权，再组 Context

未经授权的数据不能先交给模型，再要求模型“不要泄露”。

正确路径：

```text
Incoming Message
      │
      ▼
Resolve Principal
      │
      ▼
Authorization Check
      │
      ▼
Authorized Context Builder
      │
      ▼
Personal Agent
```

一个 Visitor 请求 Owner 的私人日历时，Calendar 数据根本不能进入 Prompt 或 Tool Result。

### Tool 和副作用也必须授权

每次 Tool 调用都要根据当前 Principal、Resource、Action 再判断一次。

```text
read public repo       ALLOW
search web             ALLOW
read private calendar  DENY
send owner email       REQUIRES_APPROVAL
write production repo  REQUIRES_APPROVAL
```

外部消息、邮件、网页内容和 Worker 输出都是不可信输入。它们不能通过 Prompt Injection 借用 Personal Agent 的 Owner 权限。

### Worker 不能扩大权限

主 Agent 委派给 Codex、Claude Code、AGY 或其他 Worker 时，只能下发当前任务需要的权限子集。

```text
Personal Agent permission set
        │
        ▼
Delegation Grant
        │
        ▼
Worker permission set
```

Worker 权限必须满足：

```text
worker_permissions ⊆ delegated_permissions ⊆ caller_permissions
```

上游 Worker 默认允许执行某件事，不代表 Glassbox 允许。

### 授权本身也要进入 Trace

关键授权判断必须可审计：

```text
AuthorizationDecision
  principal
  resource
  action
  policy
  decision
  reason
  approvalId
  timestamp
```

发生越权尝试时，Owner 应该能从 Trace 看见请求来自谁、系统拦了什么、依据哪条规则。

权限系统主要参考 `openfga/openfga` 的关系式细粒度授权思想，但核心模型保持在 Glassbox 自己的 TypeScript Domain 中。

## Conversation 和聊天渠道

外部渠道统一进入标准消息模型：

```text
微信 / QQ / 其他渠道
        │
        ▼
   Channel Adapter
        │
        ▼
Identity Resolution
        │
        ▼
Authorization
        │
        ▼
Conversation
        │
        ▼
Personal Agent
```

同一个真实用户可以绑定多个 Channel Identity：

```text
user_123
├── workbench: account_xxx
├── wechat: wx_xxx
└── qq: qq_xxx
```

群聊、私聊和 Thread 必须有明确路由，避免不同用户共享同一份 Conversation 或 User-scoped Memory。

Channel Identity 不能自动提升权限。绑定身份和授予权限是两件事。

## Memory：只沉淀高价值信息

Glassbox 不应该把所有聊天都永久记住。

Memory 分三类：

```text
Semantic Memory
  稳定事实、关系、偏好和知识

Episodic Memory
  有价值的成功、失败和关键经历

Procedural Memory
  以后应该如何处理某类问题
```

Memory 的写入分成即时写入和后台沉淀。后台沉淀更适合做去重、矛盾检查、价值判断和合并。

每条长期 Memory 都应该保留来源：

```text
Memory
  content
  kind
  scope
  value
  confidence

  evidence
    conversationId
    messageId
    runId
    traceEventId

  lastUsedAt
  useCount
  supersedes
  contradictedBy
  expiresAt
```

### Memory Promotion

Memory Candidate 不应该自动晋升。

可以按多个因素评估价值：

```text
futureUtility
goalRelevance
userRelevance
reliability
reuseCount
successfulReuse
novelty
recency

penalties
  contradictionRisk
  staleness
  privacyRisk
  duplication
```

高价值记忆筛选主要参考 `zhibao-dev/Learning-Multi-Factor-Memory`。Memory 类型、后台 consolidation 和 hot-path/background formation 参考 `langchain-ai/langmem`。

## Learning and Asset Loop

Glassbox 的差异不应该只是“Agent 会记忆”和“Agent 会写 Skill”。

真正要做的是一条可审计的成长链：

```text
Real Work
  Conversation / Tool / LongTask / Arena / Eval
        │
        ▼
      Raw Trace
        │
        ▼
 Experience Mining
        │
 ┌──────┼──────────────┐
 │      │              │
Memory Skill          Asset
Candidate Candidate  Candidate
 │      │              │
 └──────┼──────────────┘
        │
Value + Permission + Dedup
        │
        ▼
 Eval / Verification
        │
        ▼
     Promote
        │
 ┌──────┼──────────────┐
 │      │              │
Memory Skills       Asset Library
```

每一次晋升都应该能回到产生它的 Run 和 Trace。

## 自动沉淀 Skill

成功一次不等于 Skill。

目标流程：

```text
Successful Runs
      │
      ▼
Skill Candidate
      │
      ▼
Deduplicate / Merge
      │
      ▼
Extract Preconditions
Procedure
Failure Modes
Examples
      │
      ▼
Generate Eval Cases
      │
      ▼
Verify
      │
      ▼
Validated Skill
```

主要参考：

- `AMAP-ML/SkillClaw`：从真实 Session 自动演化、去重和改进 Skill
- `Zhang-Henry/CoEvoSkills`：Generate、Verify、Refine，以及 Candidate 和 Validated Skill 分离
- `MineDojo/Voyager`：成功经验形成 Skill Library，再按任务检索和复用

Validated Skill 应该记录版本、来源 Runs、验证集、成功复用次数和最近失败证据。

## Agent Journal 和周期复盘

Agent 应该有自己的可读 Journal，但 Journal 不是模型私有思维过程。

Daily Journal 是一个正式 Run 的产物：

```text
Today
  Runs
  Conversations
  Decisions
  Failures
  Open Loops
  New Memories
  Skill Candidates
  New Assets
      │
      ▼
Daily Reflection Run
      │
      ▼
JournalEntry
```

每月再运行一次 Monthly Review：

```text
Daily Journals
+ Memory changes
+ Skill changes
+ Asset changes
+ Eval results
+ LongTask outcomes
+ User feedback
        │
        ▼
Monthly Review Run
        │
        ▼
MonthlyReview Asset
```

复盘里的指标和结论必须能下钻到 Eval、Run 和 Trace。

Reflection 思想参考 `joonspk-research/generative_agents`。时间线式 Journal UI 可以参考 `usememos/memos`。

## 内置 Mail 和 Calendar

Mail 和 Calendar 应该是 Agent 的原生 Domain，不只是临时 MCP Tool。

Mail 第一版考虑：

```text
MailAccount
MailThread
MailMessage
MailContact
Draft
```

Resend 负责发送、接收和 Webhook。安全实现参考 `resend/resend-skills` 的 Agent Email Inbox，包括 Webhook Verification、Sender Allowlist、Sandbox 和 Human Approval。

Calendar 第一版考虑：

```text
Calendar
CalendarEvent
Availability
Reminder
Invite
```

Google Calendar、Microsoft Calendar、CalDAV 等作为 Adapter。Scheduling、Availability 和冲突处理可以参考 `calcom/cal.diy`。

Mail 和 Calendar 默认属于 Private Resource。对外授权必须显式配置到具体资源和 Action。

## Asset Library

Memory 是“Agent 知道什么”。Skill 是“Agent 会怎么做”。Asset 是“Agent 已经创造了什么”。

Asset 可以包括：

```text
Report
Research
Dataset
Prompt
Template
Code
Image
Presentation
Workflow
EvalSet
Journal
MonthlyReview
Decision
Playbook
```

Asset 应该保留：

```text
id
kind
name
owner
visibility
version
contentHash
producedByRun
derivedFrom[]
tags
metadata
evalStatus
createdAt
updatedAt
```

Asset lineage、依赖、版本、Owner 和 Materialization 思想可以参考 `dagster-io/dagster`。

## Arena 和多人对战

Agent 可以参加多人游戏、协作和对抗环境。每一局都是可追溯 Run，也可以成为 Eval 或 Episodic Memory 的来源。

```text
Arena Match
    │
    ▼
Game / Social Environment
    │
    ▼
Agents / Workers
    │
    ▼
Trace + Score
    │
    ▼
Eval / Experience Mining
```

博弈环境参考 `google-deepmind/open_spiel`。语言 Agent 的社交互动和 Social Eval 参考 `sotopia-lab/sotopia`。

Arena 也受权限系统控制。其他用户不能通过游戏让 Agent 调用 Owner 私有 Tool 或读取 Private Memory。

## Turso

Turso 是计划中的结构化长期状态存储。

候选表包括：

```text
agents
users
channel_identities
relationships
permissions
conversations
messages
memories
memory_evidence
skills
skill_versions
assets
asset_versions
sessions
runs
worker_jobs
long_tasks
jobs
approvals
journal_entries
eval_suites
eval_runs
eval_samples
eval_scores
```

Raw Trace 暂时继续保持独立 append-only evidence store。Turso 保存业务状态、权限、索引和 Run 元数据。

Agent 不应该获得 unrestricted SQL 权限。业务数据通过受权限控制的 Domain Tool 访问。

## 长程任务

长程任务不能依赖一个 HTTP 请求或一个进程一直活着。

```text
LongTask
├── stable task id
├── steps
├── event history
├── checkpoint
├── retry policy
├── waiting state
├── external signal
├── child task
├── worker job
├── cancellation
└── continuation
```

重启以后根据持久状态恢复，不重复不可逆副作用。长历史可以 Checkpoint 和 Continue，但不能重写旧 Run 和 Raw Trace。

主要参考 `temporalio/sdk-typescript`。

## Eval 和实验工作台

用户最终可以直接描述实验：

```text
测一下当前 Agent 的 GitHub repo 分析能力。
用 100 条任务。
比较当前版本、Codex、Claude Code 和 AGY。
每个样本跑 3 次。
检查任务成功率、权限 invariant、成本和延迟。
```

Agent 先生成 Eval Draft，只有明确 `Start Eval` 后才运行。

第一阶段优先：

```text
Benchmark
Differential Eval
Invariant Eval
```

权限 Invariant 是 P0：

```text
never expose private memory to unauthorized users
never use another user's user-scoped memory
never expose private assets through public channels
never execute a tool beyond the caller's grant
never let a worker escalate its delegated permissions
never perform approval-required side effects without approval
```

Eval Runner 主要参考 `UKGovernmentBEIS/inspect_ai`。

## Canvas 的位置

Canvas 保留，但不再定义整个产品。

Glassbox 可以有：

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

Canvas 是投影，不是 Agent 执行状态的 Source of Truth。移动、连接、分组和批注不能暗中改变执行或授权。

## 上游参考策略

成熟实现已经解决好的问题优先参考。`upstream/` 保存选择性的只读参考代码，生产代码不能直接 import。

| 上游项目 | 主要参考内容 |
| --- | --- |
| `pingdotgg/t3code` | Claude Code Provider、权限、Session Resume |
| `HKUDS/OpenHarness` | Agent Loop、Tools、Skills、Memory、Channel、QQ |
| `keli-wen/agy-staff` | AGY Worker Delegation、Background Job、Continue、Restart |
| `joyehuang/trajectory-panel` | Trajectory、Timeline、Incremental Tail、Redaction、Turso Sync |
| `UKGovernmentBEIS/inspect_ai` | Eval、Dataset、Scorer、Experiment Runner |
| `temporalio/sdk-typescript` | Durable LongTask、Signal、Retry、Continuation |
| `tursodatabase/turso` | SQLite-compatible Agent State Storage |
| `openfga/openfga` | Fine-grained Authorization、Relation-based Access Control |
| `zhibao-dev/Learning-Multi-Factor-Memory` | Memory Value、Forgetting、Memory Hygiene |
| `langchain-ai/langmem` | Semantic、Episodic、Procedural Memory、Consolidation |
| `AMAP-ML/SkillClaw` | 从真实 Session 自动演化、去重和共享 Skill |
| `Zhang-Henry/CoEvoSkills` | Skill Generate、Verify、Refine、Validated Promotion |
| `MineDojo/Voyager` | Skill Library、成功经验沉淀、Skill Retrieval |
| `joonspk-research/generative_agents` | Memory Stream、Importance、Reflection |
| `usememos/memos` | Journal Timeline、Private/Public Notes |
| `resend/resend-skills` | Agent Email Inbox、发送接收、安全处理 |
| `calcom/cal.diy` | Scheduling、Availability、Calendar Integration |
| `dagster-io/dagster` | Asset、Lineage、Dependency、Version、Materialization |
| `google-deepmind/open_spiel` | Multi-player Game Environment |
| `sotopia-lab/sotopia` | Multi-Agent Social Environment、Social Eval |

`agy-staff` 当前参考点固定到 `67d3fd8fdc04b57006a829ae376ae7ffdc7ee714`。

Vendoring 时必须记录 Source Repo、Commit、License 和原始路径。只复制当前问题需要的文件。许可证要求必须保留。

## 当前架构和目标架构

当前实现：

```text
Provider / Agent Runtime
        ↓
     Raw Trace
        ↓
Normalization / Replay
        ↓
   Derived State
        ↓
 Canvas / Inspector
```

目标：

```text
Channel / Workbench
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
 ┌──────┼───────────┬───────────┐
 │      │           │           │
Tools  Workers    LongTask     Eval
 │      │                       │
 └──────┼───────────────────────┘
        ▼
       Run
        ▼
 Raw Trace + Derived State
        ▼
Experience Mining
        ▼
Memory / Skills / Assets / Journal
        ▼
Timeline / Canvas / Inspector
```

## 从源码运行

Glassbox 使用 Vite+。

macOS 和 Linux：

```bash
curl -fsSL https://vite.plus | bash
vp i
vp run dev
```

Windows：

```powershell
irm https://vite.plus/ps1 | iex
vp i
vp run dev
```

开发环境统一使用相对路径 `/api` 和 `/ws`。不要把固定开发端口写进客户端代码。

## 当前项目结构

```text
apps/
  server/
  web/

packages/
  contracts/
  shared/

upstream/
.plans/
e2e/
template/
```

当前不存在的 package 不要为了未来规划提前创建。

## 开发原则

- Default deny。没有明确授权就是拒绝
- 先授权再组 Context，未经授权的数据不能进入模型上下文
- Tool、Worker、Memory、Skill、Asset 和 Channel 都不能绕过 Authorization
- 外部输入永远不能借 Agent 的 Owner 身份形成权限升级
- Worker 权限只能缩小，不能比调用者更大
- 每个关键授权判断进入 Trace
- Raw Trace 不重写
- Runtime 和 Domain Model 优先于 UI
- Channel、Provider、Worker 的专有逻辑留在 Integration 层
- 长程任务的副作用必须考虑重试、幂等和去重
- Memory、Skill、Asset 的自动沉淀必须有来源和 Promotion Gate
- Eval 配置和结果必须可追溯
- 成熟实现能借就先借，拥有更多代码不是目标

## 测试

测试必须使用隔离数据。

> Copy in. Never point in. Never write back.

权限测试至少覆盖拒绝路径、跨用户读取、跨 Scope 读取、Worker 权限升级、Prompt Injection 诱导越权、Approval 绕过和重复副作用。

异步测试等待真实完成信号，不用任意 `sleep` 掩盖竞态。

## 当前状态

Glassbox 还很早。

下一阶段的重点不是继续扩 Canvas，而是把 Personal Agent 的 Identity、Authorization、Conversation、Memory、Turso 持久化和 Learning Loop 打成第一个真实闭环。

其中 Authorization 是 P0。任何外部 Channel、Mail、Calendar、Worker、Memory 或 Asset 功能，在权限边界没有被代码和测试证明之前都不应该开放给其他用户。