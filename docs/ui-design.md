# Glassbox Web Management UI 设计规范

状态：**DESIGN FREEZE v2 — 统一设计契约与实现入口**

本文件是 Glassbox Web 管理后台（Web Management UI）的统一设计规范与唯一文档入口。

它系统整合了外部设计材料（Design Freeze v2）的全部事实、设计原则、信息架构、组件基元（Primitives）、视觉交互规范、评估验收清单、Vercel 合规要求以及已确认/待确认边界。

原始外部材料归档参见：
- [`docs/design-inputs/DESIGN.md`](design-inputs/DESIGN.md)
- [`docs/design-inputs/DESIGN_EVAL.md`](design-inputs/DESIGN_EVAL.md)
- [`docs/design-inputs/UI_PRIMITIVES.md`](design-inputs/UI_PRIMITIVES.md)
- [`docs/design-inputs/glossbox_vercel_admin_v24_vercel_compliance.html`](design-inputs/glossbox_vercel_admin_v24_vercel_compliance.html)（可独立预览的 v24 交互原型）

---

## 1. 设计原则与产品边界

### 1.1 产品定位

Glassbox Web Management UI 是面向**所有者（Owner）**的管理、可观测性、审计与配置控制表面。

**它不是主对话界面。**

在 Glassbox 中，对话（Conversation）始终是主要控制入口与人机协作通道。Web Management UI 的核心价值是回答以下事实问题：

```text
Agent 当前在做什么？
有哪些工作正在等待处理？
系统运行了什么？
为什么会运行？
涉及了哪些模型 / Tool / Skill / Memory / Worker？
产生了多少成本与 Token 消耗？
是什么授权决策（ALLOW / DENY / REQUIRES_APPROVAL）允许或拒绝了它？
有哪些事项需要 Owner 的介入与决策？
哪些是持久化的产品事实，哪些是实时的外部观测？
```

### 1.2 核心产品边界与不变式

Web Management UI 的所有设计与实现必须严格遵守 [`../AGENTS.md`](../AGENTS.md) 与系统架构不变式：

```text
Identity ≠ Authorization （身份不等于授权）
Permission ≠ Approval （权限不等于审批）
Channel ≠ Agent （渠道不等于 Agent）
Conversation ≠ Principal （会话不等于主体）
Conversation ≠ PI Session （会话不等于 PI 执行会话）
PI Session ≠ Run （执行会话不等于具体执行）
Task ≠ Run （任务不等于单次执行）
Task ≠ Worker （任务不等于具体执行 Worker）
TaskAttempt ≠ Herdr pane （任务尝试不等于终端窗格）
WorkerBinding ≠ Task truth （执行绑定不等于任务真值）
Herdr Agent state ≠ Task acceptance （Herdr 工作完成不等于任务验收）
Raw Trace ≠ Derived State （原始追踪证据不等于派生状态）
Canvas ≠ Execution State （画布投影不等于执行状态）
```

### 1.3 核心协作铁律：Herdr 状态与 Task 验收

```text
Herdr worker = done
≠
Glassbox Task = DONE
```

Herdr 报告的是外部实时执行事实；Glassbox 拥有持久化的任务真值与验收裁决权。

标准状态映射关系如下：

```text
Herdr working
→ TaskAttempt RUNNING

Herdr blocked
→ Task 状态可变为 WAITING_INPUT
→ 生成 AttentionItem(worker_blocked)

Herdr done
→ TaskAttempt 阶段结算
→ Task 进入 REVIEW 状态
→ 生成 AttentionItem(task_review)

授权 Accept 操作
→ Task 变更为 DONE

授权 Rework 操作
→ 保留先前 TaskAttempt 历史证据
→ 创建 / 恢复下一轮 TaskAttempt
```

### 1.4 双重层级结构（执行与协作）

系统包含两条交叉但绝不可混淆的层级：

- **执行层级（Execution Hierarchy）**：
  ```text
  PI
  → Model
  → Run
  → Trace Event
  ```

- **任务协作层级（Work-Coordination Hierarchy）**：
  ```text
  Conversation
  → Task
  → TaskAttempt
  → WorkerBinding
  → Herdr live worker
  ```

### 1.5 四道硬性安全门禁（Four Hard Gates）

UI 必须如实展示并审计四道独立的安全门禁，不得假设模型遵循 Prompt：

1. **入口门禁（Ingress Gate）**：
   - 触发时机：调用 PI 执行引擎之前。
   - 检查内容：ChannelIdentity、Principal、来源位置、群聊激活规则（如 `@` 触发）、自消息过滤、重复消息去重、渠道黑白名单。
2. **上下文门禁（Context Gate）**：
   - 触发时机：装配模型可见上下文之前。
   - 铁律：**先验证资源授权，再加载数据**。绝不能将受保护数据装载进上下文后依赖 Prompt 保持保密。
3. **工具 / 操作门禁（Tool / Ops Gate）**：
   - 触发时机：执行任何受保护操作或工具调用即刻前。
   - 覆盖范围：本地工具、Ops 操作、`worker_read`、`worker_prompt`、`task_delegate`、`task_accept`、`task_rework`、`task_cancel` 等。
4. **交付门禁（Delivery Gate）**：
   - 触发时机：结果离开 Glassbox 边界前。
   - 铁律：`actor_can_read ≠ audience_can_receive`。执行者有权读取数据，不代表当前受众有权接收。

