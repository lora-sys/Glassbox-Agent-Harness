# 症状 → 证据：排查手册

每个症状给一条最短证据路径。原则：**先定位 run，再读事件，最后才动代码**。所有命令里的 `gbx` 指 `.agents/skills/glassbox-ops/scripts/gbxtrace.mjs`。

**新版三个命令（本次新增，先用它们再通读 trace）**：

- `gbx replay <runId>` — 按"入站 → 路由 → 会话与 runtime → 模型回合 → 产出 → 投递"六段逐段报有没有证据，并列出最大的时间空洞。哪一段空，就从哪一段查。
- `gbx ingress [--full]` — 群入站证据：哪些消息没变成 run、为什么。**重启不丢**，没有 run 可用时这是唯一入口。
- `gbx msg <runId>` — 这条 run 由哪条消息触发（元数据 + sha256），并给出查正文的授权路径。

## 0. 通用入口：不知道从哪开始

```bash
gbx env                      # 服务起没起、数据目录对不对、有多少 run
gbx runs --limit 10          # 最近发生了什么
gbx replay                   # 最新 run：六段里哪段没证据 + 时间空洞
gbx show                     # 最新 run 的完整时间线
```

时间对不上时用 `gbx runs` 找用户描述时刻附近的 run；用户给了消息内容时 `gbx grep "<消息片段>" --last 100` 直接定位 run（注意消息正文只在本地看，不外传）。

## 1. 服务起不来（agent:up / agent:status 失败）

```bash
npm run agent:up            # 看报错原文
npm run agent:status        # 进程、checkout、glassboxReady / onebotReady
npm run agent:logs          # NapCat 登录/掉线证据在这里
```

两种已实测的失败签名：

- `Target checkout supports database version N, but shared data uses M`（本机实例：`supports database version 11, but shared data uses 12`）→ **安全门生效，不是 bug**。共享库 `~/.glassbox/glassbox.db` 的 `PRAGMA user_version` 比目标 checkout 的 `CURRENT_SCHEMA_VERSION` 新，启动器拒绝用旧代码开新库。处理：`--checkout` 指向支持该版本的 worktree 重起（本机命令见 SKILL.md「一」），或把迁移合入当前分支后再裸跑 `agent:up`。**不要**为了跑起来去改 `schema.ts` 的版本号或动库。
- `Target checkout does not declare a readable database version` → 启动器解析不了版本号：老版本从 `database.ts` 抠字面数字，而代码早已重构为 `CURRENT_SCHEMA_VERSION` 常量，正则必然失配。修复版从 `schema.ts` 读版本（`codex/issue-36-qq-image-input` 分支起）。遇到此错先确认运行的 `scripts/agent-service.mts` 是否已含该修复；**不要**反向去改 schema.ts 适配旧正则。

起不来的其他常见位：

- `agent:status` 进程 running 但 `glassboxReady: false` → 端口没监听，`agent:logs` 看 glassbox 启动是否崩。端口以 `service-launch.json` 的 `glassbox.env.PORT` 为准，不是 3030。
- `onebotReady: false` 但 napcat 进程在 → QQ 未登录，NapCat 在等扫码。二维码在 NapCat 数据目录的 `cache/qrcode.png`，扫码是用户动作，agent 只能指路。
- **QR 流程停滞**：日志里最后一条「二维码已保存」已过去 3 分钟以上、`qrcode.png` 的 mtime 没变、且不再生成新二维码 → NapCat 卡死了（本机实例：连续出现 `当前账号(<某QQ>)已登录,无法重复登录` 后彻底静默，QQ.exe 窗口标题仍是 exe 路径）。处理：`npm run agent:down && npm run agent:up -- --checkout <支持当前库版本的 worktree>` 拿一张新码。若同一账号在桌面 QQ 客户端已登录，扫码会撞「已登录」——用机器人账号扫码，别用本人账号。
- `glassboxReady: true` 但 curl 端点返回 `UNAUTHORIZED: A management key is required` → 这是**正常**的鉴权门，服务本身健康。用 `PORT=<端口> npm run glassbox -- <命令>` 走项目管理 CLI，别把 curl 裸端点当健康检查。

## 2. QQ 没回复 / 回复晚了

最短路径：

