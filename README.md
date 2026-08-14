# Glassbox

> **看清你的编码 Agent 到底做了什么。**

Glassbox 是一个开源的可观测性与实验层，用于编码 Agent。

它运行在你本地已经在使用的 Agent 之上——目前支持 **Claude Code、Codex 和 Pi**。

Glassbox 不会替代它们。

它的作用是让它们更容易被**观察、调试、对比、评估与改进**。

```text
Claude Code ─┐
Codex ───────┼──→ Glassbox ──→ Trace / Context / Tools / Skills / Failures / Eval
Pi ──────────┘
```

## 为什么需要它？

编码 Agent 很强大，但它们的执行过程通常很难被看清。

当一个 Agent 失败时，我们想知道：

* 它到底“看到了”什么？
* 这些上下文从哪里来的？
* 调用了哪些工具？
* 加载了哪些 skills？
* 从哪里开始出错的？
* 为什么一个 Agent 成功而另一个失败？
* 一个新的 skill / prompt / harness 改动是否真的带来了提升？

Glassbox 把 Agent 的执行过程变成可以被**观察与实验**的对象。

可以理解为：

> **飞行记录器 + DevTools + Agent 实验室**

## 我们在做什么

### 观察（Observe）

查看真实的 Agent 运行过程：

* 执行时间线
* 工具调用与结果
* 文件变更
* 上下文快照
* 上下文来源（provenance）
* 上下文差异（diff）
* skill 生命周期
* 错误与恢复过程
* token 与耗时数据

---

### 实验（Lab）

运行对比实验：

```text
Claude vs Codex vs Pi

Skill 关闭 vs Skill 开启

Harness v1 vs Harness v2

Context A vs Context B
```

可以回放运行过程，对比行为，分析失败路径，并最终基于某次执行状态“分叉”实验。

---

### 改进（Improve）

Glassbox 同时也是一个研究项目。

我们会研究现代 Agent 相关方法，在真实编码 Agent 上验证，并只保留那些通过评估与回归测试的机制。

```text
研究
  ↓
实验
  ↓
真实运行
  ↓
证据
  ↓
回归验证
  ↓
产品能力
```

长期目标很简单：

> **让 Agent 的改进变成一门科学。**

## 核心原则

Glassbox 由三条原则定义：

> **每一个行为都必须可观测。**
> **每一份上下文都必须有来源。**
> **每一次改进都必须有证据。**

如果某些信息无法被观测，Glassbox 会明确指出。

我们不会伪造隐藏推理，也不会假装不完整的 trace 是完整的。

## 当前状态

Glassbox 仍然处于**非常早期阶段**。

第一个目标刻意保持简单：

```text
Claude Code / Codex / Pi
          ↓
       Adapters
          ↓
   Universal Events
          ↓
     Event Ledger
          ↓
Context Reconstruction
          ↓
      Trajectory
          ↓
      Basic Eval
```

不做庞大的 Agent 平台。

不引入新的 Agent loop。

不做“自进化系统”的幻想设计。

第一步只是：

> 让现有 Agent 变得可见。

然后再从可见性中学习。

## 研究驱动开发

研究与产品并行，但实验性想法不会自动进入产品。

```text
research/
    ↓
什么可能有效？

packages/
    ↓
什么值得进入产品？
```

负结果同样有价值。

我们更关心的是**为什么有效**，而不是简单收集论文里的功能。

## 开发方式

Glassbox 使用 **Vite+** 和 `vp` 作为工具链。

安装依赖：

```bash
vp install
```

启动开发：

```bash
vp dev
```

检查项目：

```bash
vp check
```

运行测试：

```bash
vp test
```

构建：

```bash
vp build
```

在进行重大修改前，请先阅读 [`AGENTS.md`](./AGENTS.md)。

其中包含项目的工程原则、领域语言、研究到产品的规则、架构边界与验证要求。

## 项目方向

Glassbox 的最终目标是：

让你继续使用自己喜欢的 coding agent，同时在外层加一层统一的观测与实验能力。

```text
                  Glassbox

        观察   实验   改进
           │      │      │
      ┌────┴──────┴──────┴────┐
      │                        │
 Claude Code     Codex        Pi
```

带上你的 Agent。

保留你的 Agent。

在外面加上 Glassbox。

---

**Glassbox**

*面向编码 Agent 的开源开发工具与实验基础设施。*

