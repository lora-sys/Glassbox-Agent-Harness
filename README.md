# Glassbox

<p align="center">
  <img src="./assets/readme/hero-v1.webp" width="100%" alt="Glassbox personal agent workbench with inspectable runs, traces, experiments, and long-running tasks" />
</p>

Glassbox 正在从一个本地 Coding Agent 观察与控制工作台，演进成一个长期存在的 Personal Agent 工作台。

目标很简单：你拥有一个长期存在的 Agent。你在 Glassbox 里管理它、使用它、检查它做过的工作，也可以让其他人通过微信、QQ 等聊天渠道与这个 Agent 交互。

聊天渠道只是入口。Canvas 只是工作台的一种视图。真正的核心是 Agent Runtime、长期状态、权限、长程任务、执行证据和 Eval。

> 当前仓库还没有完成下面所有目标能力。README 会明确区分“已经实现”和“接下来要构建”的部分。

## 产品目标

Glassbox 最终围绕一个长期存在的 Personal Agent 工作：

```text
                         Personal Agent
                              │
              ┌───────────────┼───────────────┐
              │               │               │
            Memory          Skills           Tools
              │                               │
              │                         GitHub / Web / MCP
              │                               │
              │                         Codex / Claude Code
              │
        Long-running Tasks
              │
              └───────────────┬───────────────┘
                              │
                         Agent Runtime
                              ▲
                 ┌────────────┼────────────┐
                 │            │            │
             Workbench       微信          QQ
                 │
                 ▼
        Trace / Eval / Experiments
                 │
        ┌────────┼────────┐
        │        │        │
     Timeline  Canvas   Raw Trace
```

这里始终只有一个 Agent。

微信 Bot、QQ Bot、Workbench 都不是新的 Agent。它们只是不同的入口。不同用户和不同聊天拥有各自的 Conversation 和 User-scoped Memory，但访问的是同一个 Agent 的公开能力和知识。

Codex、Claude Code 和其他 Coding Agent 也不再是产品中心。它们可以继续作为 Provider，也可以逐步变成 Personal Agent 在需要时调用的专业执行能力。

## 为什么做这个

短任务用聊天就够了。任务一旦变长，问题会迅速出现。

Agent 会读文件、调用工具、修改代码、等待审批、运行几小时、跨天继续、留下大量执行记录。用户需要知道任务现在到哪里、为什么停住、用了什么上下文、做过什么修改、哪些结果可信，以及失败后能不能从原来的状态继续。

Personal Agent 还会多出另外几个问题：

- 不同聊天渠道里的用户如何映射到同一个 Agent
- 私人 Memory、公开 Memory 和某个用户自己的 Memory 如何隔离
- Agent 的长期任务如何暂停、恢复、重试和等待外部事件
- 一个 Agent、模型或组件改动以后，怎么证明它真的变好了
- 一次结论如何回到原始 Run、Tool Call、Artifact 和 Trace

Glassbox 要解决的是这些问题，而不是再做一个聊天壳。

## 当前已经实现

当前代码仍然以本地 Coding Agent 工作台为主，已经有这些基础能力：

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

这些能力会继续保留，但它们以后服务的是更大的 Personal Agent Runtime。

## 下一阶段的核心模型

我们会优先围绕下面这些对象扩展，而不是继续增加 Canvas Shape 或 Provider 数量。

```text
Agent
User
ChannelIdentity
Conversation
Memory
Skill
Tool
Session
Run
LongTask
Experiment
EvalSuite
EvalRun
```

几个必须保持清楚的边界：

```text
Channel ≠ Agent
Conversation ≠ Session
Session ≠ Run
LongTask ≠ Run
Event ≠ Canvas Object
Canvas ≠ Execution State
Raw Trace ≠ Derived State
Eval Sample → Run → Raw Trace
```

## Conversation 和聊天渠道

外部渠道统一进入标准消息模型，再交给 Agent Runtime。

```text
微信 / QQ / 其他渠道
        │
        ▼
   Channel Adapter
        │
        ▼
Identity + Conversation
        │
        ▼
   Personal Agent
```

Channel Adapter 只处理渠道协议和消息格式。Agent Runtime 不应该知道 QQ 或微信的具体协议细节。

同一个真实用户以后可以绑定多个 Channel Identity：

