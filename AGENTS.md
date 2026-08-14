---
# Glassbox

> **面向 coding agents 的开源开发工具与实验基础设施**
>
> 看到你的 coding agent 实际做了什么
> 调试它为什么失败
> 对比什么有效
> 将已验证的研究转化为可复用的 agent 能力

Glassbox 运行在现有 coding agents 之上，例如 Claude Code、Codex 和 Pi。

我们**不构建新的 coding agent**。
`
我们让现有 agent 变得：

* 可观测（observable）
* 可调试（debuggable）
* 可对比（comparable）
* 可复现（reproducible）
* 可评估（evaluable）
* 并最终可以通过证据持续改进

项目背后的长期研究问题是：

> **agent 的经验如何转化为能力？**

产品问题更简单：

> **我们能否让 agent 行为足够可观测，从而让改进 agent 变成工程问题，而不是猜测？**

---

# 本项目是什么

Glassbox 是一个**研究驱动的开源开发产品**。

研究负责发现机制。

产品负责将机制交付给用户。

循环如下：

```text
论文 / 问题
      ↓
假设
      ↓
原型
      ↓
真实 agent 运行
      ↓
trace
      ↓
评估
      ↓
证据
      ↓
回归验证
      ↓
推广
      ↓
产品能力 / Glassbox Pack
```

研究结果不是因为“论文复现成功”就结束。

而是在我们真正理解以下问题时才结束：

1. 它解决了什么问题
2. 什么时候有效
3. 什么时候失效
4. 成本是什么
5. 是否可泛化
6. 是否值得成为产品能力

---

# 产品形态

Glassbox 有三层产品结构：

## Observe（观测层）

理解 agent 实际做了什么。

例如：

* 执行时间线
* tool 调用
* tool 返回
* 文件变更
* context snapshot
* context 来源
* context diff
* skill 生命周期
* reasoning（显式或摘要）
* 错误
* 恢复过程
* token / 时间数据

可以理解为：

> **agent 的飞行记录器**

---

## Lab（实验室）

用于实验 agent 行为。

例如：

* Claude vs Codex vs Pi
* Skill ON / OFF
* Harness v1 vs v2
* context policy A vs B
* replay
* rerun
* fork
* benchmark
* 回归评估
* failure attribution

可以理解为：

> **agent 的 A/B 测试与调试实验室**

---

## Packs（能力包）

将已验证研究转化为可应用能力。

例如：

```text
verification
context-hygiene
tool-recovery
debugging
skill-routing
memory-policy
```

一个 Pack 可能包含：

* trigger 逻辑
* 指令
* context policy
* skill 行为
* verification 规则
* evaluator
* 回归任务
* 其存在的证据

在至少两个真实能力被推广之前，不要设计通用 Pack 框架。

抽象必须从证据中自然出现。

---

# 本项目不是什么

Glassbox 不是：

* 另一个 Claude Code
* 另一个 Codex
* 另一个 Pi
* chatbot 框架
* 通用 agent builder
* workflow 自动化平台
* LangChain 替代品
* prompt 管理 SaaS
* MCP marketplace
* 模型抽象层
* 论文复现仓库
* “漂亮 trace dashboard”
* “自进化 AI 平台”

我们复用现有 agent。

我们观测它们、测试它们、理解它们，并改进它们周围的软件。

> **带上你的 agent，保留你的 agent，在外面加一层 Glassbox**

---

# Glassbox 的核心特性

以下原则不可妥协：

---

## 1. Glassbox 必须是“玻璃盒”

我们存在的原因是 agent 不透明。

不能引入新的隐藏行为。

用户必须能够回答：

```text
发生了什么？
agent 看到了什么？
context 从哪里来？
调用了哪个 tool？
加载了哪个 skill？
哪里失败了？
哪里发生变化？
有什么证据支持这个解释？
```

如果 Glassbox 不知道，就必须说不知道。

不能编造。

---

## 2. model 所见必须可重建

如果 Glassbox 声称某信息进入 context，则必须能恢复：

```text
内容
来源
来源身份
进入时间
引入者
作用域
版本 / hash
可见性
token 贡献（如果可得）
```

context 不是字符串，而是：

```text
内容 + 来源 + 生命周期 + 作用域
```

如果 provider 不支持完整恢复，则必须标记：

* partial
* opaque

不能伪造完整性。

---

## 3. event 是唯一事实源

核心数据流：

```text
执行
  ↓
原始事件
  ↓
标准化事件
  ↓
事件账本（Event Ledger）
  ↓
projection
  ↓
