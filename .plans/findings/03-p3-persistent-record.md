# P3 持久化工作记录 (Persistent Work Record)

记录创建日期: 2026-09-17
所属阶段: Plan 03 (P3.0 - P3.8 专属单线开发)

---

## 1. 核心对象与关联

| 对象 | 标识 / URL | 备注 |
| --- | --- | --- |
| **专属 GitHub Issue** | https://github.com/lora-sys/Glassbox-Agent-Harness/issues/1 | 唯一 P3 跟踪 Issue，覆盖 P3.0 至 P3.8 验收清单 |
| **长期 Draft PR** | (待推送分支后填入) | 唯一长线 Draft PR，P3.0 至 P3.8 同线完成，不按阶段拆 PR |
| **开发分支** | `codex/p3-personal-agent-foundation` | 基于 local main HEAD 创建，禁止合入或直接推送 main |
| **专属 Worktree** | `C:\Users\yanBingZhao\repos\Glassbox-Agent-Harness-p3` | 所有 P3 开发仅在此隔离工作区进行 |
| **基线提交 (HEAD)** | `161c491` | 当前本地 main HEAD |

### 本地基线领先 `origin/main` 的提交 (3 commits)
- `161c491` Merge branch 'main' of https://github.com/lora-sys/Glassbox-Agent-Harness
- `da4ddb4` Merge branch 'main' of https://github.com/lora-sys/Glassbox-Agent-Harness
- `d6012f1` chore: save local changes before pull

### UI 与工作区排除范围
主工作区未提交文件严格排除，不修改、不携带、不合入本分支：
- `docs/README.md`
- `docs/design-inputs/`
- `docs/ui-design.md`
P3 期间不做前端视觉、P4、完整 Memory/Taste 或 LongTask DAG。

---

## 2. P3.9 在活动计划中的状态核实

在 `.plans/03-personal-agent-foundation.md` 第 783 行中，明确存在：
```text
### P3.9 — Real completion gate
Run the real dedicated environment and preserve evidence for the completion checklist below.
Mocks alone cannot complete P3.
```
- **实际存在性**: 文档确实定义了 P3.9，定位为“真实环境最终验收门禁”（需真实 QQ Bot/Owner/Visitor 账号、真实 NapCat、真实 Herdr 实例与真实模型额度）。
- **用户开发范围**: 明确为 **P3.0 至 P3.8**（在长期 Draft PR 中同线完成各切片实现与自动化验证，合成/Mock E2E 不标称整个 P3 最终完成）。

---

## 3. P3.0 实现成果与契约沉淀

### 核心契约 (`@glassbox/contracts`)
- 域模型：`Principal` (`kind`: `owner` \| `visitor` \| `agent` \| `system`)
- 操作环境：`ActionLocation` (`channel`, `chatType`, `scopeKey` 等)
- 投递受众：`Audience` (`kind`: `private` \| `group` \| `internal`, `allowedPrincipals`)
- 鉴权决策：`AuthorizationRequest`, `AuthorizationDecision` (`ALLOW` \| `DENY` \| `REQUIRES_APPROVAL`)
- 会话生命周期：`ConversationScope`, `Conversation`, `AgentRun`
- Ops 与任务状态机：
  - `AgentTask` (`NEW` → `QUEUED` → `ASSIGNED` → `RUNNING` → `WAITING_INPUT` → `REVIEW` → `ACCEPTED` / `DONE`, `FAILED`, `CANCELED`)
  - `TaskAttempt` (`attemptNumber`, `reworkReason`, `startedAt`, `completedAt`)
  - `WorkerBinding` (`herdrSession`, `workspaceId`, `paneId`, `agentKind`, `lastObservedAgentState`)
  - `AttentionItem` (`worker_blocked`, `task_review`, `approval_required` 等)
  - `AgentOpsSnapshot` (计算各维度统计)
- 安全金丝雀：`PRIVATE_CANARY = "PRIVATE_CANARY_7F92A1"`

### 持久化扩展 (`apps/server/src/persistence/schema.ts`)
新增关系型结构，保障重启与断开恢复：
- `tasks`
- `task_attempts`
- `worker_bindings`
- `attention_items`

### Ops 与 Herdr 适配层 (`apps/server/src/ops/`)
- `herdr-bridge.ts`: 声明标准 `HerdrBridge` 接口与事件流契约
- `fake-herdr-bridge.ts`: 提供零网络、内存隔离的确定性 `FakeHerdrBridge`，支持状态模拟与断连重连
- `task-store.ts`: 封装任务、Attempt、Binding、AttentionItem 的事务性持久化与快照计算
- `reconciler.ts`: `OpsReconciler` 实现事件监听与快照对齐，坚守关键不变量：
  - **Worker `done` 状态只能推进 Task 至 `REVIEW`，严禁自动转 `DONE`**
  - **Review `REWORK` 会创建第 N+1 次 Attempt，完整保留历史 Attempt 记录**
  - **Review `ACCEPT` 显式完成任务并归档 Attention**

### 投递网关 (`apps/server/src/delivery/gate.ts`)
- 践行“读取权限不等于投递权限”原则：私有资源即使 Owner 在群内请求，也禁止投递至群聊受众
- 强检验 `assertCanarySafety`，防止 `PRIVATE_CANARY_7F92A1` 泄露至未授权受众

### 确定性测试矩阵 (`apps/server/src/fixtures/` & `p3-closed-loop.test.ts`)
- `canonical-fixtures.ts`: 涵盖 OneBot 私聊、群 @、无 @、自消息环路、重发包，以及 Herdr Snapshot
- `p3-closed-loop.test.ts`:
  1. OneBot 报文解析与归一化分流
  2. 四道鉴权门禁与 Canary 防护（私聊放行、未授权拒绝、群聊拒绝、投递拒绝）
  3. 任务分派、Worker `blocked` 告警、`done` 进入 `REVIEW`、`REWORK` 保留历史、`ACCEPT` 完成闭环
  4. 数据库重启与会话持久化恢复

---

## 4. 真实验证命令与结果

所有验证在 `C:\Users\yanBingZhao\repos\Glassbox-Agent-Harness-p3` 真实执行：

1. **类型检查**:
   - `npx --no-install tsc --project packages/contracts/tsconfig.json --noEmit`: 退出代码 0 (0 errors)
   - `npx --no-install tsc --project apps/server/tsconfig.json --noEmit`: 退出代码 0 (0 errors)
2. **聚焦测试集**:
   - `npx vp test apps/server/src/ops/p3-closed-loop.test.ts apps/server/src/persistence/foundation.test.ts apps/server/src/channels/onebot/onebot.test.ts`
   - 结果：3 test files passed, 46 tests passed (0 failed).

---

## 5. 当前缺口与 P3.1 下一步

- **当前缺口**:
  - 当前测试为 P3.0 合成测试桩与契约层验证，未集成真实 Pi SDK 与真实 Lora PI Kit。
  - 尚缺少统一的 Ops Tools（`ops_status`, `task_create`, `task_delegate`, `task_accept` 等作为 Agent 工具注入）。
- **P3.1 下一步**:
  - 按照 `docs/lora-pi-kit.md` 规划，构建 `lora-sys/lora-pi-kit` 分发包 MVP。
  - 包含 Pi Package manifest、锁定 Skill 快照、运行时 profiles (`main-agent`, `qq-group`, `herdr-worker`, `test`) 与 doctor/sync-skills 工具。
