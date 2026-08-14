# AGENTS.md（重构版）

---

# 1. 项目是什么

Glassbox Agent Harness 是一个面向本地 AI Agent 的：

> **飞行记录器 + 实验室 + 可观测 Harness + 自我进化系统**

它的核心不是“做一个 Agent”，而是：

> **让 Claude Code / Codex / Pi 这些 Agent 的行为变得可观测、可复现、可比较、可进化**

我们不替代 Agent，我们只做一件事：

* 让 Agent 的每一次执行都变成可分析的数据

系统负责：

* 启动 / 隔离 Agent Run
* 捕获所有执行事件（Event Ledger）
* 统一不同 Agent 的行为语义
* 重建模型真实 Context
* 追踪 Tool / Skill / Memory 生命周期
* 保存 Workspace / Diff / Artifact
* 做 Eval / Replay / Fork
* 对比不同 Agent / 不同策略
* 从 Trace 中提取 Experience
* 为未来 Self-Improvement 提供数据基础

核心问题：

> **Agent 的经验，如何变成可验证的能力？**

---

# 2. 我们不是什么

Glassbox 不是：

* Claude Code / Codex / Pi 的替代品
* 聊天 UI
* Prompt 管理工具
* Agent workflow builder
* LangChain / MCP 平台
* “万能 Agent 框架”
* Demo dashboard 工具

原则只有一句：

> **Reuse agents. Observe them. Compare them. Improve them.**

---

# 3. 永远不能妥协的原则

## 3.1 Context 必须可重建

任何进入模型 Context 的内容必须能回答：

* 是什么内容
* 从哪里来
* 谁引入的
* 什么时候引入
* 为什么引入
* 属于哪个 Run / Event / File / Skill

不能出现：

> “应该在 context 里，但我们不知道具体是什么”

否则必须标记：

`opaque`

---

## 3.2 Event 是唯一事实源

UI / DB / cache 都不是事实。

唯一事实源：

> **Event Ledger（追加式事件流）**

结构必须是：

Execution → Event → Projection → UI / Eval / Replay

禁止反向推理 UI 状态。

---

## 3.3 不允许伪造可观测性

所有 reasoning 必须分类：

* exposed（模型真实输出）
* summary（模型/系统总结）
* derived（系统推导）
* opaque（不可见）

禁止把 derived 当成 model internal thought。

---

## 3.4 Context 必须有 provenance

每个 Context Block 必须包含：

* content
* source / source_id
* introduced_at
* introduced_by
* scope
* content_hash
* token_count
* visibility
* reason（如果可知）

---

## 3.5 所有优化必须有证据

禁止：

* “感觉更好”
* “应该提升效果”

必须有：

before / after + 可对比：

* task
* workspace
* agent
* environment
* eval

没有 eval = 不算优化。

---

## 3.6 Failure 是核心数据

失败不是垃圾。

必须保留：

* event
* context
* tool call / result
* workspace diff
* error
* skill lifecycle
* eval
* failure classification

失败比成功更重要。

---

## 3.7 Adapter 必须隔离

Claude / Codex / Pi 差异只能存在：

> `adapters/`

禁止污染 core：

```ts
if (agent === "claude") ...
```

如果出现 → abstraction 已失败。

---

## 3.8 原始数据不可修改

Raw Event 一旦写入：

* 不可修改
* 只能追加 normalization / projection / annotation

---

## 3.9 Replay / Rerun / Fork 必须区分

* replay：重放事件
* rerun：重新执行任务
* fork：从状态分支新实验

不能混用。

---

## 3.10 简单优先于聪明

优先：

* 单模块
* 明确接口

禁止：

* 过早 plugin system
* registry / factory / orchestrator 过度设计

---

# 4. 项目负责人的说明

这是一个：

> **边研究 Agent，边构建真实系统的工程实验**

允许：

* 推翻设计
* 删除模块
* 重做 schema
* 承认失败方法

禁止：

* 为了代码量保留错误设计
* 为未来需求过度设计
* 用 demo 替代真实能力
* 制造假数据

工程优先级：

清晰 > 聪明
证据 > 感觉
真实 > Demo
简单 > 完整
删除 > 抽象

---

# 5. 共同领域语言

必须统一以下概念：

## Agent

外部执行系统（Claude / Codex / Pi）

## Adapter

将 Agent 行为转为统一 Event

## Run

一次完整执行：

Task + Agent + Workspace + Events + Result

## Event

最小事实单位（tool call / file write / message）

## Event Ledger

append-only 事件流

## Context Block

可追溯的模型输入单元

## Trajectory

Run 的行为序列 projection

## Skill

可加载能力单元

## Workspace

Agent 执行环境

## Artifact

输出产物

## Eval

对 Run / Behavior 的评估

## Failure

失败状态（可存在于成功 Run）

## Replay / Rerun / Fork

三种不同执行语义

---

# 6. 最容易破坏系统的行为

