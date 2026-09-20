# Glassbox

<p align="center">
  <img src="./assets/readme/glassbox-hero.png" alt="Glassbox Personal Agent" width="100%" />
</p>

<p align="center">
  <a href="#-开源协议"><img src="https://img.shields.io/badge/License-MIT-blue.svg" alt="License" /></a>
  <a href="https://nodejs.org/"><img src="https://img.shields.io/badge/Node.js-%3E%3D22.0.0-green.svg" alt="Node.js" /></a>
  <a href="https://vite.dev/"><img src="https://img.shields.io/badge/Toolchain-Vite%2B-purple.svg" alt="Vite+" /></a>
  <a href="./.plans/03-personal-agent-foundation.md"><img src="https://img.shields.io/badge/Stage-Plan%2003%20Done-success.svg" alt="Stage" /></a>
</p>

---

> **Glassbox 是一个具备显式身份、严格授权、持久化会话、可审查执行、任务闭环与多代理调度的 Personal Agent 系统。**

你通过 Workbench、QQ 和未来其他 Channel 使用同一个主 Agent。它可以直接回答，也可以把需要真实执行的工作登记成 Task，交给 Herdr 中的 Pi、Codex、Claude Code 等 coding worker。

Glassbox 管理的是产品真相：身份、权限、Conversation、Task、Taste、Memory、Trace，以及结果能不能发送给当前 Audience。

---

## 📑 目录