```bash
gbx replay <runId>                                   # 六段哪段没证据，时间空洞在哪
gbx show <runId>                                     # run 存在吗？终态是什么？
gbx events <runId> --type delivery_changed --type delivery_blocked --type delivery_denied
```

判读：

- **连 run 都没有**（`gbx runs` 里那段时间是空的）→ 消息根本没进来。先 `gbx ingress`：这份日志记了每条被处理的消息和丢弃原因，`not_addressed` = 群里没 @ 它、`empty_message` = 空消息、`not_ready` = 连接没就绪时消息被丢（NapCat 重连期间的典型现象，去查连接状态而不是去查它为什么不说话）、`acceptance_failed` = 落库或建 run 出错。确认日志存在后，再查 NapCat/OneBot 连接：`npm run glassbox -- channels list`。QQ 快速登录过期时任何旧消息或模拟事件都不算数，必须重新扫码（AGENTS.md 的 real QQ acceptance 规则）。
- `gbx ingress` 说"没有入站证据日志"→ 服务没在本次改动后重启，或这群真的一条都没进来过。**先确认是哪一种，再怀疑别处**。
- `run_finished: succeeded` 但没有任何 `delivery_*` → 投递阶段之前就断了，看 run 末尾到 `run_finished` 之间缺了什么。
- `delivery_blocked` 且 `reasons: ["empty-rendered-output"]` → 模型产出了空文本（本地真实出现过）。往下看 `turn_end` 的 `outputTokens`：为 0 或极小 = 模型侧问题；正常 = 渲染/投影问题。
- `delivery_blocked` 且 `reasons: ["internal-uuid"]` → 渲染文本里泄漏了内部 UUID，内容门禁按设计拦截。这是**拦截生效**，不是 bug；要修的是输出内容。
- `delivery_denied` 且 `reason: "no_grant"` → 当前 Audience 没有接收授权。核对会话 scope 与授权，不要放宽门禁。
- `delivery_changed` 停在 `unknown` 或反复 `sending` → 平台没给回执。`status: sent` 时看 `externalId`，凭它回 QQ 侧核对消息是否真在群里。
- **回复晚了但 run 是 succeeded** → 看 `gbx replay` 的时间空洞。典型是 `run_started → routing_decision` 之间几十秒（排队/kit 加载），或 `delivery_changed` 之间十几秒（等平台回执）。空洞本身不是错误，但它指明了慢在哪一段。
- `delivery_changed` 停在 `sending` 没有 `sent` → 传输层问题，查 OneBot 连接与 NapCat 日志（`npm run agent:logs`）。
- `delivery_changed: sending → unknown`（约 10s 后）→ NapCat 已收到发送请求但 QQ 客户端 `sendMsg` 超时未回执。本机真实签名（2026-09-29 夜）：`service.log` 连续 `Error: Timeout: NTEvent serviceAndMethod:NodeIKernelMsgService/sendMsg`，之后还有 `FetchRkey 失败 / sendPacket 超时`。这是 QQ 客户端/NapCat 侧状态坏了，不是 Glassbox 投递逻辑问题；Glassbox 侧 JSONL 与 deliveries 表都正常。处理：重启 NapCat（必要时重新扫码），Glassbox 无需改动。

## 3. run 失败（failed / interrupted / unknown）

```bash
gbx failures --limit 5
gbx show <runId>
gbx events <runId> --type tool_result --type runtime_health_observation --type routing_eval_evidence
```

本地真实数据里 failed run 的三种签名：