```text
user_123
├── workbench: account_xxx
├── wechat: wx_xxx
└── qq: qq_xxx
```

群聊、私聊和 Thread 必须有明确的 Session Routing，避免多个用户意外共享同一份对话状态和 Memory。

## Memory 和权限

Memory 不能只靠 Prompt 约束。访问范围必须由 Runtime 和数据层执行。

第一版至少区分：

```text
private       只有 Owner 和 Agent 的私有执行可以访问
public        外部用户可以通过 Agent 间接使用
user          只属于某个外部用户
conversation  只属于当前 Conversation
```

Tool 也需要权限 Scope。读取 Owner 的私人日历、邮箱或文件，不能因为外部用户发了一条消息就自动获得权限。

Approval 和 Secret Screening 是这套权限模型的现有基础，会继续保留。

## Turso

Turso 是计划中的长期状态存储之一。

它适合承接 Personal Agent 的结构化状态，例如：

```text
agents
users
channel_identities
conversations
messages
memories
sessions
runs
long_tasks
jobs
approvals
eval_suites
eval_runs
eval_samples
eval_scores
```

Raw Trace 暂时继续保持独立的 append-only evidence store。Turso 保存业务状态、索引和 Run 元数据，不为了上数据库而重写已经有效的 Trace 机制。

Agent 不应该默认获得 unrestricted SQL 权限。Memory 和业务数据应通过受权限控制的 Tool API 访问。

## 长程任务

长程任务不能依赖一个 HTTP 请求一直活着，也不能只存在进程内存里。

目标语义参考 durable workflow 系统：

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
├── cancellation
└── continuation
```

一个任务可以等待几个小时后收到用户回复，再从原来的状态继续。Runtime 重启后也应该根据持久状态恢复，而不是重新执行所有副作用。

长历史需要通过 Checkpoint 和 Continuation 压缩执行上下文，但旧 Trace 和旧 Run 不能被重写。

## Eval 和实验工作台

Eval 会作为 Glassbox 的实验能力，而不是一个独立脚本目录。

用户最终可以用自然语言描述实验，例如：

```text
测一下当前 Agent 的 GitHub repo 分析能力。
用 100 条任务。
比较当前版本、Codex 和 Claude Code。
每个样本跑 3 次。
检查任务成功率、工具使用、成本、延迟和隐私 invariant。
```

Agent 先生成 Eval Draft。只有明确执行 Start 后才真正运行。

```text
Experiment
├── EvalSuite
├── Dataset
├── Target
├── Variant
├── Scorer
└── EvalRun
```

第一阶段优先做三类：

- Benchmark：固定任务集验证能力
- Differential Eval：同一任务集比较不同 Agent、Model 或配置
- Invariant Eval：检查权限、Memory、Tool 和 Runtime 性质是否始终成立

每一个 Eval Sample 都应该链接到真实 Run 和 Raw Trace。失败样本可以直接进入 Timeline、Canvas 或 Raw Trace 查看证据。

后续可以逐步增加 Fuzz Eval、Simulation、Multi-Agent Eval、Chaos Eval 和 Workflow Verification，但不要提前搭空框架。

## Canvas 的位置

Canvas 保留，但不再定义整个产品。

Glassbox 可以有多种工作视图：

```text
Conversation
Project
Timeline
Canvas
Trace
Experiment
```

Canvas 适合表达 Plan、Artifact、Diff、Source、Decision、Result 和长期任务状态。它不是 Workflow Builder，也不是 Agent Runtime 的 Source of Truth。

移动、分组、连接或批注 Canvas Object 不应该暗中改变 Agent 执行。真正改变执行的操作必须是明确的 Action，例如 Apply、Steer、Approve、Stop、Resume 或 Start Eval。

## 上游参考策略

成熟项目已经解决好的问题优先复用。`upstream/` 用来保存经过选择的只读参考实现。生产代码不能直接 import `upstream/`。

当前认可的主要参考项目：

| 上游项目 | 主要参考内容 |
| --- | --- |
| `pingdotgg/t3code` | Claude Code Provider、权限、Session Resume、Provider Integration |
| `HKUDS/OpenHarness` | Agent Loop、Tools、Skills、Memory、Permission、Channel Gateway、QQ Channel |
| `joyehuang/trajectory-panel` | JSONL Trajectory、Timeline、增量 Tail、Redaction、Turso Sync |
| `UKGovernmentBEIS/inspect_ai` | Eval Task、Dataset、Scorer、Eval Set、Experiment Runner、Agent Evaluation |
| `temporalio/sdk-typescript` | Durable Long Task、Signal、Retry、Child Task、Cancellation、Continue As New |
| `tursodatabase/turso` | SQLite-compatible Agent State Storage、Vector、MCP 和数据库能力参考 |

Vendoring 规则：

- 只复制当前问题真正需要的文件，不整仓搬运
- 每个上游目录记录 Source Repo、Commit、License 和原始路径
- 复制 MIT 或其他允许复用的代码时保留版权和 License Notice
- 优先复制经过生产或真实项目验证的机制，不为了“拥有自己的实现”而重写标准组件
- 上游代码只作为参考，生产依赖必须明确引入并经过当前架构审查

## 当前架构

当前实现仍然是 Provider 驱动的本地 Runtime：

```text
Provider / Agent Runtime
        │
        ▼
     Raw Trace
        │
        ▼
