# Glassbox

![Glassbox Personal Agent](./assets/readme/glassbox-hero.png)

Glassbox 是一个长期存在的 Personal Agent 系统。

你通过 Workbench、QQ 和未来其他 Channel 使用同一个主 Agent。它可以直接回答，也可以把需要真实执行的工作登记成 Task，交给 Herdr 中的 Pi、Codex、Claude Code 等 coding worker。

Glassbox 管理的是产品真相：身份、权限、Conversation、Task、Taste、Memory、Trace，以及结果能不能发送给当前 Audience。

```text
Channel 只是入口
Pi 是 Agent 引擎
Lora PI Kit 是 Lora 的 Pi Distribution
Herdr 是 coding worker 执行现场
Canvas 是 Projection
Glassbox 才是 Personal Agent 系统
```

## 当前开发阶段

[`Plan 03 — QQ Personal Agent Closed Loop`](./.plans/03-personal-agent-foundation.md) 已完成。

P3 已完成两个连在一起的真实闭环。

完成证据记录在 Active Plan 的 Completion evidence。确定性测试覆盖身份、权限、
Conversation、Task、Review、Rework、Accept、重启、重连、去重、投递和 Raw Trace。
真实验收覆盖 QQ 私聊与群聊、Pi 加载 Lora PI Kit，以及 Herdr Worker 的完整 Task 生命周期。

### Personal Agent 闭环

```text
QQ 私聊 / 群聊
        ↓
NapCat / OneBot
        ↓
Glassbox
  Identity
  Authorization
  Conversation
  Context Gate
        ↓
Pi SDK
        ↓
Pi + Lora PI Kit profile
        ↓
Tool / Ops Gate
        ↓
Delivery Gate
        ↓
QQ 回复
        ↓
Turso + Raw Trace
```

### Agent Operations 闭环

```text
用户请求
  ↓
Main Agent
  ↓
Task / Attention
  ↓
Authorized Ops Tools
  ↓
HerdrBridge
  ↓
Herdr worker / worktree / pane
  ↓
working / blocked / done
  ↓
OpsReconciler
  ↓
TaskAttempt / WorkerBinding
  ↓
Review
  ├─ Accept → DONE
  └─ Rework → 下一次 Attempt
```

完整施工顺序和 Completion Gate 只看 [`/.plans/03-personal-agent-foundation.md`](./.plans/03-personal-agent-foundation.md)。

## 三层关系：Pi、Lora PI Kit、Glassbox

这是当前最重要的 Runtime 定义。

```text
Pi
  Agent Engine

Lora PI Kit
  My Pi Distribution

Glassbox
  My Personal Agent System
```

### Pi

Pi 提供基础运行能力：

```text
Agent loop
sessions
model / provider support
coding tools
Packages
Extensions
Skills
Prompt Templates
settings
SDK
RPC
```

Glassbox P3 直接通过 `@earendil-works/pi-coding-agent` SDK 嵌入 Pi。

### Lora PI Kit

Lora PI Kit 不是几个零散配置文件。

它的目标是：

> 把刚安装好的裸 Pi，一次安装变成 Lora 自己的完整 Pi 工作环境。

目标内容包括：

```text
Pi Package manifest
Lora Skills snapshot
Extensions
Prompt Templates
Profiles
MCP adapter / registry
model / thinking defaults
Glassbox bridges
Taste / Feedback / Trace hooks
settings / model templates
install / update / doctor / sync tooling
compatibility locks
```

完整定义见 [`docs/lora-pi-kit.md`](./docs/lora-pi-kit.md)。

### Glassbox

Glassbox 负责：

```text
Agent identity
Principal
Authorization
Conversation
Task / TaskAttempt / Attention
WorkerBinding
Taste / Memory truth
Audience / Delivery policy
Turso durable state
Run
Raw Trace
```

这些产品真相不能被 Pi Profile、Skill、MCP、Extension、Herdr 状态或模型输出替代。

## Lora Skills

