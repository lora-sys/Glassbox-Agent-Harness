# P3 持久化工作记录 (Persistent Work Record)

记录创建日期: 2026-09-17
所属阶段: Plan 03 (P3.0 - P3.8 专属单线开发)

---

## 1. 核心对象与关联

| 对象 | 标识 / URL | 备注 |
| --- | --- | --- |
| **专属 GitHub Issue** | https://github.com/lora-sys/Glassbox-Agent-Harness/issues/1 | 唯一 P3 跟踪 Issue，覆盖 P3.0 至 P3.8 验收清单 |
| **长期 Draft PR** | https://github.com/lora-sys/Glassbox-Agent-Harness/pull/4 | 唯一长线 Draft PR，P3.0 至 P3.8 同线完成，不按阶段拆 PR |
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

## 2. 切片范围与最终真实环境验收门禁核实

在 `.plans/03-personal-agent-foundation.md` 中：
- **开发切片范围**: 活动实现计划的开发切片为 **P3.0 至 P3.8**（在长期 Draft PR #4 中同线完成各功能切片实现与自动化验证）。
- **最终真实环境验收门禁的性质**: 最终真实环境验收门禁（Completion Gate 与验收清单，需要真实 QQ Bot、真实 NapCat、真实 Herdr 实例与真实模型环境），**并非代码开发切片**。在活动计划中切片编号仅到 P3.8，在自动化测试或 Mock 环境下不发明或标称“完成 P3.9 切片”；统称为“最终真实环境验收门禁”。

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

---

## 6. P3 共享群聊会话与每 Run 身份切片实现 (Shared Group & Actor Routing Slice)

记录日期: 2026-09-17
切片目标: 完成共享 QQ 群聊会话模型、每 Run Actor 身份及持久化路由，确保跨 Actor 隔离与安全回归。

### 6.1 核心设计与实现成果

1. **会话范围与位置映射解耦 (`conversationScopeKey`)**:
   - `identity/scope.ts`: 引入 `conversationScopeKey(scope)`（5 元组 `[connectionId, botId, chatType, chatId, threadId]`），排除 `senderId` 作为会话位置标识；保持 `scopeKey(scope)`（6 元组包含 `senderId`）作为鉴权与授权范围。
   - 实现了同一 QQ 群内 Owner 与 Visitor 共享唯一的 `Conversation`，但彼此拥有完全独立的 Run、Caller 身份与投递路由。

2. **证据保全的 Schema V3/V4 安全幂等与迁移 (`persistence/schema.ts` & `persistence/database.ts`)**:
   - **零删除、零改写、严禁伪造证据**: 绝对不删除历史 `conversations` 或 `resources`，不改写历史 `messages`、`runs`、`tasks`、`authorization_decisions` 外键。
   - **安全 Grant 幂等与非唯一索引**: 坚决不在 `schemaV3Migration` 中将重复 Grant 伪造为 `revoked_at = created_at`（该做法伪造历史时序并会破坏绑定至重复 Grant 的有效审批）。改用非唯一索引 `grant_lookup_active`（`grants(principal_id, resource_id, action, scope_key, effect) WHERE revoked_at IS NULL`），配合 `store.authorization.grant()` 事务内串行化 select-before-insert 实现幂等。
   - **V4 迁移清理与会话所有者跟踪**: `applySchemaV4Migration` 执行 `DROP INDEX IF EXISTS one_active_grant` 清理旧唯一索引，并确保 `grant_lookup_active` 索引建立；`conversations` 表增量添加 `provider_session_principal_id` 并从 `principal_id` 回填，杜绝跨 Principal 复用 Provider Session。
   - **新增 `conversation_locations` 表**: `(agent_id, location_key, conversation_id, created_at, PRIMARY KEY (agent_id, location_key))` 作为向前规范位置索引，历史多 sender 分裂会话完整保留在库中。
   - **历史数据回填**: `runs` 表增量添加 `principal_id` 与 `scope_json` 字段并自历史会话回填。