### 1.6 数据诚实性与能力状态词汇

严禁在 UI 中编造数据，包括：Token 消耗、美元成本、配额、模型可用性、连接状态、健康度、授权结论、Worker 状态与 Task 状态。

UI 中必须统一使用规范的能力状态词汇：

| 状态词汇 | 语义定义 | 表现规范 |
| --- | --- | --- |
| **已实现** | 当前仓库已有真实代码支持的能力 | 绿色语义状态点 |
| **P3 目标** | 当前 active Plan（Plan 03）所要求的目标能力，但尚未在主路径实现完成 | 琥珀色语义状态点，禁止伪装成已实现 |
| **设计数据** | 原型占位 / 静态演示假数据 | 必须带有明确标注，提示为演示数据 |
| **后续** | 属于长期路线图（Roadmap），不在当前实现范围 | 中性灰色状态点 |
| **未知** | 属于有意义字段，但当前系统或 Provider 未上报 | 明确展示为 `未知` 或 `未知（未上报）` |
| **—** | 字段在当前上下文完全不适用 | 破折号 |

- **成本未知规则**：严禁用 `$0.00` 表示未知的定价或尚未统计的费用，未定价时显示 `成本不可用` 或 `未知`。
- **派生指标标注**：如 Cache Hit Rate 等属于前端计算指标的，需明确标明为 `计算指标`，与 Provider 原生指标区分开。

### 1.7 敏感数据清洗与投影（Sanitized Projections）

管理 UI 所展示的会话和执行日志为**清洗后的受保护投影**。

- 敏感数据需替换为标准标记：
  - `[REDACTED]`：通用敏感字段
  - `[REDACTED_ID]`：外部个人标识
  - `[REDACTED_REPO_PATH]`：私有仓库绝对路径
  - `[SCREENED_PATH]`：受保护路径
- 包括：API 密钥、凭据、密码、私有路径、受保护的工具输出和 Worker 原始输出。
- 原始只追加证据保留在独立的 Raw Trace 审计层中。

---

## 2. 信息架构与页面结构

### 2.1 全局导航架构

管理后台采用左侧固定侧边栏（Desktop 232px，Mobile 为抽屉式 Drawer）与顶部全局栏（Topbar）。

页面划分为 3 大功能区、共 11 个独立页面：

```text
工作台 (Workbench)
  ├── 概览 (Overview)
  ├── 会话 (Conversations)
  ├── 任务协作 (Task Collaboration)
  ├── 身份与访问 (Identity & Access)
  ├── 运行记录 (Runs)
  └── 追踪 (Trace)

PI
  ├── PI (PI Engine & Models)
  ├── 渠道与集成 (Channels & Integrations)
  ├── 权限 (Permissions)
  └── 监控 (Monitor)

系统 (System)
  └── 设置 (Settings)
```

**顶部全局栏（Topbar）元素**：
- 面包屑（Breadcrumb）：清晰反映当前功能区与页面位置。
- 仓库与分支指示：`lora-sys/Glassbox-Agent-Harness` · `main`。
- 当前架构阶段标识：如 `P3 阶段`。
- 全局快捷指令：`⌘K` 呼出 Command Palette。
- 右侧主动作：`打开对话`（引导至主要对话通道，**严禁放置突出的 “New Run” 按钮**）。

### 2.2 全局详情视图阅读法则（Information-Order Rule）

所有对象详情面板（Detail Rail / Modal / Drawer）统一遵循自上而下的阅读逻辑：

```text
Identity (身份)       → 标识符、名称、类型、归属
→ State (状态)         → 运行状态、健康度、真值裁决
→ Relationships (关联) → 关联的会话、任务、Worker 绑定、主体
→ Activity (活动)      → 最近动作、测试结果、审查操作
→ Usage (消耗)         → Token 明细、耗时、成本
→ Evidence (证据)      → Trace 关联、Diff 文件、产物 Artifacts
```

### 2.3 11 个页面结构契约

#### 1. 概览 (Overview)
- **定位**：浅层、快速的操作态盘点，绝不搞成复杂的重度分析大屏。
- **页面组成**：
  1. `PageHeader`：页面标题与极简定位。
  2. `SummaryBar`：核心指标条（24h Runs、Total Token、USD Cost、Needs Attention）。
  3. `TwoColumn`：
     - 左列：待处理事项列表（Needs Attention，如 `task_review`、`worker_blocked`、`approval_required`、`delivery_failed`）。
     - 右列：当前运行状态卡（Current Run，包含 Run ID、会话、任务/尝试、模型、状态、最新事件、Token/Cost）。
  4. `ChartPanel`：单条核心使用量趋势图（如 24 小时 Run / Token 趋势）。
  5. `DataTable`：PI 模型用量汇总表（Model Usage）。

#### 2. 会话 (Conversations)
- **定位**：主从布局（Master-Detail），按会话维度追踪运行与成本。
- **页面组成**：
  1. `MasterDetail` 容器：
     - **左侧列表**：支持搜索、渠道过滤（Web/QQ）、可见性过滤、任务关联过滤。列表项展示标题、渠道标识、PI 模型、可见性、Run 数、Task 数、Token、成本、更新时间。
     - **右侧详情**：
       - 顶部元数据：Principal、Channel、Scope、Visibility、PI Session、Runs、Tasks、24h 成本、最后活跃时间。
       - 会话轮次分段（Turns）：按时间段划分，展示轮次模型、Run、Token（Input/Cache Read）、Cost、调用工具数。
       - 清洗后消息流投影：展示带脱敏标记的消息。
       - 关联 Task 列表与执行血缘。