- [🌟 核心理念与分工](#-核心理念与分工)
- [🏁 当前开发阶段](#-当前开发阶段)
  - [1. Personal Agent 闭环](#1-personal-agent-闭环)
  - [2. Agent Operations 闭环](#2-agent-operations-闭环)
- [🧭 核心三层关系：Pi、Lora PI Kit、Glassbox](#-核心三层关系pi-lora-pi-kit-glassbox)
  - [Pi](#pi)
  - [Lora PI Kit](#lora-pi-kit)
  - [Glassbox](#glassbox)
- [🧩 技能、MCP 与 Profiles](#-技能-mcp-与-profiles)
- [🤖 Herdr Agent Operations](#-herdr-agent-operations)
- [🔒 权限是硬边界](#-权限是硬边界)
- [👥 双人协同与双 Owner 架构](#-双人协同与双-owner-架构)
- [⚡ 快速上手与本地开发](#-快速上手与本地开发)
- [🚀 给合作开发者（及其 Coding Agent）的快速接入指南](#-给合作开发者及其-coding-agent的快速接入指南)
- [🗺️ Roadmap 与文档索引](#️-roadmap-与文档索引)
- [📜 开源协议](#-开源协议)

---

## 🌟 核心理念与分工

| 核心组件 | 角色定位 | 核心职责 |
| :--- | :--- | :--- |
| **Glassbox** | **Personal Agent 系统** | **产品真相**：身份、权限、会话、Task、Taste、Memory、Trace、投递决策 |
| **Pi** | **Agent Engine** | 基础运行能力：Agent loop、会话管理、模型接入、SDK 驱动 |
| **Lora PI Kit** | **Pi Distribution** | 运行分发包：Package 清单、技能快照、扩展、MCP 适配、Profiles |
| **Herdr** | **Coding Worker 宿主** | 执行现场：工作区（Workspace）、工作树（Worktree）、Pane、终端进程 |
| **Channel** | **接入端点** | 外部入口（QQ、Workbench、API 等），并非独立的 Agent |
| **Canvas** | **Projection** | 可视化检查面与工作空间，**不是执行状态真相** |

```text
Channel 只是入口
Pi 是 Agent 引擎
Lora PI Kit 是 Lora 的 Pi Distribution
Herdr 是 coding worker 执行现场
Canvas 是 Projection
Glassbox 才是 Personal Agent 系统
```

---

## 🏁 当前开发阶段

[`Plan 03 — QQ Personal Agent Closed Loop`](./.plans/03-personal-agent-foundation.md) 已完成。

P3 已完成两个连在一起的真实闭环。完成证据记录在 Active Plan 的 Completion evidence 中：
- **确定性测试**：覆盖身份、权限、Conversation、Task、Review、Rework、Accept、重启、重连、去重、投递和 Raw Trace。
- **真实验收**：覆盖 QQ 私聊与群聊、Pi 加载 Lora PI Kit，以及 Herdr Worker 的完整 Task 生命周期。

### 1. Personal Agent 闭环

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

### 2. Agent Operations 闭环

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

> [!IMPORTANT]
> 完整施工顺序和 Completion Gate 只看 [`/.plans/03-personal-agent-foundation.md`](./.plans/03-personal-agent-foundation.md)。

---

## 🧭 核心三层关系：Pi、Lora PI Kit、Glassbox

这是系统最重要的 Runtime 架构定义：

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
- Agent loop、sessions
- model / provider support
- coding tools
- Packages、Extensions、Skills、Prompt Templates、settings
- SDK 与 RPC 接口

Glassbox P3 直接通过 `@earendil-works/pi-coding-agent` SDK 嵌入 Pi。

### Lora PI Kit
Lora PI Kit 不是几个零散配置文件。它的目标是：
> **把刚安装好的裸 Pi，一次安装变成 Lora 自己的完整 Pi 工作环境。**

目标内容包括：
- Pi Package manifest
- Lora Skills snapshot、Extensions、Prompt Templates、Profiles
- MCP adapter / registry、model / thinking defaults
- Glassbox bridges、Taste / Feedback / Trace hooks
- settings / model templates、install / update / doctor / sync tooling、compatibility locks

完整定义见 [`docs/lora-pi-kit.md`](./docs/lora-pi-kit.md)。

### Glassbox
Glassbox 负责：
- Agent identity、Principal、Authorization、Conversation
- Task / TaskAttempt / Attention、WorkerBinding
- Taste / Memory truth、Audience / Delivery policy
- Turso durable state、Run、Raw Trace

**这些产品真相不能被 Pi Profile、Skill、MCP、Extension、Herdr 状态或模型输出替代。**

---

## 🧩 技能、MCP 与 Profiles

### Lora Skills
[`lora-sys/skills`](https://github.com/lora-sys/skills) 是 Lora Skills 的源码真相。Lora PI Kit Release 会内置一份锁定版本的 Skills Snapshot：

```text
lora-sys/skills (canonical source)
        ↓ sync-skills
lora-pi-kit/skills
        ↓
skills.lock.json
        ↓
Kit Release
```

同一个 Kit 版本在本地、测试和 Linux Server 上得到相同的 Skill 集合。
> [!NOTE]
> **内置全部能力 ≠ 每次把全部 Skill 注入模型**。Profile 和当前 Task 决定真正启用哪些 Skills。

### MCP
Pi Core 不要求内置 MCP。Lora PI Kit 负责通过 Extension / Package 方式提供自己的 MCP Layer：

```text
Pi → Lora PI Kit MCP Adapter → MCP Registry → Profile 选择需要的 Integration → Tools
```

- **按需连接**：不会一启动就连接所有 MCP。
- **权限隔离**：MCP Tool 存在，不等于当前 QQ Principal 有权限调用。

### Profiles
Lora PI Kit 使用 Profile 区分同一个 Distribution 的不同运行角色：
- `local-coding`：较完整 coding / GitHub / browser 能力
- `main-agent`：核心 Product / Ops 能力
- `owner-direct`：Owner 直连通道
- `qq-group`：最小化 Tool / MCP Surface
- `herdr-worker`：当前 Task 真正需要的专项能力
- `test`：确定性测试专用

> [!WARNING]
> Profile 可以决定启用哪些能力，但**不能扩大 Glassbox Authorization**。

---

## 🤖 Herdr Agent Operations

Herdr 是 coding worker 的实时执行层。Glassbox 和 Herdr 双向通信：

```text
Glassbox → Herdr
  create / open worktree
  start Agent
  prompt / wait / read
  authorized follow-up / cancel

Herdr → Glassbox
  workspace / worktree / pane changes
  working / blocked / done
  worker replaced / disappeared
  connection lost / restored
```

> [!CAUTION]
> **Herdr agent = done ≠ Glassbox Task = DONE**  
> 正常路径必须经历：`Herdr done` → `Task = REVIEW` → `Accept → DONE` 或 `Rework → 新 TaskAttempt`。

详细规则见 [`docs/agent-operations.md`](./docs/agent-operations.md)。

---

## 🔒 权限是硬边界

权限不能靠 Prompt。Authorization 只有三种确定性结果：
```text
ALLOW
DENY
REQUIRES_APPROVAL
```

**没有明确 Grant 就是 `DENY`。**

每一次受保护操作都必须能明确回答：`Who`、`Where`、`What`、`How`、`Resource`、`Audience`、`Conversation`、`Run / Task`。

### 四道服务端硬 Gate

```text
Ingress Gate → Context Gate → Tool / Ops Gate → Delivery Gate
```

- **核心原则**：`能读 ≠ 能发给当前 Audience`。Owner 在私聊能读取自己的私人数据，不代表这些数据可以发进 QQ 群。
- **概念独立**：
  ```text
  Conversation ≠ Pi Session
  Pi Session ≠ Run
  Task ≠ Run
  Task ≠ Worker
  TaskAttempt ≠ Herdr pane
  Herdr state ≠ Task acceptance
  ```

---

## 👥 双人协同与双 Owner 架构

本项目支持两人协作开发与对等测试。

1. **身份对等**：主 Owner（`OWNER_QQ`）与协同 Owner（`CO_OWNER_QQ`）均映射为最高特权的主体（`kind = 'owner'`），在群聊与系统中拥有完整的操作、派工、审批与管理权限。
2. **私聊绝对隔离**：两人的私聊会话具有独立的 `scopeKey`（含各自的 QQ 号），在数据库 `conversations` 表中物理独立，私有资产和私聊上下文互不相通。
3. **工作空间防碰撞**：向 Herdr 派发编码任务（Task）时，每个 TaskAttempt 的 `worker_bindings` 均分配独立的隔离分支（如 `herdr/task-<principalId>-<taskId>`）和独立 worktree 工作目录，两人派发的编码任务互不踩踏。

---

## ⚡ 快速上手与本地开发

### 1. 软件环境要求
- **Node.js**：`>= 22.18.0`（推荐 `24.x`）
- **统一工具链**：Vite+，命令入口为 `vp`
- **NapCat / OneBot**：已就绪的 QQ 机器人（用于收发消息）
- **Herdr**（可选）：用于本地 Worker 调度的执行宿主
- **Lora PI Kit**：同级目录存放 `lora-pi-kit`

### 2. 初始化步骤

```bash
# 1. 安装依赖
vp install

# 2. 从模板复制并填写配置文件
cp .env.example .env
# 编辑 .env 填入你的测试参数（BOT_QQ、OWNER_QQ、CO_OWNER_QQ、TEST_GROUP_ID、NAPCAT_WS_URL、模型 API Key 等）

# 3. 运行全量自检测试门禁
vp run verify:commit
```

### 3. 服务进程管理

```bash
# 启动三大服务（Herdr + NapCat + Glassbox）
vp run agent:up

# 查看服务状态与健康度
vp run agent:status

# 查看实时运行日志
vp run agent:logs

# 停止服务
vp run agent:down
```

---

## 🚀 给合作开发者（及其 Coding Agent）的快速接入指南

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

## 🗺️ Roadmap 与文档索引

### 阶段规划
- **P3（已完成）**：QQ Personal Agent + Agent Ops Closed Loop
- **P4**：Memory, Taste and Authorized Retrieval
- **P5**：Efficient Runtime and Observability
- **P6**：Durable Long Work and Workers
- **P7**：More Channels and Personal Domains
- **P8**：Eval, Learning, Assets and Skill Evolution

详细 Roadmap 参见 [`/.plans/roadmap.md`](./.plans/roadmap.md)。

### 文档导航

| 文档 | 说明 |
| :--- | :--- |
| [`AGENTS.md`](./AGENTS.md) | **项目稳定不变量与核心准则** |
| [`.plans/03-personal-agent-foundation.md`](./.plans/03-personal-agent-foundation.md) | 当前 P3 施工顺序和验收证据 |
| [`docs/runtime-strategy.md`](./docs/runtime-strategy.md) | Runtime 归属权与 Pi SDK 边界 |
| [`docs/lora-pi-kit.md`](./docs/lora-pi-kit.md) | Lora PI Kit 规范与 Profiles 体系 |
| [`docs/agent-operations.md`](./docs/agent-operations.md) | Herdr、Task、Worker 协调机制 |
| [`docs/memory-taste.md`](./docs/memory-taste.md) | Rules、Skills、Taste 与 Memory 体系 |
| [`docs/tech-stack.md`](./docs/tech-stack.md) | 技术栈、Vite+ 工具链与部署规范 |
| [`docs/data-observability.md`](./docs/data-observability.md) | 持久化数据、存储与可观测性 |
| [`upstream/*/SOURCES.md`](./upstream/) | 上游调研与来源说明 |

### Coding Agent 阅读顺序

进入本仓库工作的 Coding Agent 必须严格按此顺序阅读：
```text
AGENTS.md
→ Active Plan (.plans/03-personal-agent-foundation.md)
→ 当前任务对应 docs/*.md
→ relevant upstream notes
→ production code + focused tests
```

---

## 📜 开源协议

本项目采用 MIT 协议。详见 [`LICENSE`](./LICENSE)。