3. **跨 Actor 控制、历史隔离与运行时安全 (`auth/service.ts` & `conversation/store.ts`)**:
   - `auth/service.ts`:
     - `evaluate()` 审批消费逻辑适配重复 Grant：通过 `approvals a JOIN grants g ON g.id = a.grant_id` 动态校验被引用的特定 Grant 是否未被撤销 (`g.revoked_at IS NULL`)，消除因 `LIMIT 1` 选取其他同类 Grant ID 导致的有效审批误拒 (`approval_invalid`)。
     - Admission recheck 中同样 join `grants g` 检验 `g.revoked_at IS NULL`，确保被审批关联的 Grant 若在准入后被撤销，重检能够正确拦截。
     - `grant()` 实现串行化查重，重复调用安全幂等返回已有 Grant ID。
   - `conversation/store.ts`:
     - `authorizeRun`: 严格校验 `caller.principalId === run.principalId`，杜绝跨 Actor 越权与冒领。
     - `listRuns`: 自动过滤当前 `caller.principalId`，群内成员仅可检索自身创建的 Run。
     - `loadRunInput`:
       - **历史隔离**: 严禁将共享会话所有成功 Run 盲目载入上下文。其他 Principal 的历史回合必须有 `deliveries` 表中持久化证据（`status = 'sent'`，`payload_kind IN ('text', 'result')` 且投递目标匹配当前群聊会话位置），否则一律从上下文中剔除。未尝试投递、投递被拒或包含私密金丝雀的未公开结果绝对无法被其他 Actor 观察。
       - **Provider Session 隔离**: 仅当 `conversation.providerSessionPrincipalId === caller.principalId` 时才允许复用 `providerSessionId`，Visitor 绝不继承 Owner 的 Provider 运行上下文。
     - `acceptIncoming`: 消息重发去重校验 `caller.principalId === prior.principal_id`，防止重发冒领；通过 `conversation_locations` 获取规范会话；私聊场景继续强制校验归属，防止绑定漂移跨 Principal 泄露。
     - `listRunRoutes`: 启动恢复时直接读取 `runs.principal_id` 与 `runs.scope_json`，确保服务重启后能精准恢复每个 Run 的真实执行者与发送者范围，而非会话创建者。

### 6.2 确定性测试矩阵覆盖 (`apps/server/src/conversation/shared-group.test.ts`)

全量覆盖验收准则 1 至 9：
1. **共享群会话与独立 Actor 路由**: Owner + Visitor 在同一群中 `conversation.id` 相同，`run.id` 不同，`run.principalId` 独立，投递目标 `destinationScopeKey` 独立区分。
2. **多维隔离**: 私聊与群聊、不同群聊之间会话 ID 完全隔离，私聊数据与他人 Run 跨范围访问一律抛出 `AccessDeniedError`。
3. **未绑定与伪造身份拒绝**: 未绑定身份触发 `identity_unbound` 拒绝；伪造 Principal 或绑定被篡改触发 `scope_mismatch` / `identity_mismatch` 拒绝。
4. **跨 Actor 运行控制与结果隔离**: 同群 Visitor 无法 cancel/transition Owner 的 Run、无法 claim 其 delivery、无法通过 `getRun`/`loadRunInput`/`advanceTrace` 窃取或篡改数据。
5. **事件幂等重放**: 同一消息重发返回 `duplicate: true` 且保持 Run ID 一致，不重复生成消息与运行记录。
6. **重启持久化恢复**: 数据库关闭并重新加载后，`listRunRoutes` 精准还原各自 Run 的 `principalId` 与 `senderId`。
7. **独立 Revoke 与 Approval**: 同一群聊中 Owner 的 `allow` 与 Visitor 的 `approval`/`revoke` 独立生效，互不干扰。
8. **V1-V3 至 V4 迁移与证据保全**: 验证历史重复 Grant 完整保留且 `revoked_at IS NULL`，绑定在重复 Grant 上的审批在新架构下正常鉴权并消费，幂等 `grant()` 返回已有 ID 且不产生冗余记录，分裂会话完整保留，`runs` 回填完整且 `PRAGMA foreign_key_check` 0 违规。
9. **历史与 Provider Session 运行时隔离 (Canary & Delivery 安全)**: 验证 Owner 成功但未投递/投递挂起中的 Canary 结果绝不进入 Visitor 的 Run history 或 Provider session；验证投递完成的公开结果正常进入共享历史；验证撤销权限后拒绝载入 Run 输入。
10. **跨 Actor 历史 Payload 过滤与元数据优先加载 (Defect 1 修复)**:
    - `loadRunInput` 遵循先鉴权再取载荷的原则，首查仅获取 `runs.id, runs.principal_id, runs.sequence, runs.message_id` 元数据，严禁无差别全量 SELECT `runs.result_text` 与 `messages.text`。
    - **Fail-closed 历史鉴权与来源追溯 (Provenance Check)**: 对所有历史 Run（无论同 Principal 或跨 Principal）统一执行授权决策检验 `SELECT d.grant_id, g.revoked_at FROM authorization_decisions d JOIN grants g ON g.id = d.grant_id WHERE d.run_id = ? AND d.decision = 'ALLOW'`：
      - 若历史 Run 无有效授权记录 (`grantRows.rows.length === 0`)，坚决 Fail-closed 剔除，杜绝无证历史注入模型上下文。
      - 若历史 Run 关联的任一 Grant 已被撤销 (`revoked_at IS NOT NULL`)，坚决剔除。即使历史结果已投递至群聊，被撤销授权的 Run 载荷亦绝不再进入后续任何成员（包括同群 Visitor）的上下文。
    - 跨 Actor (`prior.principal_id !== caller.principalId`) 仅允许载入群聊目标匹配且已确认投递 (`status = 'sent'`) 的实际投递载荷 (`delivery.payload_text`)；Owner 内部 Raw result_text 绝不直接外泄至 Visitor 历史上下文。