#### 3. 任务协作 (Task Collaboration)
- **定位**：协调 Agent Ops、任务真值与 Herdr Worker 执行事实。
- **页面组成**：
  1. `Notice`：提醒“Herdr worker done ≠ Glassbox Task DONE”。
  2. `SummaryBar`：展示 `AgentOpsSnapshot`（待办总数、进行中任务、审核中任务、今日完成任务、活跃 Worker 数）。
  3. `FilterBar`：状态筛选、优先级筛选、搜索。
  4. `DataTable + DetailRail`：
     - **Task 表格**：Task ID、标题、状态（NEW/QUEUED/ASSIGNED/RUNNING/WAITING_INPUT/REVIEW/DONE/FAILED/CANCELED）、优先级、Attempt、Worker、更新时间。
     - **DetailRail 详情**：明确对比展示 **Glassbox 任务真值** 与 **Herdr 观测状态**；展示 TaskAttempt 测试结果、成果物链接；WorkerBinding 绑定的 Herdr session / workspace / worktree / pane；提供受保护操作（`Accept`、`Rework`、`worker_read`、`worker_prompt`、`Cancel` 等）。
  5. `AttentionQueue`：主 Agent 或人工当前待办队列。
  6. `WorkerTable`：实时 Herdr Worker 列表（状态包括 working、blocked、done、idle、unknown、stale）。
  7. `ReconcileSteps`：展示 HerdrBridge 重连与状态调谐步骤。

#### 4. 身份与访问 (Identity & Access)
- **定位**：调试外部身份解析链条、访问主体及其关联关系。
- **页面组成**：
  1. `SummaryBar`：主体总数、外部身份映射数、活跃关系数。
  2. `IdentityChain` 可视化流：`ChannelIdentity → User → Principal`。
  3. `DataTable(Principals) + DetailRail`：
     - 主体列表：展示 Principal ID、类型（Owner / Visitor / Worker / System）、关联渠道身份、验证状态、冲突状态、最近活跃。
     - 详情轨：可见性范围、授权关系来源、近期授权决策、委托约束。
     - 核心辅助动作：`以此主体测试`（一键带入权限决策测试器，进行安全模拟）。
  4. `DataTable(Relationships)`：资源访问关系表。

#### 5. 运行记录 (Runs)
- **定位**：单次具体 Agent 执行记录的审计与复盘。
- **页面组成**：
  1. `FilterBar`：按模型、状态、耗时、关联任务过滤。
  2. `DataTable(Runs)`：Run ID、Work 描述、Principal、Model、Task/Attempt、工具调用数、变更文件数、测试结论、Token 总量、状态。
  3. `DetailRail`：包含三级 Tab：
     - **摘要 (Summary)**：会话、主体、PI Session、Model、思考阶段、耗时、TaskAttempt、输入输出 Token、Cache Read、Cost。
     - **文件与测试 (Files & Tests)**：文件变更列表、Diff 统计、测试套件通过/失败情况。
     - **证据 (Evidence)**：Trace 事件数、原始事件数、Diff Artifacts、测试报告、Replay 跳转链接。
  4. **约束**：Run 详情页禁止完整复制 Trace 时间线，Trace 属于独立的深层审计页面。

#### 6. 追踪 (Trace)
- **定位**：核心执行审计表面，完整语义执行路径的时间线与检查器。
- **布局结构**：三栏式布局（Run List → Event Timeline → Inspector）：
  - **左栏（Run List）**：高密度 Run 切换列表，展示标题、模型、事件数、Token、耗时、小火花线（Sparkline）。
  - **中栏（Event Timeline）**：规范化、去重、脱敏后的语义时间线。支持全语义执行路径事件渲染。
  - **右栏（Inspector）**：选中事件的详细检查器，包含三个 Tab：
    - `摘要`：方法、类别、说明、关联实体、脱敏状态。
    - `用量`：规范化 Token/Cost 细分。
    - `原始`：规范化 JSON 投影。
- **键盘交互支持**：
  - `j` / `k`：上一个 / 下一个事件。
  - `e`：展开 / 折叠当前事件。
  - `/`：聚焦搜索框。

#### 7. PI
- **定位**：管理主 Agent 执行核心、Lora PI Kit 分发及模型配置。
- **页面组成**：
  1. `PIEnginePanel + PIKITPanel`：PI 引擎状态（版本、集成模式、运行会话）与 Lora PI Kit 状态（Bridge、Hooks、预设配置、兼容锁）。
  2. `ModelCards`：模型卡片网格，展示模型 ID、来源、默认标记、Thinking/Tool 配置、上下文上限、用量与成本、配额重置时间。
  3. `ConfigProfileTable`：PI 配置 profile 列表。
  4. `ChartPanel`：模型使用分布与时延对比。
  5. `ModelUsageTable`：详尽的模型用量数据表。
  6. `SessionHealthTable`：执行会话健康度监控。
- **硬性约束**：禁止在此页面重新引入 Codex Admin / Claude Code Admin / Provider Management 等多 Runtime 配置表。

