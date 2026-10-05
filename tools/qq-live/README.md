# Glassbox QQ 实机测试器

仓库接入后的规则以本文及 `.plans/qq-live-acceptance.md` 为准。VERIFICATION.md 和 test-results.txt 是上传工具包的历史记录，不是当前版本或真实 QQ 验收结果。

当前固定用例检查真实私聊及两个群。schemaVersion=1 的自由文本用例仅支持 `plan`。schemaVersion=2 接入指定读取工具，发送前必须取得服务端逐消息许可，完成后核对工具 Trace 并撤销许可。修改功能须先实现独立状态观察和清理。普通消息已尝试发送但结果无法确认时，也会创建 STOP。核实旧 Run 已结束及环境恢复后再人工清除。

固定 Memory 生命周期使用 `plan --case memory-lifecycle` 审阅三步消息，再执行 `run --live --case memory-lifecycle --approve-suite <SHA256>`。配置中的 `memoryFixtures.enabled` 和 `memoryFixtures.retainAuditConfirmed` 都必须为 `true`。流程在唯一的 `qqtest-<32hex>` 项目中创建反馈候选，提升该候选，再过期本轮 Memory。每一步都需要独立 Run、工具 Trace、成功投递和只读状态证据，才会继续下一步。完成后保留反馈、候选、Memory 及审计历史，不删除历史记录。

固定记忆流程在 Linux 环境运行。测试器会同步保存 `memory-fixture.jsonl` 进度记录。注册许可前保存实际消息标记和哈希，发送前保存许可回执，发送成功后保存账号侧消息回执。检查点同时记录原测试进程的 PID、Linux 启动身份、进程启动标识、私聊范围及运行版本。文件与目录写盘确认后才继续。更新 guard 时使用原子替换，保留完整旧记录；首次发布禁止覆盖已有 guard。写盘未确认时不发送消息。未确认步骤或清理时，发起账号的全局锁目录会保留 `.memory-pending.json`，后续实机运行会停止，即使改用另一个报告目录。不要直接删除这个记录来重试。中断后的自动核实和清理入口仍在开发中，当前需先核实原报告、Run 终态和独立清理证据。这个固定流程不代表完整 Memory 功能回归，也不满足完整目录的自动合并门禁。

报告新增 `productAcceptance`。未配置 runtime 时，收发 PASS 只代表 QQ 传输观察通过，产品验收仍为 BLOCKED，不能据此合并。

历史读取用例只搜索配置中的测试群 A，并把查询限定为本轮编号、返回上限限定为 1。群别名模板在预览时解析为实际群号，批准哈希绑定原始文件。测试会核对 Trace 中的查询、完整群和资源范围及检索方式，不保存历史正文。历史工具查询前可能同步该测试群的已授权历史。这两个用例只证明受限读取和检索证据，尚不能证明正命中、撤权或跨群隔离回归完整通过。

需要自动核对产品证据时，在本地配置新增 runtime，填写 checkout 的绝对路径、dataDirectory 的绝对路径、expectedCommit 的完整 40 位 Git 提交及 connectionId。threadId 默认 null。必须使用当前仓库 agent-service 管理且工作区干净的待测服务。测试前后核对 PID、checkout、提交和数据目录，再只读关联外部消息 ID、精确会话范围、成功 Run、授权记录及发起账号收到的投递 ID。任何缺失都不能通过产品验收。由 systemd 单独管理的 Glassbox 不支持这项自动核对，不能伪造登记绕过。NapCat 和 Herdr 可以保留各自服务管理方式。

OneBot 消息 ID 属于账号会话。同一条消息在 Driver 和 Bot 中可能有不同 ID。测试器只查询本轮已确认的消息，并以真实序列号、时间、发送者、会话范围及正文哈希核对跨账号关联。产品 Run 和投递 Trace 使用 Bot 会话的 ID，发起账号实际收到的回复使用 Driver 会话的 ID。缺少这些证据时不能通过。

测试报告包含私有账号信息，留在本地。验证器不会自动执行 GitHub 合并。开发 Agent 应确认本次提交的完整验收矩阵及 CI 通过，再按用户授权合并。

这是可放进当前开发仓库的命令行工具。测试器通过发起账号发送真实 QQ 消息，通过独立的接收事件验证回复。它不调用大模型，不修改业务代码，不启动或停止你的 Glassbox。

工具包自检通过不代表 Glassbox 业务功能通过。真实 QQ 验收必须单独运行并保留本次提交的报告。

## 直接放进当前项目