Normalization / Replay
        │
        ▼
   Derived State
        │
        ▼
 Canvas / Inspector
```

目标架构在它前面增加 Personal Agent 和 Conversation，在它旁边增加 Long Task 和 Eval：

```text
Channel / Workbench
        │
        ▼
Identity + Conversation
        │
        ▼
   Personal Agent
        │
        ├── Skill / Tool / Provider
        ├── LongTask Engine
        └── Eval Runner
        │
        ▼
      Run
        │
        ▼
 Raw Trace + Derived State
        │
        ▼
Timeline / Canvas / Inspector
```

## 从源码运行

Glassbox 使用 Vite+。

先安装全局 `vp` 命令。

### macOS 和 Linux

```bash
curl -fsSL https://vite.plus | bash
```

### Windows

```powershell
irm https://vite.plus/ps1 | iex
```

安装依赖：

```bash
vp i
```

启动 Web App 和本地 Runtime：

```bash
vp run dev
```

开发环境统一使用相对路径 `/api` 和 `/ws`。不要把 localhost 或固定开发端口写进客户端代码。

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

`apps/server` 负责当前本地 Runtime、HTTP、WebSocket、Provider Adapter、Session 生命周期、Trace 和 Derived State。

`apps/web` 负责当前 React 应用、tldraw、Canvas Projection、Inspector 和用户交互。

`packages/contracts` 放跨边界 Contract。当前仍然很小，不要因为未来规划提前塞满抽象。

`packages/shared` 只放真正共享的小工具。

`upstream/` 保存选择性的成熟开源参考实现。研究后再把适合的机制实现到正式代码里。

`.plans/` 保存当前阶段的计划、Findings 和 Ticket。

## 开发原则

- Runtime 和数据模型优先于视图
- Channel 只是入口，不要把渠道协议泄漏到 Agent Core
- Provider 的特殊行为留在 Provider Integration
- tldraw 的特殊行为留在 Projection 和 Rendering
- Raw Trace 不重写
- UI 不能显示假的进度或过期状态
- 长程任务的副作用必须考虑重试和幂等
- 私有数据权限由代码和数据层执行，不依赖 Prompt 自觉
- Eval 的配置、Target、Dataset、Scorer 和结果必须可追溯
- 成熟实现能直接借就先借，拥有更多代码不是目标
- 只为真实需求增加抽象

## 测试

不要只拿空工作区或极小 Fixture 做测试。

真实 Session、Conversation、Run、LongTask、Eval Sample 和 Agent Trace 更容易暴露问题。

测试状态必须写入隔离的 disposable workspace。需要真实数据时先复制或 Snapshot。

> Copy in. Never point in. Never write back.

修改代码后运行最小但足够证明结果的测试、Lint、Typecheck 或 Browser Verification。异步测试等待真实完成信号，不用任意 `sleep` 掩盖竞态。

## 当前状态

Glassbox 还很早。

现有 Coding Agent Harness 已经证明 Trace、Provider、Approval、Derived State 和 Canvas 闭环可以工作。下一阶段会把重心转向 Personal Agent Runtime、Conversation、Memory、Turso 持久化、聊天渠道、长程任务和 Eval。

不要为了未来版本提前把所有系统一次做完。先完成一个真实闭环，再用真实使用和 Eval 决定下一步。