#### 8. 渠道与集成 (Channels & Integrations)
- **定位**：管理进入 Glassbox 的外部交互渠道。
- **页面组成**：
  1. `ChannelCards`：渠道目录卡（Workbench Web、QQ / NapCat / OneBot 11 等），展示连接状态、收发统计、交付成功率、重复事件抑制数、重连次数。
  2. `ChannelContractTable`：渠道安全契约表（Ingress、Identity、Conversation、Tool Gate、Delivery Gate 约束）。
  3. `IdentityMappingTable`：渠道身份映射规则表。
  4. `ActivityTable`：近期渠道出入站吞吐与异常日志。

#### 9. 权限 (Permissions)
- **定位**：决策优先（Decision-first），而非统计分析优先。
- **页面组成**：
  1. `SummaryBar`：决策总数、允许、拒绝、待审批统计。
  2. `DecisionTable`：历史授权决策列表（请求主体、操作、资源、环境上下文、裁决结论 ALLOW / DENY / REQUIRES_APPROVAL）。
  3. `DecisionTester`：决策测试器（纯沙箱模拟，输入 Principal × Action × Resource × Context 进行授权推演，不修改真实策略）。
  4. `ApprovalQueue`：高风险待审批队列（如工作区删除、私有成果公开共享、高特权 Worker 指令）。
  5. `PolicyProvenance`：策略判定依据溯源。
  6. `GateReference`：四道安全门禁规则参考。

#### 10. 监控 (Monitor)
- **定位**：系统健康度 + 产品运作健康度（区分产品真值与观测事实）。
- **页面组成**：
  1. `ServiceHealthTable`：基础设施服务健康表（PI Engine、HerdrBridge、WebSocket、Turso 数据库、R2 证据存储、渠道网关）。
  2. `ChartPanel`：核心服务时延与错误率趋势。
  3. `SummaryBar`：Agent Ops 运作健康度（待审核任务数、受阻任务持续时间、重做率、Herdr 重连频次）。
  4. `StorageTable`：存储使用量与保留策略（Turso、R2、内存缓冲区）。
  5. `AlertsList`：告警与异常事件列表。

#### 11. 设置 (Settings)
- **定位**：管理系统的稳定默认值，采用标准 Vercel 分组风格。
- **分组结构**：
  - `通用`：语言、密度、关联代码库、成本币种。
  - `PI`：默认模型、Thinking 默认开关、PI profile。
  - `渠道默认值`：QQ 激活规则（`@` 触发）、重复事件抑制窗口、交付默认策略。
  - `Trace 与证据`：原始 Trace 保留期、大输出存储策略、脱敏级别。
  - `任务协作`：HerdrBridge 连接参数、重连重试次数、Worker 阻塞超时阈值。
  - `告警与通知`：任务待审核通知、Worker 异常受阻通知、授权异常告警。
- **硬性约束**：**严禁在设置页面直接编辑或篡改 Task 真值、Conversation 真值、权限关系或审计历史。** 表单开关必须使用原生语义控件。

---

## 3. UI Primitives 与组件规范

为了防止前端实现随意造轮子导致视觉风格分裂，UI 实现必须严格组合以下经锁定的 Primitives：

### 3.1 核心 Primitives 规范

