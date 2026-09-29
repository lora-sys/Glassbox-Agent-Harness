# Trace 事件字典

Raw Trace 每行是一条 JSONL 记录，信封固定为：

```json
{ "seq": 1, "ts": "2026-09-29T00:15:23.718Z", "event": { "type": "..." }, "provenance": "pi" }
```

- `seq` 从 1 开始严格连续；断点 = trace 损坏或被改写，属于要排查的问题（`gbx show` 会报完整性警告）。
- `provenance` 标记写入方：`pi`（Pi 引擎）、`claude-code`、`glassbox-run`、`glassbox-tool-evidence`、`glassbox-context-budget`、`glassbox-web`、`glassbox-browser`。
- 事件字段有两派：**顶层字段**和 **`data` 里的同名字段**。用 `gbx events <runId> --type <类型>` 看原始 JSON 最可靠；下表字段来自本地真实 run 的采样。

## Run 生命周期

| 类型 | 关键字段 | 读法 |
| :--- | :--- | :--- |
| `run_queued` | `conversationId` | run 进入队列 |
| `run_started` | `conversationId` | 执行开始；和 `run_queued` 的时间差是排队延迟 |
| `run_finished` | `status`（`succeeded`/`failed`/`interrupted`/`unknown`）、`outputWithheld` | 终态。`failed` 不解释原因——原因在同 run 的 `delivery_blocked` / `runtime_health_observation` / `tool_result(isError)` 里 |

## Session / Turn（Pi 引擎写入，`provenance: pi`）

| 类型 | 关键字段 | 读法 |
| :--- | :--- | :--- |
| `session_start` | `sessionId`；`data.runtime.{profileName, piVersion, configuredKitCommit, skillsCommit, enabledSkills[]}`；`data.authorizedTools[]`；`data.toolSurface{}` | **调试技能/工具面的第一现场**：这个 run 实际启用了哪些 skill、授权了哪些工具 |
| `turn_start` | `sessionId` | 一轮问答开始 |
| `message_chunk` | `data.text` | 助手输出流；量大，`gbx show` 默认折叠 |
| `turn_end` | `data.{provider, model, toolResultCount, usage.{inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, totalTokens}}` | 一轮的用量与模型身份 |
| `session_end` | `sessionId` | 会话结束；一个 run 内可出现多个 session/turn |

## 工具

| 类型 | 关键字段 | 读法 |
| :--- | :--- | :--- |
| `tool_call` | `toolCallId`；`data.name` | 模型发起的工具调用 |
| `tool_result` | `data.{name, isError, failureCode, projection.{class, mode, beforeTokens, afterTokens, policyVersion}}` | `isError: true` 时看 `failureCode`（如 `input_validation_failed`、`protected_tool_failed`）；`projection` 记录上下文裁剪策略 |
| `tool_evidence` | `phase`（`required`=规划期 / `resolved`=执行后）；`required[]`/`resolutions[]` | Glassbox 侧的工具面证据：需要哪些工具、最终怎么解析 |

## 路由与运行时（P5 可观测性）

| 类型 | 关键字段 | 读法 |
| :--- | :--- | :--- |
| `routing_decision` | `policyVersion`（`p5b-route-v1`）、`executionRef`、`reason`、`taskRisk`、`usedFallback`、`demand.estimatedMaterialTokens`、`selectedProfileId` | 为什么选了这个 runtime/profile |
| `routing_eval_evidence` | `decisionExecutionRef` vs `actualExecutionRef`、`decisionModel` vs `actualModel`、`fallbackSelected`、`capabilityFloor`、`unavailableModelEncountered`、`quota.availability` | 决策与实际的偏差：fallback 是否发生、模型是否被替换 |
| `model_route_override` | `schema`（`glassbox.model-route-override.v1`）、`connectionId`、`profileId`、`model`、`providerId`、`appliesTo` | 某条 QQ 连接上的模型路由被显式改写（Owner 操作）。之后同一连接的 owner 私聊 run 会走这里的 `model`/`providerId`；`appliesTo` 说明生效范围 |
| `runtime_health_observation` | `executionRef`、`state`（`healthy`/`unavailable`）、`latencyMs`、`reasonCode`、`freshnessWindowMs` | **`state: unavailable` 是 run failed 的最常见伴生事件**，`reasonCode` 如 `execution_failed` |
| `runtime_usage` | `usage.{inputTokens, outputTokens, cacheReadTokens, reasoningTokens, totalTokens}.{value, source}`、`cost{}`、`throughput{}` | run 级用量汇总；`source` 为 `unknown` 时该值不可信 |

## 上下文与学习