- `tool_result: isError=true`（如 `failureCode=input_validation_failed`）→ 工具入参被服务端校验拒绝（如 `qq_group_members` 的 `get_group_member_list`）。先看同 run 的 `tool_call.data.input`（普通工具会记，长字符串截到 64 字符；`query`/`text`/`history` 等正文键和 `group_history_search`/`owner_history_search` 整个入参不记），再看 `tool_result.data.outputHead` 里的服务端报错原文；最后才对照 `tool_evidence.required[].input` 的 Glassbox 侧声明。这是模型行为或工具契约问题。
- 声明过的事实域有未观测项（`tool_evidence(phase=resolved)` 的 outcome 为 `not_called`）→ 运行适配器的失败闭环证据门禁会把整个 run 判 failed 并改用固定话术。**这是设计行为**：模型本身可能完全正常（turn 全部完成、用量正常、回复甚至投递成功），run 仍然记 failed。别把它当执行器故障修。
- `runtime_health_observation: state=unavailable` → **先别断定执行器崩了**。`reasonCode=execution_failed` 常常只是失败结果的衍生遥测。真崩溃的伴生特征是：没有 `turn_end`、或 turn 中途断、`latencyMs` 极大（超时）、`routing_eval_evidence.unavailableModelEncountered=true`。结合模型配置 `npm run glassbox -- models list`（注意端口，见 SKILL.md 环境事实表）和 `~/.glassbox/service.log` 一起看。
- **run 没有任何 `session_start`/`turn_start`、`routing_eval_evidence` 里 `actualModel: null`、`latencyMs` 只有几十毫秒** → 模型根本没跑。看同 run 的 `tool_evidence(phase=required)`：带 `blockedMutation` 字段就是确定性意图层拦的（`run-adapter.ts` 的 `blockedMutationRequest`/`MUTATION_REQUESTS`，正则命中 `禁言/踢出/管理员/...` 等词后直接 `return {status:"failed", text:兜底文案}`，不创建会话）。`reason: "incomplete_parameters"` 最常见于**用昵称指代目标**：`namedMemberId` 只认 5-15 位数字 QQ 号，`禁言 brain 30秒` 这种永远解析不出 → 兜底文案「请求的操作未执行，请补齐必要参数后重试。」。群成员工具本可解析昵称，但这条路径不给模型机会。reply/引用文本也可能进入 `requestClauses` 造成误命中。

`interrupted`/`unknown`：先看 trace 是否完整（`gbx show` 的完整性警告），再看 `gbx env` 的服务端口——服务中途被杀会出现这类终态。

## 4. 工具行为不对（该调的没调、调错了、结果不对）

```bash
gbx events <runId> --type tool_call --type tool_result --type tool_evidence
gbx show <runId> --full        # 需要看模型原文时
```

判读顺序：

1. `session_start` 的 `data.authorizedTools[]` 里有没有这个工具——没有 = 授权/技能面问题，不是模型问题。
2. `tool_evidence(phase=required)` 的 `required[]` 声明了哪些工具域；`resolutions[]` 是最终解析。声明了但 `tool_call` 没出现 = 模型没调用；调了不在声明里的 = 越面。
3. `tool_result` 的 `isError` / `failureCode` / `outputHead` / `projection.policyVersion`：错误码指向服务端校验，`outputHead` 给前 512 字节的报错原文；`projection` 记录结果被裁剪了多少（`beforeTokens` → `afterTokens`），"工具明明返回了数据模型却说没有"常是裁剪导致的。`outputTruncated: true` 时只看到头部，完整大小看 `outputBytes`、内容比对用 `outputSha256`。
4. **入参看 `tool_call.data.input`**：普通工具会记（长字符串截 64 字符），`query`/`text`/`content`/`history` 等正文键和 `group_history_search`/`owner_history_search` 整个入参按受保护规则不记——到这一步就是边界，不要为了"看到入参"去放宽脱敏规则。需要完整入参就复现，或看 `tool_evidence.required[].input` 的声明值。

## 5. 模型/路由不对（用了错的模型、fallback 了、变慢了）

```bash
gbx events <runId> --type routing_decision --type routing_eval_evidence --type runtime_health_observation --type runtime_usage
```

- `routing_decision.executionRef` + `reason`：为什么选了它。`reason: routing_disabled` + `usedFallback: true` 说明路由策略没生效，走了默认执行器。
- `routing_eval_evidence` 里 `decisionExecutionRef ≠ actualExecutionRef` = 实际执行偏离了决策；`unavailableModelEncountered: true` = 选的模型当时不可用。
- `turn_end.data.provider/model` 与 `routing_decision` 不一致 = 执行期换将，重点看 `runtime_health_observation`。
- 慢：对比 `turn_end` 的 token 数和 run 时长；`runtime_health_observation.latencyMs` 大说明执行器侧慢。

## 6. "模型忘了之前说过的内容" / 上下文问题

```bash
gbx events <runId> --type context_budget --type history_retrieval --type learning_context
```