| Primitive 名称 | 职责与渲染要求 | 禁止行为（Anti-Patterns） |
| --- | --- | --- |
| `PageShell` | 负责整体页面框架、侧边栏（Desktop 232px / Mobile Drawer 44px 触控目标）、顶栏 Breadcrumb 及全局容器。 | 禁止各个页面单独实现自己的外层导航框架。 |
| `PageHeader` | 包含 `h1` 标题、简明说明段落、可选状态 Badge 与页面级主操作。 | 禁止在 PageHeader 内部塞入巨型 KPI 卡片。 |
| `SectionHeader` | 区域标题、简要次级说明与右侧辅助动作。全局统一间距。 | 禁止使用花哨的渐变背景或夸张图标。 |
| `FilterBar` | 集合搜索框（SearchInput）、下拉选择（Select）、分段筛选（SegmentedFilter）与结果计数（ResultCount）。 | 过滤操作绝不能直接篡改底层产品数据真值；移动端输入框字体需 ≥16px（防止 iOS 自动放大）。 |
| `DataTable` | 默认对象管理基元。支持固定表头（Sticky Head）、局部横向滚动（Local Scroll）、选中态与键盘焦点。 | 禁止用松散的卡片网格（Card Grid）替换密集的管理表格。 |
| `DetailRail` | 选定对象详情侧轨（Desktop 侧边展示，Mobile 堆叠在下方）。严格遵守阅读法则。 | 禁止将 DetailRail 膨胀成另一个脱离上下文的全尺寸页面。 |
| `SummaryBar` | 4–6 个紧凑数值构成的简敛摘要横条（如 AgentOpsSnapshot）。 | 严禁使用浮夸的独立巨型 KPI 瓷砖卡片。 |
| `EntityMark` | 辨识度实体的标准视觉徽标（PI、Herdr、QQ、Web、Turso、R2、Owner、Visitor、Worker 等）。 | 严禁将 Glassbox 吉祥物作为实体的通用系统图标。 |
| `Status` | 小色点（Dot）+ 白/中性底色 + 语义文字 + 细边框构成的极简状态标签。 | 避免在不需要时使用全色块实心胶囊破坏呼吸感。 |
| `PrimaryButton` | 纯黑背景（`#111111`）按钮，仅用于当前局部上下文唯一的核心主操作（如 Accept、执行检查）。 | 禁止将所有按钮都设置成黑色主按钮。 |
| `SecondaryButton`| 白底细边框按钮，作为系统最常规的操作按钮。 | 保持轻盈与统一边框。 |
| `DangerButton` | 红色描边/文字，仅用于显式的破坏性操作（如 Cancel Task、删除 Worktree、强制终止 Worker）。 | 禁止仅因为状态是 Deny 就给普通按钮套用危险样式。 |
| `Tabs` | 用于同一对象内部紧密关联的不同视图切换（如 Run Detail 的 3 个 Tab、Trace Inspector 的 3 个 Tab）。 | 禁止将 Tabs 替代为全局主要导航。 |
| `SettingsGroup` | Vercel 风格的配置分组，包含组名、行说明、值展示及原生操作控件。 | 开关必须使用原生语义 `<input type="checkbox">`，禁止用纯 `div/span` 模拟无无障碍属性的开关。 |
| `MasterDetail` | 主从布局，专用于会话（Conversations）等需要左边浏览右边深入的对象。 | 移动端自动转为上下堆叠或线性下钻。 |
| `TraceRunList` | Trace 页面专用左侧高密度 Run 选择列表，支持显示小火花线。 | 保持高信息密度与明确的激活态标记。 |
| `TraceEvent` | 语义事件卡片。左侧依据事件类别附带 3px 语义色标，包含序号、时间戳、方法名、摘要及展开元数据。 | 禁止为每一种事件类型发明一套完全不同的卡片排版。 |
| `TraceInspector`| Trace 右侧审计检查器，固定具备 `摘要`、`用量`、`原始` 三个 Tab。 | 保持统一字段排列与 JSON 代码高亮。 |
| `ChartPanel` | 辅助上下文图表容器，包含标题、简述、范围切换、图表区、图例及数据定义。 | 图表绝不能代替精准数据表格；严禁装饰性空洞图表；严禁将品牌琥珀色作为随意的数据序列颜色。 |
| `EmptyState` | 空状态容器，用于合法操作后列表为空的场景。文案清晰简明。 | 严禁显示编造的 `0`；严禁使用占满屏幕的巨幅空状态插画。 |
| `Notice` | 极简行内提示框，用于安全边界提醒、真值与观测区别提示、脱敏通知。 | 禁止滥用为到处出现的装饰性气泡。 |
| `NativeFormControls`| 原生语义表单控件（button, input, select, checkbox, radio, label）。 | 严格维护 `for`/`id` 绑定与键盘焦点轮廓。 |

### 3.2 组件级反模式（Anti-Patterns）清单

开发与前端实现过程中，严禁出现以下 11 种设计反模式：

1. **Giant KPI Card**（巨型 KPI 瓷砖）
2. **Glassmorphism / Glass Card**（毛玻璃与高光拟物卡片）
3. **Gradient Hero**（炫目但无信息增益的渐变大横幅）
4. **AI Glow / Magic Purple**（通用的 AI 紫色光晕与玄学动效）
5. **Rounded-Everything**（无节制的大圆角，破坏专业管理感）
6. **Card-per-Field**（一个字段套一个大白卡片，信息密度极低）
7. **Card-per-Event-Kind**（为每种 Trace 事件各自搞一套特异排版）
8. **Provider Admin Card Grid**（把 PI 管理做成公有云厂商模型市场大图列表）
9. **Analytics-first Overview**（把概览页做成重度 BI 分析仪表盘大屏）
10. **Analytics-first Permissions**（把权限页面做成各种图表，而非裁决决策与测试优先）
11. **Observability-SaaS Monitor Wall**（把监控页面做成 Datadog/Grafana 式的指标墙，丢掉 Agent Ops 特性）

---

## 4. 视觉与交互规范

### 4.1 颜色系统与表面规范（Surfaces & Semantics）

管理界面严格遵循 Vercel 风格的克制单色基调，搭配精准的语义色彩：

```css
/* 基础表面与线条 */
--bg:           #FAFAFA;  /* 全局底层背景 Canvas */
--surface:      #FFFFFF;  /* 卡片、面板、表格背景 Surface */
--side:         #F5F5F5;  /* 侧边栏背景 Sidebar */
--border:       #EAEAEA;  /* 默认常规细边框 */
--border-strong:#D4D4D4;  /* 强化边框 / 分割线 */

/* 字体颜色 */
--ink:          #111111;  /* 标题、强强调字 Ink */
--text:         #333333;  /* 正文 Body */
--secondary:    #666666;  /* 次级正文 Secondary */
--metadata:     #737373;  /* 元数据文字 Metadata */
--disabled:     #999999;  /* 禁用 / 占位符 Disabled */

/* 语义颜色 */
--brand:        #C97A24;  /* 品牌色 / 选中态 / 授权特征 暖琥珀色 */
--brandSoft:    #FBF2E8;  /* 品牌浅底色 */
--green:        #238636;  /* 成功 Success */
--red:          #D1242F;  /* 危险 Danger / 拒绝 Deny / 错误 Error */
--blue:         #3578A5;  /* 交互焦点 Focus Ring / 用户动作 */
--purple:       #7959A7;  /* 工具调用 Tool */
--indigo:       #6872A6;  /* 思考阶段 Thinking Stage */
--teal:         #287D78;  /* Agent Ops / Skill */
```

### 4.2 圆角与阴影规范