| 类型 | 关键字段 | 读法 |
| :--- | :--- | :--- |
| `context_budget` | `policyVersion`（`p5a-context-v1`）、`demandTokens`、`contextWindowTokens`、`outputReserveTokens`、`projectedTokens`、`includedExchangeCount`、`omittedExchangeCount`、`sourceScanTruncated` | 上下文预算：注入了多少轮、省略了多少轮；`omittedExchangeCount > 0` 时"模型忘了 earlier 内容"有了第一解释 |
| `learning_context` | `scopeType`（`global`/`group`/`project`）、`status`（`empty`/`unavailable`）、`memoryIds[]` | 注入的学习上下文；`unavailable` 说明检索失败而非真的没有 |
| `learning_candidate_created` | `candidateId`、`scopeType` | 新学习候选（Taste/Memory 的入口） |
| `history_retrieval` | `query`、`groups[]`、`retrievalMode`、`considered`、`truncated`、`coverage.{returned, coverage, groupsSearched, sourceCoverage[]}` | 授权历史检索的范围与完整性；`coverage.coverage` 非 `complete` 时检索结果不完整 |

## 投递

| 类型 | 关键字段 | 读法 |
| :--- | :--- | :--- |
| `delivery_changed` | `deliveryId`、`status`（`sending`/`sent`/…） | 投递状态机；只有 `sent` 才代表用户真收到 |
| `delivery_blocked` | `reasons[]`（如 `empty-rendered-output`、`internal-uuid`）、`candidateSha256`、`candidateBytes` | 内容门禁拦截。**不存被拦正文**，只有 reason 和摘要；拦截时不会创建 Delivery |
| `delivery_denied` | `decision`（`DENY`）、`reason`（如 `no_grant`） | 授权门禁拒绝投递（ Audience 无权接收） |

## QQ 群角色与配置变更

| 类型 | 关键字段 | 读法 |
| :--- | :--- | :--- |
| `native_group_role_observed` | `groupId`、`senderId`、`observedRole`、`roleSource`、`resourceId` | OneBot 观察到的发送者角色（provider observation，不是 Glassbox 角色真相） |
| `native_group_role_verification` | `verifiedRole`、`verificationStatus`（`verified`/`mismatch`）、`requestedTool` | 受保护操作前的角色复核 |
| `provider_mutation_verification` | `requestedTool`、`requestedOperation`、`targetUserId`、`expectedRole` vs `observedRole`、`verificationStatus` | 提供商侧变更复核；`mismatch` = 以为成功了实际没成功 |
| `group_access_changed` / `group_history_changed` | `connectionId`、`groupId`、`enabled`、`policyVersion` | 群访问/历史开关变更 |
| `group_skill_changed` | `skillName`、`enabled`、`enabledSkills[]`、`configVersion` | 群技能面变更 |
| `group_capability_changed` | `category`、`enabled`、`policyVersion` | 群能力类目开关 |

## 媒体

| 类型 | 关键字段 | 读法 |
| :--- | :--- | :--- |
| `media_generation_completed` | `provider`（`agnes`）、`mediaType`（`image`/`video`）、`assetIds[]` | 媒体生成完成，asset 另有元数据 |

## 已知盲区（trace 不记录的东西）

排查前知道这些，能省掉一整轮无用搜索：

- **`tool_call` 只记工具名，不记入参**。模型到底传了什么错误参数无法从 trace 还原；要核对入参只能看同 run 的 `tool_evidence.required[].input`（Glassbox 侧声明）或复现。
- **`turn_end` 不记 `stopReason` / `errorMessage`**。会话为什么异常终止，trace 答不了，只能看 `run_finished.status` 和伴随事件。
- **`delivery_blocked` 不存被拦正文**，只有 `reasons`、`candidateSha256`、`candidateBytes`。想看被拦内容没有入口——这是设计（内容门禁不复制受保护载荷）。
- **`runtime_health_observation` 的 `reason=execution_failed` 常常是失败结果的衍生遥测，不等于执行器崩溃**。本地真实案例：模型 3 个 turn 全部正常完成、投递成功，但 run 因证据门禁判 failed，遥测随之记 execution_failed。看到它先找同 run 的 `tool_result(isError)` / `delivery_blocked` / 声明域未观测的证据，再下"执行器挂了"的结论。
- **Raw Trace 没有入站 QQ 消息正文的权威副本**；消息内容只在本地排查环境看，按 AGENTS.md 不外传。

## 一个健康 run 的形状

```text
native_group_role_observed（QQ 入站时）
run_queued → run_started
routing_decision → tool_evidence(required) → learning_context → context_budget
session_start → turn_start → (tool_call → tool_result)* → message_chunk*
turn_end → runtime_usage → session_end
tool_evidence(resolved) → runtime_health_observation → routing_eval_evidence
run_finished(succeeded) → delivery_changed(sending → sent)
```

顺序因场景增减（无工具时没有 tool_call；学习/检索为空时对应事件仍可能出现但内容为空）。**判断异常看三处**：`run_finished.status`、`runtime_health_observation.state`、`delivery_*` 的 reasons/decision。
