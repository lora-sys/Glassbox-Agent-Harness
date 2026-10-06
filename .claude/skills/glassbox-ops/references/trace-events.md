# Trace 事件字典

Raw Trace 每行是一条 JSONL 记录，信封固定为：

```json
{ "seq": 1, "ts": "2026-09-29T00:15:23.718Z", "event": { "type": "..." }, "provenance": "pi" }
```

- `seq` 从 1 开始严格连续；断点 = trace 损坏或被改写，属于要排查的问题（`gbx show` 会报完整性警告）。
- `provenance` 标记写入方，不代表授权结论。当前应用的写入方见下表。
- 事件字段有两派：**顶层字段**和 **`data` 里的同名字段**。用 `gbx events <runId> --type <类型>` 看原始 JSON 最可靠。下表结合已有 run 采样和当前提交的写入代码核对，不保证旧部署已产生每种事件。

## Provenance 写入方

当前应用接线见 [`management/application.ts`](../../../../apps/server/src/management/application.ts)。

| 写入方 | 证据来源 |
| :----- | :------- |
| `pi` / `claude-code` | 对应 runtime 的会话、回合与工具事件 |
| `glassbox-run` | Run 生命周期、投递、Task 通知和路由评估 |
| `glassbox-recovery` | 启动恢复写入的 `run_finished` / `delivery_changed`，带 `recovered: true` |
| `glassbox-tool-evidence` | Pi 执行所需/已解析的工具证据、`web_answer_evidence`；Pi 容量未知也从此处写入 |
| `glassbox-context-budget` | Pi 上下文预算 |
| `glassbox-learning-context` | Pi 学习上下文加载 |
| `glassbox-web` / `glassbox-browser` | Web 检索、网页读取及浏览器操作 |
| `glassbox-sandbox-tool` | 隔离 Pi 工具调用、结果和失败 |
| `glassbox-media` | 媒体生成 |
| `glassbox-model` | 配置模型适配器的模型身份、容量、预算、输出及用量事件 |
| `glassbox-model-selection` | 显式模型路由选择 |
| `glassbox-retrieval` | 授权历史检索 |
| `glassbox-routing` | 路由选择和升级证据 |
| `glassbox-runtime-telemetry` | 运行时健康和用量 |
| `glassbox-owner-control` | Owner 配置和群能力变更 |
| `glassbox-provider-postcondition` | 提供商变更后置条件复核 |
| `glassbox-moderation-resolution` | 群管理目标解析 |
| `glassbox-qq-role` | QQ 群原生角色观察与复核 |

## Run 生命周期

| 类型               | 关键字段                                                                                                                                       | 读法                                                                                                                                                              |
| :----------------- | :--------------------------------------------------------------------------------------------------------------------------------------------- | :---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `message_received` | `messageId`、`externalId`、`conversationId`、`connectionId`、`botId`、`chatType`、`chatId`、`senderId`、`threadId?`、`textBytes`、`textSha256` | **入站第一现场**：这条 run 由哪条消息触发。正文按设计不在这里，只有字节数和摘要——用 `gbxtrace msg <runId>` 看元数据并拿到查库路径。它的 seq 是整条 trace 的最小值 |
| `run_queued`       | `conversationId`                                                                                                                               | run 进入队列                                                                                                                                                      |
| `run_started`      | `conversationId`                                                                                                                               | 执行开始；和 `run_queued` 的时间差是排队延迟                                                                                                                      |
| `run_cancelling` | `runId`、`conversationId` | 已记录取消请求，执行可能尚未停止；终态仍看后续 `run_finished` |
| `run_finished`     | `status`（`succeeded`/`failed`/`interrupted`/`unknown`）、`outputWithheld`、`failureCode`                                                      | 终态。`failureCode` 是失败类别的机器可读值（不是人话原因），具体证据在同 run 的 `delivery_blocked` / `runtime_health_observation` / `tool_result(isError)` 里     |

## Session / Turn（Pi 引擎写入，`provenance: pi`）