- 圆角（Radius）：
  - 小部件（按钮/输入框/标签）：`6px`
  - 面板/卡片/表格容器：`8px` 或 `9px`
  - 模态弹窗/命令行菜单：`10px` 或 `11px`
  - 胶囊/状态点：`999px`（Pill）
- 阴影（Shadow）：
  - 整体页面近乎**零阴影**（Flat）。
  - 仅浮层（Command Palette、Tooltip、Toast、Active NavItem）允许极轻微投影（`box-shadow: 0 1px 3px rgba(0,0,0,.04)` 或浮层的 `0 20px 60px rgba(0,0,0,.18)`）。

### 4.3 字体排印与舒适密度（Typography & Comfort Density）

排印锁定为 **Comfort** 舒适密度，保证管理操作的清晰可辨：

```css
/* 中文字体栈 */
font-family: "Noto Sans SC", "Source Han Sans SC", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif;

/* 西文与 UI 字体栈 */
font-family: "Geist Sans", Geist, system-ui, sans-serif;

/* 技艺/代码/数值字体栈 */
font-family: "Geist Mono", "SFMono-Regular", Consolas, monospace;
```

字号层级规范：
- 页面标题（Page Title）：`24–26px`（粗体，行高约 1.15，微调字距 `-0.03em`）
- 区域标题（Section Title）：`14–16px`
- 正文（Body）：`15–16px`
- 表格数据正文（Table Body）：`13–14px`
- 表头标签（Table Header）：`11–12px`（全大写微字距）
- 按钮与选项卡（Button / Tab）：`12–13px`
- 辅助元数据（Metadata）：`11–12px`
- 极小技术标识（Technical Micro）：**保底不得低于 10–11px**，严禁出现大面积 8–9px 的不可读细小文字。

### 4.4 数字与度量排印

所有涉及 Run ID、Token 数值、成本金额、时间戳、表格数值列的文本，强制开启等宽数字排印：

```css
font-variant-numeric: tabular-nums;
```

### 4.5 Token 与用量语义色彩规范

在概览、PI、Run 以及 Trace 页面中，各类 Token 类型的语义色必须全局统一：

```text
Input (输入)         → 蓝灰色 (Blue-gray, #7D97A5)
Output (输出)        → 绿色 (Green, #37A169)
Cache Read (缓存命中) → 琥珀色 (Amber, #D28A32)
Cache Write (缓存写入)→ 紫色 (Purple, #8E6AAE)
Reasoning (思考消耗) → 靛灰色 (Indigo-gray, #7E879E)
```

**Cache Hit 界面计算指标**：
```text
Cache Hit Rate = Cache Read / (Input + Cache Read)
```
UI 展现时必须明确标注为前端计算指标。

### 4.6 焦点与无障碍规范（Focus & Accessibility）

1. **焦点圈与选中色完全解耦**：
   - 键盘 Focus Ring 强制使用**高对比度蓝色**（`outline: 2px solid #3578A5; outline-offset: 2px;`）。
   - 严禁将代表品牌琥珀色（Amber）或告警色彩作为全局键盘焦点圈。
2. **表单语义化**：
   - 每一个 `input` 必须有对应的 `label`（通过 `for`/`id` 或原生包裹关联）。
   - 图标按钮必须具备 `aria-label` 或原生 `title`。
   - 所有 Switch 必须基于原生 `<input type="checkbox">` 实现无障碍访问。
3. **色盲安全保障（Color-blind Safety）**：
   - 数据图表绝不能单纯依靠颜色区分曲线。必须结合：
     ```text
     颜色区分 + 线型区分 (主线实线 solid / 次线虚线 dashed / 三线点线 dotted)
     + 图例标注 + Tooltip 悬浮详情 + 表格数值降级备用
     ```
   - 状态标记必须由“状态图标/小点 + 文本说明”组合构成，不得单独用红绿圆点表达一切。

### 4.7 响应式适配契约（Responsive Contract）

| 视口规格 | 典型设备 | 布局行为要求 |
| --- | --- | --- |
| **Desktop** (≥1250px) | 桌面端 (1440×900, 1920×1080) | 侧边栏固定 232px；DetailRail 左右并排；表格全量列展开；Trace 保持经典三栏布局。 |
| **Tablet** (768px–1249px) | 平板与小笔记本 (1024×768, iPad) | 侧边栏支持收起；DetailRail 移至下方垂直堆叠；表格采用局部横向滚动（Local Scroll）；双列折为单列。 |
| **Mobile** (≤767px) | 手机设备 (390×844, 320×700) | 侧边栏转为浮层抽屉（Drawer），顶栏包含汉堡菜单；触控目标保持约 `44px`；表单输入文字强制 `≥16px`（规避 iOS 聚焦自动缩放）；主从布局转为分步钻取；绝对禁止出现整页级横向滚动条。 |

### 4.8 实体图标（EntityMark）与吉祥物（Mascot）规范

- **识别实体使用专有 EntityMark**：PI、Herdr、Web、QQ、WeChat、Email、GitHub、Turso、R2、WebSocket、Owner、Visitor、Worker 均有各自固定底色与文字/图标徽标。
- **吉祥物使用约束**：Glassbox 吉祥物（Mascot）代表 Agent 自身人格与情绪状态，仅允许在以下明确场景出现：
  ```text
  Agent 自身身份展示
  运行中 (running)
  深度思考中 (thinking)
  成功完成 (success)
  遇到错误 (error)
  等待用户输入 (waiting)
  重要提示 (reminder)
  特定上下文空状态 (empty state)
  ```
  **严禁在每个卡片、每个表格行随意乱贴吉祥物头像。**