压缩包内部已经按 `tools/qq-live` 排列。解压到 Glassbox 仓库根目录即可，不覆盖现有业务文件。若目录已经存在，先比较文件，不直接覆盖。

使用仓库要求的 Node.js 24.12 或更新版本。读取功能目录需要仓库现有的 TypeScript 依赖，先安装仓库依赖。tools/qq-live 不维护另一套依赖或模型配置。

从仓库根目录执行：

```bash
npm --prefix tools/qq-live test
node tools/qq-live/cli.mjs init
```

`init` 创建 `tools/qq-live/qq-live.local.json`，不会覆盖已有文件。

## 功能验收

项目技能位于 `.agents/skills/qq-live-testing/SKILL.md`，Claude 镜像位于 `.claude/skills/qq-live-testing/SKILL.md`。先核对稳定核心哈希，再按技能选择新增功能用例和现有功能回归。

```bash
node .agents/skills/qq-live-testing/scripts/verify-core.mjs
node tools/qq-live/cli.mjs coverage
node tools/qq-live/cli.mjs plan --scenarios tools/qq-live/examples/feature-read.example.json
```

coverage 默认返回尚未接成执行器的功能缺口。目录中的 planned 条目不能用于交付。plan 输出套件 SHA256；审查工具、目标及断言后，把该值传入 `run --live --scenarios <文件> --approve-suite <SHA256>`。还须提供真实服务的 runtime 配置和账号环境变量。

临时许可只缩小当前 Principal 已有权限。它绑定真实发送者、完整会话、消息正文哈希及唯一 Run，限制模型可见工具与实际调用。许可失效或被撤销后继续执行会遭拒绝。自由文本不能替代这项服务端检查。许可登记回包不确定时，测试器按本轮标记撤销，不能确认清理则保留 STOP。

功能观察器目前支持指定工具事件及 Task、Memory 候选、Memory 状态。它不接受任意脚本或 SQL。新功能需要新增对应观察器和隔离测试。一次工具执行成功不能代表其他未测试功能通过。

`lib/delivery-gate.mjs` 提供交付检查函数。调用者必须重新查询产品证据及远端 PR，绑定审批套件原文和哈希，覆盖全部必测用例，并核对当前提交的门禁、独立审查与 CI。该函数不执行 GitHub 合并，CLI 尚未接入完整交付编排。完整功能基线未通过时不得合并。

## 配置现有两个账号

`driver` 是发起账号，可以是你的 Owner 账号，也可以是后续准备的专用测试号。`bot` 是 Glassbox 使用的账号。更换发起账号不需要改代码。

两边都需要已登录的 NapCat 正向 WebSocket 服务。Bot 的端点仍由 Glassbox 正常使用，测试器额外建立一个只调用查询接口的观察连接。Driver 的端点用于发送测试消息及接收 Bot 回复。

请使用 OneBot 正向 WS 地址，不是 NapCat 管理页面地址，也不是反向 WS 的目标地址。配置中的 6700 和 6701 只是示例端口，需要按你的实际设置填写。需要上报消息及通知事件，建议消息格式设置为 array。

在本地配置中填写 driver.qq、bot.qq、两个 wsUrl，以及 groups 中的真实群号。只有一个测试群时可以删除第二项。别名 A、B 用于选择用例。

把 `examples/env.example` 复制为 `tools/qq-live/.env`。在本地填写两个 OneBot Token。不要把 Token、扫码图片或登录状态发到聊天，也不要提交 Git。

需要使用主号时，先评估账号风险。NapCat 安全说明提醒同一设备或 IP 上的 Bot 与常用账号可能互相影响。测试器的目标限制不能消除 QQ 平台的账号风险。

## 先确认测试实例

测试器不会复制你的个人数据库，不会给 Owner 增加授权，也不会把群工具权限设为开放。

真实 QQ 验收使用仓库指定的同一个服务和持久 `GLASSBOX_DATA_DIR`，跨分支只切换 Glassbox checkout，保留 NapCat 账号状态。确认该服务、数据目录、账号及唯一消息处理实例后，再把 `acceptanceServiceConfirmed` 和 `soleConsumerConfirmed` 设为 true。

这两个字段是操作确认，不是自动隔离证明。真实 QQ 测试会产生真实消息和产品记录。普通自动化测试必须使用一次性隔离状态，不能写入该验收目录。仅在明确授权的群和测试时段进行真实验收。

仓库现有的服务命令包括 `npm run agent:status` 和 `npm run agent:switch -- --checkout <绝对路径>`。执行前必须读取当前仓库 `docs/tech-stack.md`，在同一个真实验收数据目录下使用。测试器不会自动调用这些命令，以免切换或停止错误的进程。