* 先做 dashboard（没有 event）
* 统一所有 agent 行为（忽略差异）
* 只保存 final output
* log 用字符串
* JSON blob 代替模型
* 无限增加 event type
* 过早 plugin system
* 过早 microservice
* 过早 database 复杂化
* 自己重新实现 agent loop
* 使用假数据做 eval

---

# 7. 修改必须覆盖的范围

## Adapter 修改

必须检查：

* raw event capture
* normalization
* lifecycle
* capability
* trace completeness

## Event Schema 修改

必须检查：

* serialization
* replay
* projection
* UI
* migration
* tests

## Context 修改

必须检查：

* provenance
* reconstruction
* diff
* token accounting

## Skill 修改

必须检查：

* lifecycle
* execution
* failure
* selection

## Eval 修改

必须检查：

* deterministic
* regression
* input stability

## Workspace 修改

必须检查：

* isolation
* cleanup
* failure recovery

## UI 修改

必须能回答：

> 这个 UI 数据来自哪个 Event？

---

# 8. 系统如何工作

Task
→ Run Config
→ Workspace Isolation
→ Adapter
→ Agent Execution
→ Raw Events
→ Normalizer
→ Event Ledger
→ Projections
→ Context / Trajectory / Artifact
→ Eval
→ Failure Analysis
→ Replay / Fork / Experience

---

# 9. P0 范围

只做：

* Adapter
* Event Ledger
* Workspace isolation
* Context reconstruction
* Trajectory
* Basic Eval

首批 Agent：

* Claude Code
* Codex
* Pi

---

# 10. 最小 Event 集合

```text
run.started
run.completed
run.failed

turn.started
turn.completed

agent.message

tool.call
tool.result
tool.error

file.change

context.snapshot

reasoning.exposed
reasoning.summary

process.started
process.completed

error
```

---

# 11. Observability Capability

每个 Adapter 必须声明：

* full
* partial
* opaque

不能假装有数据。

---

# 12. 数据设计原则

* Event append-only（JSONL / SQLite）
* ID 全局唯一（run_x / event_x）
* UTC 时间
* raw payload 保留
* 不做过早 schema explosion

---

# 13. 目录职责

```
apps/        UI / CLI 入口
core/        领域模型（Run / Event / Context）
adapters/    Claude / Codex / Pi
runtime/     process / workspace
trace/       event ledger / normalize / replay
eval/        evaluation system
ui/          visualization
experiments/ research
fixtures/    test traces
```

---

# 14. 工具链：vp

统一使用：

```bash
vp install
vp dev
vp check
vp test
vp build
```

禁止绕过 vp。

---

# 15. 技术语言

默认：

> TypeScript

原因：统一 CLI / Core / Adapter / UI / Eval。

---

# 16. Code Style

* explicit > clever
* small functions
* domain naming
* no Manager / Utils / Helper
* no any（用 unknown）
* discriminated union for events
* comments explain why

---

# 17. KISS

优先：

* function
* simple module
* explicit interface

禁止过早：

* framework
* plugin system
* DSL

---

# 18. DRY

重复可以接受，直到：

> 同一知识出现 3 次以上才抽象

---

# 19. YAGNI

禁止提前做：

* distributed system
* plugin marketplace
* agent framework
* RL training system
* multi-agent orchestration

---

# 20. Error Handling

必须包含：

* run id
* agent
* event
* command
* stderr
* context

---

# 21. Logging

区分：

* Application Log（系统自身）
* Event Ledger（Agent 行为）

不能混用。

---

# 22. 最小验证

每次修改必须：

```bash
vp check
vp test
```

---

# 23. Adapter 测试

必须有：

* real session fixture
* raw → normalized → expected

---

# 24. Event Schema 测试

必须验证：

* serialize
* deserialize
* replay
* identity

---

# 25. Context 测试

必须验证：

* provenance
* reconstruction

---

# 26. Workspace 测试

必须覆盖：

* clean / dirty
* success / failure
* cleanup

---

# 27. Bug 修复规则

Reproduce → Test → Fix → Verify

必须加 regression test。

---

# 28. 修改完成标准

必须满足：

* 代码完成
* 类型检查
* 测试通过
* 不破坏边界
* 文档同步

---

# 29. 工程品味

核心原则：

* boring core
* data before UI
* evidence before intelligence
* observation before optimization
* build mechanisms, not demos
* delete aggressively
* visible causality

---

# 30. Agent 行为规范

禁止：

* 顺手重构
* 未来优化
* 引入新 abstraction
* 修改无关代码
* 伪造数据

必须：

* 最小修改
* 保持语义
* 明确报告未验证部分

---

# 31. 当前优先级

唯一目标：

Claude / Codex / Pi → Event → Context → Trajectory → Eval

---

# 32 coding style
1. yagni
2. kiss
3. dry

# 33. 最终原则

> Every action is observable.
> Every context has provenance.
> Every improvement has evidence.

以及：

> Keep the system small enough that we can still understand why the agent did what it did.