### 4.9 全局命令面板（Command Palette, `⌘K`）

支持使用快捷键 `⌘K`（Windows 下 `Ctrl+K`）快速呼出，实现全局极速搜索与页面跳转：
- 页面导航：概览、会话、任务协作、身份、运行记录、追踪、PI、渠道、权限、监控、设置。
- 业务实体跳转：
  - `task-xxx` → 快速定位并打开 Task 协作详情。
  - `run-xxx` → 打开对应 Run 详情。
  - `gemini-xxx` / `claude-xxx` → 跳转对应 PI Model 配置卡。
  - `visitor:xxx` → 跳转身份与访问中的对应 Principal。
  - `event-xxx` / `tool-xxx` → 定位 Trace 时间线对应事件。

---

## 5. 评估结论与验收规范 (Design Eval Checklist)

所有针对管理界面的实现与修改，在交付评审前必须对照 [`docs/design-inputs/DESIGN_EVAL.md`](design-inputs/DESIGN_EVAL.md) 逐项自测。

### 5.1 视口矩阵测试（Viewport Matrix）

必须测试以下五种典型分辨率，并验证各项行为：
1. `1440 × 900`（Desktop 标准桌面）
2. `1024 × 768`（Laptop 紧凑笔记本）
3. `768 × 1024`（Tablet 平板竖屏）
4. `390 × 844`（Mobile 主流手机）
5. `320 × 700`（Narrow Mobile 窄屏手机极限测试）

**通过标准**：
- 页面绝对无整体横向滚动条；
- 表格在小屏具备流畅的局部水平滚动与指示；
- 移动端侧边栏抽屉能够正常滑出并遮罩关闭；
- DetailRail 响应式降级正确；
- Trace 保持可用状态。

### 5.2 核心检查项清单

- [ ] **字体字号检查**：正文 ≥15px，表格正文 13–14px，元数据 ≥11px，移动端输入框 ≥16px。拒绝大面积 8–9px 微缩文本。
- [ ] **对比度与可读性**：文本色彩符合 Web 无障碍标准，禁止使用 `#999999` 作为重要元数据正文字色。
- [ ] **键盘可操作性**：Tab 键能顺序访问全部交互项；`j/k/e//` 键可顺畅操作 Trace 时间线；焦点框蓝圈鲜明。
- [ ] **长内容边界极限测试**：超长中文 Task 标题、长 UUID、长路径、长工具参数输出均有合理的截断（Truncation）或包裹（Wrapping），并提供 Hover / Detail 检查完整内容的能力，排版不崩坏。
- [ ] **零数据与空状态测试**：0 会话、0 任务、0 待审批、未上报配额、未统计定价等边界场景下，UI 展现优雅的空状态提示，严禁出现虚假的 `$0.00` 或破损表格。
- [ ] **状态词汇规范性**：全站严格遵循 `已实现`、`P3 目标`、`设计数据`、`后续`、`未知`，严禁出现 fixture、planned、target 等随意命名。
- [ ] **核心页面专项验收**：
  - Overview 能在 3 秒内解答“是否有事等待处理”与“当前运行状态”；
  - Task Collaboration 严格遵守 `Herdr done ≠ Task DONE`，必须经过授权 Accept 才能变 DONE；
  - Identity 完整呈现 `ChannelIdentity → User → Principal` 解析链条；
  - Trace 能够支撑 500+ 事件的大规模流畅滚动与瞬时筛选，Inspector 不串页。

### 5.3 25 项回归场景（Regression Scenarios）

1. 完整点击遍历全部 11 个页面。
2. 打开并关闭每个页面的 DetailRail。
3. 测试所有 FilterBar 的输入与过滤。
4. 测试所有搜索功能。
5. 在 PI 页面尝试切换默认模型。
6. 在 Settings 页面操作原生开关并测试状态记忆。
7. 在 Permissions 页面执行 Decision Tester 模拟。
8. 触发移动端侧边抽屉开关。
9. 测试 Trace 键盘导航（`j` / `k` 下翻、`e` 展开、`/` 聚焦）。
10. 测试 Trace Inspector 3 个 Tab 的切换与数据正确性。
11. 校验浏览器控制台 **0 Console Error**。
12. 校验 DOM 中无重复 ID（No Duplicate DOM IDs）。
13. 校验页面切换时 Inspector 状态不泄露、不残留。

---

## 6. Vercel 合规要求 (Vercel Compliance)

基于 `glossbox_vercel_admin_v24_vercel_compliance.html`（v24 原型），前端代码在工程结构与视觉风格上必须满足以下 Vercel 极简工程规范：

1. **绝对克制的极简主义**：
   - 彻底摒弃 Glassmorphism（磨砂玻璃拟态）、动态渐变光晕（AI Gradients / Glows）、炫目彩色卡片。
   - 采用纯白底色（`#FFFFFF`）配合最浅中性背景（`#FAFAFA`）和微弱分割线（`#EAEAEA`），突出数据信息本身。
2. **紧凑舒适的高密度信息排版**：
   - 优先采用精密表格（`DataTable`）和列表（`List`），避免大面积散落的低密度卡片。
   - 严格规范内外边距，以 `4px` / `8px` / `12px` / `16px` / `24px` 为基准节律。