| 类型            | 关键字段                                                                                                                                                 | 读法                                                                                                                                                                                         |
| :-------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `session_start` | `sessionId`；`data.runtime.{profileName, piVersion, configuredKitCommit, skillsCommit, enabledSkills[]}`；`data.authorizedTools[]`；`data.toolSurface{}` | **调试技能/工具面的第一现场**：这个 run 实际启用了哪些 skill、授权了哪些工具                                                                                                                 |
| `turn_start`    | `sessionId`                                                                                                                                              | 一轮问答开始                                                                                                                                                                                 |
| `message_chunk` | `data.text`                                                                                                                                              | 助手输出流；量大，`gbx show` 默认折叠                                                                                                                                                        |
| `turn_end`      | `data.{provider, model, stopReason, toolResultCount, usage.{inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, totalTokens}}`                 | 一轮的用量与模型身份。`stopReason`：`stop`=正常收尾，`length`=撞上输出上限，`toolUse`=还有工具要跑，`error`/`aborted`=被打断——**看到 `aborted`/`error` 就去查 provider，不要先去查业务逻辑** |
| `session_end`   | `sessionId`                                                                                                                                              | 会话结束；一个 run 内可出现多个 session/turn                                                                                                                                                 |

## 工具

| 类型            | 关键字段                                                                                                                                                          | 读法                                                                                                                                                                                                                                              |
| :-------------- | :---------------------------------------------------------------------------------------------------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `tool_call`     | `toolCallId`；`data.name`；`data.input?`                                                                                                                          | 模型发起的工具调用。普通工具的原始入参会落 `data.input`（长字符串截到 64 字符）；`query`/`text`/`content`/`history` 这类正文键**一律不落**，`group_history_search` / `owner_history_search` 整个 `input` 都不落——这是受保护工具，调用本身够定位了 |
| `tool_result`   | `data.{name, isError, failureCode, outputBytes, outputSha256, outputHead?, outputTruncated?, projection.{class, mode, beforeTokens, afterTokens, policyVersion}}` | `isError: true` 时看 `failureCode`。`outputHead` 是返回体前 512 字节（够看 "Schema validation failed" 这类线索），超出部分只有 `outputBytes`/`outputSha256`；受保护工具连 `outputHead` 都不落。`projection` 记录上下文裁剪策略                    |
| `tool_evidence` | `phase`（`required`=规划期 / `resolved`=执行后）；`required[]`/`resolutions[]`                                                                                    | Glassbox 侧的工具面证据：需要哪些工具、最终怎么解析                                                                                                                                                                                               |

### 隔离 Pi 工具

这些字段位于事件顶层。应用还附加 `sandboxProvider`、`sandboxImage` 和 `policyVersion`。

| 类型 | 关键字段 | 读法 |
| :--- | :------- | :--- |
| `isolated_pi_tool_call` | `runId`、`principalId`、`toolCallId`、`toolName`、`workspaceId`、`action`、`decisionId`、`grantId` | 当前工作区授权检查通过后、执行前记录；调用证据不等于执行成功 |
| `isolated_pi_tool_result` | `runId`、`toolCallId`、`toolName`、`workspaceId`、`outcome`、`contentTypes[]`、`detailsPresent` | `outcome` 为 `success` 或 `process_failed`；此事件记录结果类型，不复制结果正文 |
| `isolated_pi_tool_failure` | `runId`、`toolCallId`、`toolName`、`workspaceId`、`outcome`、`sideEffectPossible` | 异常路径，`outcome` 为 `unknown` 或 `process_failed`；`unknown` 不能当作无副作用、可直接重试的证明 |

## 检索 / Web

| 类型          | 关键字段                                                                                                                                                                             | 读法                                                                                                                         |
| :------------ | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :--------------------------------------------------------------------------------------------------------------------------- |
| `web_search`  | `status`（如 `unavailable`）、`providerStatus`（如 `failed`）、`sourceIds[]`、`urls[]`、`partial`、`truncated`、`providerOrigins[]`、`retrievedAt`、`searchMode`（如 `browser_fallback`）、`queryVariantCount`、`queryDigest` | 一次 web 检索的结果或失败。查询正文不落盘，只有 `queryDigest`（完整 SHA-256）；失败时不带 provider 错误文本，定位看 `providerStatus` + 服务日志 |
| `web_fetch` | `runId`、`conversationId`、`principalId`、`status`、`providerStatus`、`sourceIds[]`、`urls[]`、`partial`、`truncated`、`providerOrigins[]`、`retrievedAt`、`retrievalMethod`、`contentType?` | 一次网页读取的元数据；不复制网页正文。`partial` 或 `truncated` 表示证据不完整 |
| `web_answer_evidence` | `runId`、`conversationId`、`principalId`、`status`（`accepted`/`withheld`）、`reason?` | 官方来源核验请求的回答证据门禁。`source_not_read` 表示未读取来源，`unqualified_latest_claim` 表示最新性断言缺限定；`accepted` 是此门禁通过，不代表最终投递成功 |