`workspace` 只记录命令调用位置。`runtime` 和 `productAcceptance` 才记录运行进程与产品证据核对结果。

## 运行真实收发测试

从仓库根目录执行：

```bash
node --env-file=tools/qq-live/.env tools/qq-live/cli.mjs doctor
node tools/qq-live/cli.mjs arm --minutes 30
node --env-file=tools/qq-live/.env tools/qq-live/cli.mjs run --live
```

`doctor` 只读取登录身份、在线状态、版本和群成员信息，不发送消息。它通过不代表实机收发通过。

`arm` 开启最多 120 分钟的测试窗口，不发送消息。`run --live` 默认依次发送私聊、群 A 和群 B 的收发测试。配置只有一个群时只执行对应群。

每条消息要求 Bot 返回本轮唯一编号。只有 Bot 端观察到原始输入，发起账号在正确会话收到符合断言的回复，且观察窗口内没有重复合格回复，才能通过。接口成功回执不算通过。

测试串行执行，默认限制为 12 条发送消息。出现失败或无法确认时停止，不自动重发发送请求。QQ 或模型响应慢可能得到无法确认结果，需要检查证据，而不是反复运行直到偶然通过。

只运行某个场景：

```bash
node --env-file=tools/qq-live/.env tools/qq-live/cli.mjs run --live --case private
node --env-file=tools/qq-live/.env tools/qq-live/cli.mjs run --live --case group-A
node --env-file=tools/qq-live/.env tools/qq-live/cli.mjs run --live --case group-B
```

## 禁言与解禁

默认关闭。只在明确同意的成员和约定时段内使用。目标不能是发起账号，也不能是 Bot，必须是普通成员。Bot 必须有 QQ 群管理角色，Glassbox 内部授权也需要正常允许该请求。工具不会绕过内部授权。

在配置 moderation 中设置 enabled=true、target 为成员 QQ 号、consentConfirmed=true，以及有效的 consentUntil。时间使用包含时区的 ISO 格式，例如 `2026-10-05T15:00:00+08:00`。示例日期不是默认授权，需要换成双方约定的真实日期。

durationSeconds 只接受 30 至 60 秒。程序开始前检查目标原本没有被禁言。

```bash
node --env-file=tools/qq-live/.env tools/qq-live/cli.mjs run --live --case moderation
```

测试通过群聊请求让 Glassbox 禁言，再通过群聊请求让 Glassbox 解禁。程序不直接调用 Bot 的禁言接口。

验收同时需要发起账号收到 Bot 操作的 group_ban 通知，以及成员查询返回相符的 shut_up_timestamp。后者是实现扩展，不保证每个 OneBot 实现都支持。字段不存在、结构错误或状态不明时，程序在操作前阻塞，不猜测默认状态。

自动到期不算解禁功能通过。正常解禁失败后，可以选用已经明确授权的主号紧急解禁。启用 `emergencyCleanupViaDriver=true` 时，发起账号也必须有 QQ 群管理角色。紧急解禁只允许 duration=0，并且必须取得本轮 Bot 禁言的通知及相符状态，避免覆盖其他管理员操作。

紧急清理成功不能替代业务验收成功。没有足够证据时，程序不会擅自解禁。清理或延迟操作无法确认时会创建 STOP 文件，阻止后续测试。此时先检查 Bot 待执行任务和群状态，不要直接删 STOP 后重试。

## 把当前任务写成测试用例

当前支持预览自定义回复断言。复制 `examples/scenarios.example.json`，修改 prompt 和 expectContains。每条 prompt 和 expectContains 必须保留 `{{nonce}}`，要求 Bot 在回复中返回编号。

先审阅待发送内容：

```bash
node tools/qq-live/cli.mjs plan --scenarios tools/qq-live/examples/scenarios.example.json
```

`run --scenarios` 已禁用。当前只允许预览，不发送自定义用例。

文件变更后摘要也会变化。自定义用例只验证回复，不能把“已经启用”“已经修改”当成配置、权限或文件副作用的证据。`sideEffect=none` 是用例声明，不是对自然语言行为的安全保证。务必审阅具体请求，且保留 Glassbox 服务端权限检查。

首版没有实现通用配置变更、模型切换、长任务、文件上传或任意群操作的状态断言。需要按对应业务接口增加固定用例，不能用回复断言冒充这些功能已通过。

## 结果交给开发 Agent