CLI / UI / eval / replay
```

UI 不能成为事实源。

不能从 UI 反推历史事实。

所有行为必须来自事件。

---

## 4. 原始证据不可变

provider 原始输出是证据。

一旦记录：

* 不能静默修改
* 不能覆盖

可以演化的是：

* normalization
* classification
* projection
* annotation
* evaluation
* failure analysis

但不能覆盖原始事实。

---

## 5. 不允许伪造可观测性

不能声称访问模型未暴露的信息。

必须区分：

```text
exposed（真实暴露）
summary（摘要）
derived（推导）
opaque（不可见）
```

derived 必须明确标注。

不能伪装成 hidden chain-of-thought。

---

## 6. 每个改进必须有证据

不是证据：

> “这个 prompt 感觉更好”

也不是：

> “论文说应该有效”

必须有对比：

```text
baseline vs treatment
```

在相同条件下：

* task
* workspace
* agent
* environment
* config
* evaluator

记录：

* 成功率
* 失败
* 回归
* 成本
* latency
* tool 行为
* context 影响
* 质量指标

没有证据，不进入产品。

---

## 7. failure 是一等数据

失败 run 往往比成功更有价值。

必须保留：

* events
* context
* tool calls
* tool results
* errors
* workspace diff
* skill lifecycle
* evaluation
* artifacts

不能只做：

```text
PASS / FAIL
```

---

## 8. 现有 agent 保持原样

Claude / Codex / Pi 仍然负责自己的执行循环。

adapter 只是桥。

不能重写 agent 行为。

如果要实现：

* planning loop
* tool loop
* autonomy

必须先问：

> 为什么现有 agent 不能自己做？

没有强理由就不要做。

---

## 9. 复杂性必须在边界

provider 复杂性在 adapter。

副作用在 runtime。

核心必须简单。

UI 只做 projection。

不要把 provider 分支泄漏到 core。

---

## 10. 本地优先

Glassbox 处理敏感信息：

* 源码
* prompt
* tool output
* 文件路径
* 可能的凭证
* 对话历史

不能默认上传。

不能默认云依赖。

所有远程能力必须显式。

---

## 11. 核心必须开放

核心必须可读、可 fork、可扩展。

研究逻辑必须可见。

benchmark 方法必须可见。

Pack 必须可解释。

---

# 项目原则

我们要用简单系统构建强能力。

不要因为“已经写了”就保留复杂性。

不要因为“看起来高级”就设计架构。

不要因为论文权威就照搬实现。

理解机制 → 测试 → 最小模型 → 删除多余抽象

优先级：

```text
清晰 > 聪明
证据 > 直觉
真实运行 > demo
机制 > 营销
小系统 > 大平台
删除 > 过早抽象
```

---

# 共享语言

## you

当前修改仓库的 agent / contributor

## we / maintainers

维护 Glassbox 的人

## user

使用 Glassbox 的人

## agent

执行任务的 coding agent

例如：

```text
Claude Code
Codex
Pi
```

## provider

外部 agent runtime

## adapter

连接 provider 的适配层

## Run

一次 agent 执行

包含：

* task
* config
* workspace
* events
* result
* artifacts
* evaluation

## Session

provider 原生会话

## Turn

一次交互轮次

## Step

内部执行单元（不统一）

## Raw Event

原始 provider 事件

## Event

标准化事件

例如：

```text
run.started
tool.call
file.change
error
```

## Event Ledger

事件账本（唯一事实源）

## Projection

基于 event 的视图

## Trajectory

行为路径（projection）

## Context Block

context 单元

## Context Snapshot

某次模型输入的可重建状态

## Context Diff

snapshot 差异

## Provenance

来源链路

## Skill

可复用能力单元

## Pack

已验证能力集合

## Workspace

执行环境

## Artifact

输出结果

## Eval

评估过程

## Failure

失败行为

## Replay

重放历史

## Rerun

重新执行

## Fork

分支执行

## Experiment

实验

## Evidence

证据

## Promotion

从 research → product

## Regression

回归问题

---

# 最容易破坏 Glassbox 的方式

## 1. 编造观测信息

不能伪造不可见信息

---

## 2. 修改历史证据

raw event 不可变

---

## 3. 破坏用户机器

不能随意 kill process / 删除文件

---

## 4. provider 逻辑泄漏到 core

禁止 if (provider === ...)

---

## 5. 过早产品化研究

没有证据不能进 product

---

## 6. 先做 dashboard 再做数据

数据优先

---

## 7. 为不存在的 provider 设计抽象

只为真实 provider 建模

---

## 8. 把 Glassbox 变成 agent

不要重写 agent loop

---

# Research 是一等流程

```text
问题
↓
论文
↓
假设
↓
原型
↓
真实运行
↓
测量
↓
失败分析
↓
结果
```

---

# Research → Product gate

必须回答：

* problem
* hypothesis
* baseline
* treatment
* real runs
* eval
* cost
* regression
* scope
* evidence

---

# Stable vs Research

## research/

回答：

> 什么可能有效

## packages/

回答：

> 什么已经被证据证明值得产品化

---

# 产品形态

* CLI
* Web UI
* Agent integration
* Packs

---

# Observability

必须区分：

* full
* partial
* opaque

---

# Event / Context / Skill / Failure / Eval / Replay / Fork

全部必须基于证据，不允许虚构。

---

# 工程原则

* KISS
* DRY（谨慎）
* YAGNI
* 小而清晰
* 可删除
* 可追踪
* 可解释

---

# 最终原则

> 每个行为都必须可观测
> 每个 context 都必须有来源
> 每个改进都必须有证据

以及：

> 系统必须小到我们仍然能解释 agent 为什么这么做