## 路由与运行时（P5 可观测性）

| 类型                         | 关键字段                                                                                                                                                                     | 读法                                                                                                                                      |
| :--------------------------- | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :---------------------------------------------------------------------------------------------------------------------------------------- |
| `routing_decision`           | `policyVersion`（`p5b-route-v1`）、`executionRef`、`reason`、`taskRisk`、`usedFallback`、`demand.estimatedMaterialTokens`、`selectedProfileId`                               | 为什么选了这个 runtime/profile                                                                                                            |
| `routing_eval_evidence`      | `decisionExecutionRef` vs `actualExecutionRef`、`decisionModel` vs `actualModel`、`fallbackSelected`、`capabilityFloor`、`unavailableModelEncountered`、`quota.availability` | 决策与实际的偏差：fallback 是否发生、模型是否被替换                                                                                       |
| `model_route_override`       | `schema`（`glassbox.model-route-override.v1`）、`connectionId`、`profileId`、`model`、`providerId`、`appliesTo`                                                              | 某条 QQ 连接上的模型路由被显式改写（Owner 操作）。之后同一连接的 owner 私聊 run 会走这里的 `model`/`providerId`；`appliesTo` 说明生效范围 |
| `model_capacity` | `state`（`unknown`）、`reasonCode`（`capacity_unknown`）；Pi 路径另有 `runId`、`principalId`、`conversationId` | 无法取得有效模型容量，执行在调用 provider 前失败，`failureCode` 为 `model_capacity_unknown`。写入方可能为 `glassbox-tool-evidence` 或 `glassbox-model` |
| `runtime_health_observation` | `executionRef`、`state`（`healthy`/`unavailable`）、`latencyMs`、`reasonCode`、`freshnessWindowMs`                                                                           | **`state: unavailable` 是 run failed 的最常见伴生事件**，`reasonCode` 如 `execution_failed`                                               |
| `runtime_usage`              | `usage.{inputTokens, outputTokens, cacheReadTokens, reasoningTokens, totalTokens}.{value, source}`、`cost{}`、`throughput{}`                                                 | run 级用量汇总；`source` 为 `unknown` 时该值不可信                                                                                        |

## 上下文与学习

| 类型                         | 关键字段                                                                                                                                                                                     | 读法                                                                                                     |
| :--------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------------- |
| `context_budget`             | `policyVersion`（`p5a-context-v1`）、`demandTokens`、`contextWindowTokens`、`outputReserveTokens`、`projectedTokens`、`includedExchangeCount`、`omittedExchangeCount`、`sourceScanTruncated` | 上下文预算：注入了多少轮、省略了多少轮；`omittedExchangeCount > 0` 时"模型忘了 earlier 内容"有了第一解释 |
| `learning_context`           | `scopeType`（`global`/`group`/`project`）、`status`（`empty`/`unavailable`）、`memoryIds[]`                                                                                                  | 注入的学习上下文；`unavailable` 说明检索失败而非真的没有                                                 |
| `learning_candidate_created` | `candidateId`、`scopeType`                                                                                                                                                                   | 新学习候选（Taste/Memory 的入口）                                                                        |
| `history_retrieval`          | `query`、`groups[]`、`retrievalMode`、`considered`、`truncated`、`coverage.{returned, coverage, groupsSearched, sourceCoverage[]}`                                                           | 授权历史检索的范围与完整性；`coverage.coverage` 非 `complete` 时检索结果不完整                           |

## 投递