[`lora-sys/skills`](https://github.com/lora-sys/skills) 是 Lora Skills 的源码真相。

Lora PI Kit Release 会内置一份锁定版本的 Skills Snapshot：

```text
lora-sys/skills
  canonical source
        ↓
sync-skills
        ↓
lora-pi-kit/skills
        ↓
skills.lock.json
        ↓
Kit Release
```

这样同一个 Kit 版本在本地、测试和 Linux Server 上得到相同的 Skill 集合。

注意：

```text
内置全部能力
≠
每次把全部 Skill 注入模型
```

Profile 和当前 Task 决定真正启用哪些 Skills。

## MCP

Pi Core 不要求内置 MCP。

Lora PI Kit 负责通过 Extension / Package 方式提供自己的 MCP Layer：

```text
Pi
  ↓
Lora PI Kit MCP Adapter
  ↓
MCP Registry
  ↓
Profile 选择需要的 Integration
  ↓
Tools
```

不会一启动就连接所有 MCP。

例如：

```text
local-coding
  可以启用较完整 coding / GitHub / browser 能力

main-agent
  只启用需要的 Product / Ops 能力

qq-group
  Tool / MCP Surface 很小

herdr-worker
  启用当前 coding Task 真正需要的能力
```

MCP Tool 存在，不等于当前 QQ Principal 有权限调用。

## Profiles

Lora PI Kit 使用 Profile 区分同一个 Distribution 的不同运行角色。

第一批 Profile：

```text
local-coding
main-agent
owner-direct
qq-group
herdr-worker
test
```

Profile 可以决定：

```text
启用哪些 Extensions
启用哪些 Skills
启用哪些 MCP
Prompt
model / thinking defaults
Tool surface
notifications
Glassbox bridge
trace / usage hooks
```

但 Profile 不能扩大 Glassbox Authorization。

同样使用 Lora PI Kit，也不代表身份相同：

```text
Main Personal Agent
≠
Herdr Pi Worker
```

## Herdr Agent Operations

Herdr 是 coding worker 的实时执行层。

Glassbox 和 Herdr 双向通信：

```text
Glassbox → Herdr
  create / open worktree
  start Agent
  prompt
  wait
  read
  authorized follow-up / cancel

Herdr → Glassbox
  workspace / worktree / pane changes
  working
  blocked
  done
  worker replaced / disappeared
  connection lost / restored
```

但是：

```text
Herdr agent = done
≠
Glassbox Task = DONE
```

正常路径：

```text
Herdr done
→ Task = REVIEW
→ Accept → DONE
或
→ Rework → 新 TaskAttempt
```

详细规则见 [`docs/agent-operations.md`](./docs/agent-operations.md)。

## 权限是硬边界

权限不能靠 Prompt。

Authorization 只有：

```text
ALLOW
DENY
REQUIRES_APPROVAL
```

没有明确 Grant 就是 `DENY`。

每一次受保护操作都必须能回答：

```text
Who
Where
What
How
Resource
Audience
Conversation
Run / Task
```

P3 有四道不可绕过的服务端 Gate：

```text
Ingress Gate
Context Gate
Tool / Ops Gate
Delivery Gate
```

关键规则：

```text
能读
≠
能发给当前 Audience
```

所以 Owner 在私聊能读取自己的私人数据，不代表这些数据可以发进 QQ 群。

同理，Kit 里装了某个 Skill、MCP 或 Tool，也不代表远程 QQ 用户自动获得权限。

## Conversation、Run、Task 不混用

```text
Conversation ≠ Pi Session
Pi Session ≠ Run
Task ≠ Run
Task ≠ Worker
TaskAttempt ≠ Herdr pane
Herdr state ≠ Task acceptance
```

私聊和群聊使用 scope-based Conversation。

每个 Run 记录真正的 Principal。

## 从本地测试到 Linux Server

当前可以本地开发和测试，但最终部署目标是 Linux Server。

```text
Linux Server
├── Glassbox server
├── Pi SDK
├── pinned Lora PI Kit
├── NapCat
├── Herdr
├── coding workers / worktrees
└── Turso-compatible durable state
```

本地和服务器必须使用同一套产品 Contract。

不能让产品正确性依赖：

```text
Desktop GUI
Moshi 状态
Herdr sidebar
开发机固定路径
某一个终端窗口
```

Moshi 可以以后通过 SSH 作为人工远程观察和介入工具，但不是 Product State。

## Rules、Skills、Taste、Memory

后续 P4 不再把所有学习内容都叫 Memory。

稳定拆分：

```text
Rules
  硬约束

Skills
  可复用、可验证的做事流程

Taste
  从用户长期行为里学到的偏好

Memory
  事实、决策、事件、过去工作的长期知识
```

```text
Rules ≠ Skills ≠ Taste ≠ Memory
```

Taste 核心循环：

```text
Agent 输出
→ accept / reject / edit / revert / correction
→ FeedbackEvent
→ TasteCandidate
→ confidence + scope
→ task-aware retrieval
→ 只注入相关 Taste
→ 下一次执行
```

Taste / Memory 真相存在 Glassbox / Turso。

Lora PI Kit 只负责把 Glassbox 选好的小投影注入 Pi，并回传可用 Feedback / Trace Hook。

完整设计见 [`docs/memory-taste.md`](./docs/memory-taste.md)。

## Roadmap

当前状态：

```text
P3 已完成
  QQ Personal Agent + Agent Ops Closed Loop

P4
  Memory, Taste and Authorized Retrieval

P5
  Efficient Runtime and Observability

P6
  Durable Long Work and Workers

P7
  More Channels and Personal Domains

P8
  Eval, Learning, Assets and Skill Evolution
```

详细 Roadmap：[`/.plans/roadmap.md`](./.plans/roadmap.md)。

## 文档索引

```text
AGENTS.md
  稳定不变量

.plans/03-personal-agent-foundation.md
  当前 P3 施工顺序和验收

docs/runtime-strategy.md
  Runtime Ownership

docs/lora-pi-kit.md
  Lora PI Kit Distribution

docs/agent-operations.md
  Herdr / Task / Worker

docs/memory-taste.md
  Rules / Skills / Taste / Memory

docs/tech-stack.md
  技术栈 / 测试 / 部署

docs/data-observability.md
  数据 / 存储 / 监控

upstream/*/SOURCES.md
  上游研究和固定来源
```

## 上游参考

成熟机制优先研究，不直接把上游 Trust Model 搬进 Glassbox。

主要参考包括：

```text
earendil-works/pi
  Pi engine / Package / SDK / Extension / Skill

lora-sys/skills
  Lora Skills canonical source

herdrdev/herdr
  coding worker execution / worktree / pane / lifecycle

aorumbayev/herdr-workflows
  bounded stage workflow

NapNeko/NapCatQQ
botuniverse/onebot-11
  QQ transport

tursodatabase/turso
  structured durable state

openfga/openfga
  authorization concepts

CommandCodeAI/command-code
  Taste / behavioral preference learning reference

TokenRhythm/opensquilla
  later retrieval / routing / context efficiency
```

`upstream/` 是研究和选择性参考区，生产代码不能直接 import。

## 双人协同与双 Owner 架构

本项目支持两人协作开发与对等测试。

### 1. 权限等同与隔离机制
* **身份对等**：主 Owner（`OWNER_QQ`）与协同 Owner（`CO_OWNER_QQ`）均映射为最高特权的主体（`kind = 'owner'`），在群聊与系统中拥有完整的操作、派工、审批与管理权限。
* **私聊绝对隔离**：两人的私聊会话具有独立的 `scopeKey`（含各自的 QQ 号），在数据库 `conversations` 表中物理独立，私有资产和私聊上下文互不相通。
* **工作空间防碰撞**：向 Herdr 派发编码任务（Task）时，每个 TaskAttempt 的 `worker_bindings` 均分配独立的隔离分支（如 `herdr/task-<principalId>-<taskId>`）和独立 worktree 工作目录，两人派发的编码任务互不踩踏。

---

## 快速上手与本地开发

### 1. 软件环境要求
* **Node.js**：`>= 22.18.0`（推荐 `24.x`）
* **统一工具链**：Vite+，命令入口为 `vp`
* **NapCat / OneBot**：已就绪的 QQ 机器人（用于收发消息）
* **Herdr**（可选）：用于本地 Worker 调度的执行宿主
* **Lora PI Kit**：同级目录存放 `lora-pi-kit`

### 2. 初始化步骤
1. **安装依赖**：
   ```bash
   vp install
   ```
2. **环境配置**：
   从模板复制并填写配置文件：
   ```bash
   cp .env.example .env
   ```
   根据你的测试环境填入 `BOT_QQ`、`OWNER_QQ`、`CO_OWNER_QQ`、`TEST_GROUP_ID`、`NAPCAT_WS_URL` 与模型 API Key。

3. **运行自检测试**：
   ```bash
   vp run verify:commit
   ```

4. **进程管理命令**：
   ```bash
   # 启动核心服务（Glassbox + NapCat + Herdr）
   vp run agent:up

   # 查看服务状态与健康度
   vp run agent:status

   # 查看实时运行日志
   vp run agent:logs

   # 停止服务
   vp run agent:down
   ```

---

## 给合作开发者（及其 Coding Agent）的快速接入指南

克隆本仓库后，第二位开发者可直接将以下 Prompt 复制给其使用的 **Codex / Claude Code / AI Agent**，由 Agent 全自动拉取依赖、配置环境、生成配置骨架并启动三服务：

````markdown
你现在是负责将 Glassbox Personal Agent 系统在当前电脑上完整初始化并跑起来的自动化工程师 Agent。

请一步一步自动执行以下初始化流程，直至项目完全就绪：

### 阶段一：代码仓库与关联子模块拉取
1. 检查当前工作目录：
   - 如果当前不在 `Glassbox-Agent-Harness` 仓库中，请执行：
     `git clone https://github.com/lora-sys/Glassbox-Agent-Harness.git`
     并进入 `Glassbox-Agent-Harness` 目录，确保处于 `main` 分支。
2. 检查关联核心仓库 `lora-pi-kit`：
   - 检查同级目录是否存在 `lora-pi-kit`。若不存在，请克隆：
     `git clone https://github.com/lora-sys/lora-pi-kit.git ../lora-pi-kit`
   - 记录其绝对路径，后续作为 `LORA_PI_KIT_PATH` 使用。

### 阶段二：工具链与依赖安装
1. 检查 Node.js 版本（必须 >= 22.0.0，推荐 24.x）。
2. 本项目统一使用 Vite+ (`vp`) 作为工具链规范：
   - 检查是否已安装 `vp`；若未安装，可使用 `npm install` 安装所有 workspace 依赖。
   - 确保可以使用 `vp` 或 `npm run` 执行命令。

### 阶段三：外部运行组件就绪检查（NapCat 与 Herdr）
1. 检查 OneBot 11（NapCat）服务：
   - 确认本机是否配置并运行了 NapCat（默认 WebSocket 地址为 `ws://127.0.0.1:6700/`）。
2. 检查 Herdr 运行宿主：
   - 检查本机是否存在 `herdr` 可执行文件。若未安装，提示用户从 Herdr 官方 Release 下载并放置在相应路径。

### 阶段四：全自动生成配置骨架
1. 检查项目根目录的 `.env`：
   - 若不存在，从 `.env.example` 复制生成 `.env`。
   - 自动将其中的 `GLASSBOX_DATA_DIR` 填为当前用户主目录下的 `.glassbox`（例如 Windows 下的 `C:\Users\<当前用户>\.glassbox`）。
   - 自动将 `LORA_PI_KIT_PATH` 填为阶段一中 `lora-pi-kit` 的真实绝对路径。
2. 在 `$GLASSBOX_DATA_DIR`（即 `~/.glassbox`）中初始化运行时配置骨架：
   - 检查并创建 `channels.json`、`models.json`、`agent-operations.json`、`service-launch.json`。
   - 将各个配置中的路径占位符自动替换为当前电脑的实际绝对路径。
3. 停下来向用户索要私下提供的核心敏感凭证，并协助写入 `.env` 和 `channels.json`：
   - `BOT_QQ`（机器人 QQ）
   - `OWNER_QQ`（主 Owner QQ）
   - `CO_OWNER_QQ`（协同 Owner QQ）
   - `TEST_GROUP_ID`（测试群号）
   - `NAPCAT_ACCESS_TOKEN`（OneBot 鉴权 Token）
   - `MINIMAX_API_KEY`（模型 API 密钥）

### 阶段五：自检测试与全服务启动
1. 运行代码与类型检查：`vp check`
2. 运行服务端测试：`vp run test:server`，确保所有核心单元测试（包括双 Owner 独立会话与权限测试）100% PASS。
3. 凭证补齐后，执行三服务拉起：
   - 启动命令：`vp run agent:up`（自动拉起 Herdr、NapCat 和 Glassbox 主服务）
   - 检查状态：`vp run agent:status`
   - 查看日志：`vp run agent:logs`
4. 向用户汇报各服务的 PID、监听端口及连接状态，确认系统已整体跑起来。
````

---

## 开发规范与进入顺序

进入仓库工作的 Coding Agent 必须按此顺序阅读：

```text
AGENTS.md
→ Active Plan (.plans/03-personal-agent-foundation.md)
→ 当前任务对应 docs/*.md
→ relevant upstream notes
→ production code + focused tests
```

不要从旧 Git 历史恢复已经被当前 Plan 和架构文档取代的旧语义。

## License

MIT. See [`LICENSE`](./LICENSE).