`examples/feature-memory.example.json` 使用 schemaVersion 3，将既有读取用例和固定的 `memory-project-promote-expire` 用例放在同一套件中。先使用 `plan --scenarios <文件>` 审阅套件，再使用 `run --scenarios <文件> --case memory-project-promote-expire --live --approve-suite <套件哈希>` 执行固定 Memory 流程。必须明确启用 Memory fixture 和审计保留，消息预算至少为 3。每次调用只选择一个用例，读取用例也使用同一份套件哈希。

该 Memory 用例只允许 Owner 私聊中的固定创建、推广和过期流程。用例不能增加自定义消息、工具、目标或清理脚本。成功报告必须包含三个不同 Run 的独立证据，以及重新读取的 Owner 项目清理状态。交付门禁会重新核对这些证据。此用例不覆盖 Memory 范围隔离、拒绝和授权负例，完整功能目录仍要求这些用例通过。

先读 `artifacts/latest.json`。完整内容在对应运行目录。

| 文件 | 内容 |
| --- | --- |
| report.json | 每条用例的断言结果、消息 ID、通知、清理状态和工作区摘要。 |
| events.jsonl | 持续追加的本轮相关事件。 |
| summary.md | 简短结果。 |
| attempt.json | 本次尝试已开始的记录。 |

退出码 0 表示所运行用例通过，1 表示验收失败，2 表示阻塞，3 表示无法确认。没有执行用例不能算通过。只运行一条用例也不能据此声称全部功能通过。

把 `HANDOFF.md` 交给当前开发 Agent。它规定完成修改后核实运行版本、运行本地回归、运行实机用例、读取失败证据、修复及重测的步骤。测试器本身不自动编辑代码，也不新增第二个大模型。

固定收发用例会按消息绑定和完整会话范围查询对应 Run，再调用仓库的 gbxtrace 检查入站与投递证据。产品证据写入 report.json 的 productAcceptance。只有该字段和总结果同时为 PASS，才能用于合并验收。开发 Agent 可使用对应 Run ID 继续检查失败原因。

## 停止与安全边界

Ctrl+C 会停止继续发送，并尝试已经授权的清理。也可以在报告根目录创建名为 STOP 的文件。SIGKILL、断电或整机故障不能保证自动清理，重新运行前必须检查 QQ 状态和未完成任务。

测试锁保存在当前操作系统用户的 `~/.glassbox-qq-live-locks`，按发起账号区分，避免同一用户的不同 worktree 并发测试。不同机器或不同系统用户之间没有分布式锁，不能并发运行同一账号。

固定 Memory 流程中断后，先运行 `reconcile-memory`。默认只读取记录、许可审计、对应 Run Trace 和产品状态，不发送消息、不撤销许可、不删除未完成记录。核实要求原 Linux 进程已经停止，服务使用相同 checkout、commit 和数据目录。QQ 离线时仍可核实已有证据。

只有明确发现待清理的本轮候选或 Memory 才会给出固定清理计划及哈希。使用 `reconcile-memory --live --approve-suite <SHA256>` 执行对应 reject 或 expire。恢复不重发反馈或推广消息。清理需要真实 QQ 在线、独立产品证据和状态核实。已有 STOP 保留；恢复开始后新建或改动 STOP 会停止恢复。证据不完整时保留账号级未完成记录。中断的恢复尝试不会自动接管或重试。

恢复报告的 `CLEANED` 只证明指定测试资源已经清理，不是功能验收 PASS，也不能满足合并门禁。确认其他停止原因已解决后，开发 Agent 才能另行移除原 STOP 并发起新一轮验收。

默认只允许本机地址。跨机器时优先通过 SSH 本地转发。显式允许远程时仍只接受 wss，且不会关闭 TLS 证书验证。Token 放入请求头，不放入地址参数。

工具限制发送对象、接口、消息数量及测试时段，但不是对拥有同等操作系统权限的开发 Agent 的隔离沙箱。能修改工具或读取进程环境的 Agent 仍可能取得凭证。使用主号时，要通过独立系统用户或服务权限限制凭证读取，并在修改和清理后审阅测试程序。

只保存与本轮标记或引用关联的消息，以及本轮目标的禁言通知，不保存完整主号聊天记录。报告会包含测试对象信息，仍应当作为私有材料。程序会遮盖已知 Token 和常见凭证格式，但不保证识别任意敏感内容。

## 接口依据

本次核对了 NapCat 正向 WebSocket 配置、OneBot 消息事件、group_ban 通知及接口清单。实际版本仍需要运行 doctor 和实机用例核对。

```text
https://napneko.github.io/config/basic
https://napneko.github.io/onebot/api
https://napneko.github.io/onebot/basic_event
https://napneko.github.io/other/security
```