| 类型               | 关键字段                                                                                        | 读法                                                                                                                 |
| :----------------- | :---------------------------------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------- |
| `delivery_changed` | `deliveryId`、`status`（`sending`/`sent`/`failed`/`unknown`/…）、`externalId?`                  | 投递状态机；`sent` 表示平台确认发送成功，不证明用户已读。`externalId` 是平台侧回执的消息 id，凭它可以回 QQ 侧核对"到底发出去了没有" |
| `delivery_blocked` | `reasons[]`（如 `empty-rendered-output`、`internal-uuid`）、`candidateSha256`、`candidateBytes` | 内容门禁拦截。**不存被拦正文**，只有 reason 和摘要；拦截时不会创建 Delivery                                          |
| `delivery_denied`  | `decision`（`DENY`）、`reason`（如 `no_grant`）                                                 | 授权门禁拒绝投递（ Audience 无权接收）                                                                               |
| `task_notification_changed` | `runId`、`taskId`、`notificationId`、`status`（`sending`/`sent`/`failed`/`unknown`）、`reason?` | Task 通知 outbox 的发送变化，关联原始 Run；与直接回复的 `delivery_changed` 分开。终态失败或未知时保留固定原因码，不记录通知正文或平台错误正文；未知结果不自动重发 |

## QQ 群角色与配置变更

| 类型                                             | 关键字段                                                                                                      | 读法                                                                      |
| :----------------------------------------------- | :------------------------------------------------------------------------------------------------------------ | :------------------------------------------------------------------------ |
| `native_group_role_observed`                     | `groupId`、`senderId`、`observedRole`、`roleSource`、`resourceId`                                             | OneBot 观察到的发送者角色（provider observation，不是 Glassbox 角色真相） |
| `native_group_role_verification`                 | `verifiedRole`、`verificationStatus`（`verified`/`mismatch`）、`requestedTool`                                | 受保护操作前的角色复核                                                    |
| `provider_mutation_verification`                 | `requestedTool`、`requestedOperation`、`targetUserId`、`expectedRole` vs `observedRole`、`verificationStatus` | 提供商侧变更复核；`mismatch` = 以为成功了实际没成功                       |
| `group_access_changed` / `group_history_changed` | `connectionId`、`groupId`、`enabled`、`policyVersion`                                                         | 群访问/历史开关变更                                                       |
| `group_skill_changed`                            | `skillName`、`enabled`、`enabledSkills[]`、`configVersion`                                                    | 群技能面变更                                                              |
| `group_capability_changed`                       | `category`、`enabled`、`policyVersion`                                                                        | 群能力类目开关                                                            |
| `group_web_capability_changed` | `connectionId`、`groupId`、`capability`、`enabled`、`policyVersion` | 群 Web 能力开关；字段是 `capability`，不是通用群能力事件的 `category` |
| `group_memory_source_changed` | `connectionId`、`groupId`、`sourceClass`、`enabled`、`policyVersion` | 群记忆来源类别开关；与群历史总开关分开记录 |

## 媒体

| 类型                         | 关键字段                                                            | 读法                           |
| :--------------------------- | :------------------------------------------------------------------ | :----------------------------- |
| `media_generation_completed` | `provider`（`agnes`）、`mediaType`（`image`/`video`）、`assetIds[]` | 媒体生成完成，asset 另有元数据 |

## 已知盲区（trace 不记录的东西）

排查前知道这些，能省掉一整轮无用搜索。**打勾的是本次已经补上的**，剩下的是真的没有入口。