11. **Pi 运行时会话生命周期隔离与 SessionManager.inMemory (Defect 2 修复)**:
    - 严格落实 `AGENTS.md`“Conversation ≠ Session”铁律：Conversation 为产品持久化会话，Session 为单次运行时上下文。
    - 移除 `PiSdkRuntimeAdapter` 中按 `conversation.id` 缓存/复用 Session 的逻辑，每次 Run 均创建独立隔离的运行时环境，使用 `SessionManager.inMemory(cwd)` 运行，防止磁盘残留跨 Actor 恢复。
    - 运行时适配器新增 `disposeSession(runtimeSessionId)` 接口，`PiRunExecutionAdapter.execute` 在 `finally` 块中立即释放 Session。
    - Prompt 组装完全由 Glassbox 自主负责，根据当前授权历史过滤重构传入 `recreatedPrompt(input)`，确保各 Actor 及权限变更后的提示词绝对纯净。
12. **跨平台测试稳健性 (Windows 临时目录句柄释放)**:
    - `shared-group.test.ts` 中的 `afterEach` 清理增加安全容错，防止 LibSQL 在并发执行下的 Windows 文件锁导致钩子超时。

### 6.3 验证结果

- **类型检查**:
  - `node node_modules/typescript/bin/tsc --project packages/contracts/tsconfig.json --noEmit`: 代码 0 (0 错误)
  - `node node_modules/typescript/bin/tsc --project apps/server/tsconfig.json --noEmit`: 代码 0 (0 错误)
- **聚焦测试集 (72 测试通过)**:
  - `apps/server/src/conversation/shared-group.test.ts`: 13 passed (新增无证历史 fail-closed 排除与跨 Actor 撤销授权历史剔除 2 组安全回归测试)
  - `apps/server/src/runtime/pi/adapter.test.ts`: 3 passed (包含跨 Actor 会话隔离与 Run 完成即时销毁/提示词纯净度 2 组运行时安全测试)
  - `apps/server/src/persistence/foundation.test.ts`: 11 passed
  - `apps/server/src/channels/onebot/onebot.test.ts`: 32 passed
  - `apps/server/src/ops/p3-closed-loop.test.ts`: 4 passed
  - `apps/server/src/ops/reconciler.test.ts`: 5 passed
  - `apps/server/src/execution/run-service/run-service.test.ts`: 4 passed
- **全量 Server 测试集**: 44 test files passed, 746 passed (0 failed).

### 6.4 P3 整体状态声明 (Incomplete Overall Status)

- **当前状态**: 本切片完成 P3 下的**“共享群聊会话模型、每 Run 身份隔离、持久化路由与历史/运行时安全隔离”**切片。
- **总体 P3 仍未最终完成**:
  - P3 活动开发切片定义为 P3.0 至 P3.8。
  - 真实 Pi SDK 与真实 Lora PI Kit 分发包集成尚待推进（P3.1 - P3.4）。
  - 真实 NapCat QQ Bot 双向通信与真实 Herdr 运行时协同待集成与闭环。
  - 最终真实环境验收门禁尚未执行（包含非 Mock 的真实账号与生产环境验收）。