- `context_budget.omittedExchangeCount > 0` = 更早的对话轮被预算裁剪了，这是设计行为（P5A），不是记忆丢失。
- `history_retrieval.coverage.coverage ≠ "complete"` 或 `truncated: true` = 检索不完整，`sourceCoverage[]` 指出哪个源被截断。
- `learning_context.status: "unavailable"` = 学习检索失败（不是"没有记忆"）；`memoryIds` 为空 + `status: "empty"` 才是真的没有。
- 跨 run 的记忆问题：同一 `conversationId` 的多个 run 对比 `learning_context`。

## 7. 群权限/授权不对（管理员指令没生效、角色不对）

```bash
gbx events <runId> --type native_group_role_observed --type native_group_role_verification --type provider_mutation_verification
gbx grep "<群号>" --last 100 --type group_access_changed
```

- `native_group_role_observed.observedRole` 是 QQ 侧观察，`native_group_role_verification.verificationStatus` 是复核结果；`mismatch` = 观察与复核不一致。
- `provider_mutation_verification.verificationStatus: "mismatch"`（如 `expectedRole: qq_group_admin` vs `observedRole: qq_group_member`）= 设置群管员的操作实际没生效，需要重新执行或人工到 QQ 里确认。
- 群开关类问题搜 `group_access_changed` / `group_skill_changed` / `group_capability_changed` 的 `enabled` 和 `policyVersion`。
- **模型口头声称改了群能力 ≠ 真的改了**：核对三处证据——run 里有没有对应 `tool_call`/`tool_result`、有没有 `group_capability_changed` 事件、`group_capability_policies` 表的 `version` 和 `policy_json` 变没变。本机真实案例（2026-09-29 夜）：run 无任何 tool_call、无事件、表停在 v7，模型却回复「已启用 group.moderate ✅ version 8」——纯幻觉，owner 被误导后去群里测试必然失败。能力开关的权威入口是管理面，不是群聊对话。
- **非 Owner 的回复被替换成「身份以当前发送者的 QQ 号为准…」且 run 判 failed** → #90 引入的 post-turn 身份门禁（`misattributesSender`）。看模型原文（`gbx show <runId> --full`）：拒绝文本里**提及**受保护身份（如「非 Lora 发件人…请由 Lora 本人发起」）也会命中——门禁分不清「冒用身份」和「提及身份的拒绝」，是已知误报形态。冒充场景命中是设计行为；普通提问命中是误报，需要收紧 `misattributesSender` 而不是关掉门禁。
- 群角色审计视图（服务端、授权边界内）：`npm run glassbox -- trace group-role-audit <channel-id> <group-id>`。

## 8. trace 本身有问题（坏行、seq 断点、文件缺失）

```bash
gbx show <runId>      # 末尾会报：malformed 行数、seq 断点数
```

- Raw Trace 是 append-only 证据，**任何情况下不要手工编辑 trace.jsonl**。完整性告警的含义：服务端写入被中断（进程被杀/磁盘满），或文件被外部改动。
- 先停服务（`npm run agent:down`），保留现场，再决定是否需要备份整个 run 目录做分析。
- `run 目录存在但 trace.jsonl 缺失` = run 没产生任何事件就结束了，查服务日志 `npm run agent:logs`。

## 9. 改动之后：验证与回归

排查修完代码后，按仓库门禁走，不要自创检查：

```bash
vp run verify:commit     # commit 前必跑；改了 scripts/ 会回退全量单测
vp run verify:full       # PR 前
npm run test:regression  # 渠道/投递/ops 聚焦回归
```

真实 QQ 验收按 AGENTS.md「Real QQ acceptance across worktrees」执行：一个共享 `GLASSBOX_DATA_DIR`、`npm run agent:switch -- --checkout <路径>` 切换、NapCat 保持运行；端口监听 ≠ QQ 已登录。汇报时把确定性测试、provider 探测、真实 QQ 投递分成三个独立结果。

## 汇报格式（给用户的结论）

每次排查结束给四行：哪个 run（id + 时间）、哪条事件是证据（seq + 类型 + 关键字段）、根因一句话、和 AGENTS.md 哪条规则相关。凭据与消息正文不进汇报。