- ✅ **入站消息**：`message_received` 记了触发这条 run 的消息元数据和 `textSha256`。正文仍然只在 SQLite——那是 AGENTS.md 的决定，不是漏记。要正文：`gbxtrace msg <runId>` 拿元数据，再走带授权的管理接口查，用 sha256 对上了才算同一条。
- ✅ **`tool_call` 入参**：普通工具记 `data.input`（长串截 64 字符），`query`/`text`/`content`/`history` 等正文键不记；`group_history_search` / `owner_history_search` 整个入参不记。
- ✅ **`tool_result` 出参**：记 `outputHead`（前 512 字节）+ `outputBytes` + `outputSha256`；受保护工具只有后两个。
- ✅ **`turn_end` 停止原因**：`stopReason` 在 `data` 里。`errorMessage` 仍然不记——provider 的错误文案可能夹带请求内容，那条线不让过。
- ✅ **`run_finished` 失败类别**：`failureCode`。
- ✅ **投递平台回执**：`delivery_changed.externalId`。
- **入站被丢弃的消息没有 run，因此没有 trace**。群"没反应"但没有任何 run 时，查 `gbxtrace ingress`：入站证据落在 `<dataDir>/ingress-diagnostics.jsonl`（每条只有 `{ts, channelId, groupId, reason}`，无正文），**重启不丢**。reason 有 `not_addressed`（没被点名）、`empty_message`（空消息）、`not_ready`（连接没就绪，消息被丢——和"没点名"是两种完全不同的故障）、`invalid_message`、`unsupported_message`、`ingress_overflow`、`acceptance_failed`。这份日志是后加的，服务没在改动后重启时它不存在——那本身就是线索。
- **`delivery_blocked` 不存被拦正文**，只有 `reasons`、`candidateSha256`、`candidateBytes`。想看被拦内容没有入口——这是设计（内容门禁不复制受保护载荷）。
- **`runtime_health_observation` 的 `reason=execution_failed` 常常是失败结果的衍生遥测，不等于执行器崩溃**。本地真实案例：模型 3 个 turn 全部正常完成、投递成功，但 run 因证据门禁判 failed，遥测随之记 execution_failed。看到它先找同 run 的 `tool_result(isError)` / `delivery_blocked` / 声明域未观测的证据，再下"执行器挂了"的结论。
- **Raw Trace 没有入站 QQ 消息正文的权威副本**；消息内容只在本地排查环境看，按 AGENTS.md 不外传。
- **时间空洞**：两段相邻事件之间的等待没有任何事件解释它（典型如 `run_started → routing_decision` 之间几十秒）。`gbxtrace replay` 会把 >= 5s（`--gap-ms` 可调）的空洞按大小列出来——空洞不是错误，但它把"慢在哪一段"指了出来。

## 一个健康 run 的形状

```text
message_received（入站，seq 最小；部署本次改动之前的 run 没有它）
native_group_role_observed（QQ 入站时）
run_queued → run_started
routing_decision → tool_evidence(required) → learning_context → context_budget
session_start → turn_start → (tool_call → tool_result)* → message_chunk*
turn_end → runtime_usage → session_end
tool_evidence(resolved) → runtime_health_observation → routing_eval_evidence
run_finished(succeeded, failureCode 缺省) → delivery_changed(sending → sent, externalId)
```

顺序因场景增减（无工具时没有 tool_call；学习/检索为空时对应事件仍可能出现但内容为空）。**判断异常看三处**：`run_finished.status`、`runtime_health_observation.state`、`delivery_*` 的 reasons/decision。

**先跑 `gbxtrace replay <runId>`**：它按"入站 → 路由 → 会话与 runtime → 模型回合 → 产出 → 投递"六段逐段报有没有证据，并把最大的时间空洞列出来。哪一段是空的，排查就从那一段开始，不用通读整条 trace。


## 本次补充的代码核对入口

- Web 读取字段：[`runtime/pi/web-tools.ts`](../../../../apps/server/src/runtime/pi/web-tools.ts)
- Web 回答门禁和 Pi 容量未知：[`runtime/pi/run-adapter.ts`](../../../../apps/server/src/runtime/pi/run-adapter.ts)
- 隔离工具调用、结果与失败：[`runtime/pi/sandbox-pi-tools.ts`](../../../../apps/server/src/runtime/pi/sandbox-pi-tools.ts)
- 模型适配器容量未知：[`execution/model-adapter.ts`](../../../../apps/server/src/execution/model-adapter.ts)
- Run 取消和 Task 通知：[`execution/run-service/index.ts`](../../../../apps/server/src/execution/run-service/index.ts)
- 群配置事件、恢复事件和 provenance 接线：[`management/application.ts`](../../../../apps/server/src/management/application.ts)

持久 Task 的 `STEP_STARTED`、`CHECKPOINT_WRITTEN` 等 `TaskEvent` 属于数据库里的 append-only Task 事件流，不要把它们当成每条 Run 都会写出的 Raw Trace 类型。通过授权的 `task_events` 查看，契约见 [`packages/contracts/src/long-work.ts`](../../../../packages/contracts/src/long-work.ts)。