3. **黑白灰主色与严苛的重点色限制**：
   - 页面主要交互行动点（Primary CTA）统一采用纯黑（`#111111`，hover 变微深或微透）。
   - 次要操作采用白底细边框（Secondary）。
   - 仅在明确表达产品含义（成功、错误、待办琥珀色、焦点蓝）时使用重点色，拒绝装饰性杂色。
4. **原生表单语义合规**：
   - 所有输入框、复选框、下拉框必须是原生 HTML 元素（或带有完整 ARIA 属性的 Headless 无样式基元）。
   - 表单交互必须支持纯键盘 Tab 遍历与原生表单提交。
5. **DOM 性能与规范**：
   - 表头保持 `sticky` 固定，表格采用 `scrollbar-width: thin`；
   - 避免无效嵌套 `div`；
   - 样式类名清晰正规，不得内联随意的非标 CSS 魔法数值。

---

## 7. 已确认项与待确认项

### 7.1 已确认项（Design Freeze v2 锁定契约）

以下内容已在 Design Freeze v2 中达成明确共识，**未经架构与产品评审不得重新设计或推翻**：

1. **Vercel-first 视觉语言与 Comfort 密度**：白底细线、无阴影单色基调、等宽数字排印。
2. **全局 11 页面架构与导航**：工作台（6 页面）、PI（4 页面）、系统设置（1 页面）。
3. **双重层级严格隔离**：执行层（PI → Model → Run → Trace）与任务层（Conversation → Task → TaskAttempt → WorkerBinding → Herdr）。
4. **Task 真值与 Herdr 外部状态铁律**：`Herdr done ≠ Task DONE`，Worker 完成仅进入 REVIEW，必须经授权 Accept 方可 DONE。
5. **决策优先（Decision-first）的权限体系**：先决策表与决策测试器，后统计图表；四道门禁强制显式展示。
6. **服务表优先（Service-table-first）的监控体系**：先基础设施服务健康表，后辅助时延曲线，区分产品真值与观测事实。
7. **Trace 三栏语义时间线与检查器**：Run 列表 + 14 种语义分类时间线 + 摘要/用量/原始三 Tab Inspector。
8. **Token 五色语义与 Cache Hit 计算指标**。
9. **五态能力词汇规范**：`已实现`、`P3 目标`、`设计数据`、`后续`、`未知`。
10. **实体徽标与吉祥物分离规则**。

### 7.2 允许的实现期微调范围（Allowed Refinements）

在具体的代码实现阶段（React / Tailwind / CSS Components），允许 Coding Agent 在不违背上述原则的前提下进行以下微调：

- `1–2px` 的局部间距与排版微调；
- 提示文案与空状态描述的细节润色；
- 表格列顺序在业务合理性基础上的微调；
- 替换为官方/本地的标准 SVG 实体矢量图标；
- 完善各类加载态（Skeleton）、网络异常提示与无障碍细节。

### 7.3 待确认项与架构边界澄清（Pending & Boundary Clarifications）

以下事项在当前阶段保持审慎边界，**不得在未获确认前擅自写成既成事实或篡改现有代码**：

1. **当前生产代码与 Active Plan 边界**：
   - 本仓库当前唯一生效的实施计划是 [`.plans/03-personal-agent-foundation.md`](../.plans/03-personal-agent-foundation.md)（Plan 03 — QQ Personal Agent Closed Loop）。
   - Plan 03 的核心交付目标是 QQ 个人代理闭环（包含 Pi SDK 深度集成、NapCat/OneBot 11 适配、Turso 存储持久化与 Herdr 任务委派验收）。
   - Web Management UI 在此阶段作为管理和审计视角契约先行沉淀；仓库 `apps/web/src/management/` 中现存的代码为历史迭代与早期原型，**绝不能在此次整理任务中私自重构或修改生产代码**。
2. **真实模型定价与成本数据源**：
   - 许多外部大模型 Provider API（如部分聚合网关或本地模型）原生并不返回每千 Token 美元成本。
   - 待确认：系统是通过统一内置定价字典在服务端根据 Token 计算，还是完全依赖 Provider 上报。在定价引擎接入前，前端统一显示为 `未知` 或 `成本不可用`，绝不能虚构伪造。
3. **大容量 Trace 虚拟化技术选型**：
   - 当单次 Run 的 Trace 事件数量达到 500+ 或 1000+ 时，DOM 渲染性能需要支持。
   - 待确认：前端技术实现时是采用窗口虚拟滚动（如 TanStack Virtual）还是采用分页懒加载方式，留待 Web 端正式实现切片时决策。
4. **移动端手势交互实现**：
   - 移动端抽屉（Drawer）是否支持滑动手势（Swipe to dismiss），属于前端实现层选型，优先以基础可点击遮罩（Overlay）完成高可靠兜底。

---

## 8. 代码实现指导语（Coding Agent Directive）

后续任何负责实现 Glassbox Web 管理后台的前端工程师或 Coding Agent，必须遵循以下指令：

> **实现指令**：
> 请以 [`docs/ui-design.md`](ui-design.md) 作为产品定义、页面结构与验收标准的唯一统一入口；以 `UI_PRIMITIVES.md` 作为组件组合约束；以 `glossbox_vercel_admin_v24_vercel_compliance.html`（v24）作为视觉和 Vercel 合规基准；并以 `DESIGN_EVAL.md` 完成逐项验收。不得自行重新设计，严禁打破 Glassbox 授权与任务不变式。
