# Glassbox QQ 实机测试器

仓库接入后的规则以本文及 `.plans/qq-live-acceptance.md` 为准。VERIFICATION.md 和 test-results.txt 是上传工具包的历史记录，不是当前版本或真实 QQ 验收结果。

当前固定用例检查真实私聊及两个群。schemaVersion=1 的自由文本用例仅支持 `plan`。schemaVersion=2 接入指定读取工具，发送前必须取得服务端逐消息许可，完成后核对工具 Trace 并撤销许可。修改功能须先实现独立状态观察和清理。普通消息已尝试发送但结果无法确认时，也会创建 STOP。核实旧 Run 已结束及环境恢复后再人工清除。

固定 Memory 生命周期使用 `plan --case memory-lifecycle` 审阅三步消息，再执行 `run --live --case memory-lifecycle --approve-suite <SHA256>`。配置中的 `memoryFixtures.enabled` 和 `memoryFixtures.retainAuditConfirmed` 都必须为 `true`。流程在唯一的 `qqtest-<32hex>` 项目中创建反馈候选，提升该候选，再过期本轮 Memory。每一步都需要独立 Run、工具 Trace、成功投递和只读状态证据，才会继续下一步。完成后保留反馈、候选、Memory 及审计历史，不删除历史记录。

固定记忆流程在 Linux 环境运行。测试器会同步保存 `memory-fixture.jsonl` 进度记录。注册许可前保存实际消息标记和哈希，发送前保存许可回执，发送成功后保存账号侧消息回执。检查点同时记录原测试进程的 PID、Linux 启动身份、进程启动标识、私聊范围及运行版本。文件与目录写盘确认后才继续。更新 guard 时使用原子替换，保留完整旧记录；首次发布禁止覆盖已有 guard。写盘未确认时不发送消息。未确认步骤或清理时，发起账号的全局锁目录会保留 `.memory-pending.json`，后续实机运行会停止，即使改用另一个报告目录。不要直接删除这个记录来重试。中断后使用 reconcile-memory 核实原报告、Run 终态和独立清理证据，再按固定清理计划执行已授权的 reject 或 expire。这个固定流程不代表完整 Memory 功能回归，也不满足完整目录的自动合并门禁。

固定 Taste 流程使用 `plan --case taste-lifecycle` 预览，在唯一项目中依次提交正反馈、提升候选、提交负反馈、提升纠正候选以退役原偏好。运行需要启用两个 memoryFixtures 开关和四条消息预算。schemaVersion=6 可以用固定用例 `taste-project-feedback-lifecycle` 与读取、Memory、历史流程组成套件。选择套件内用例时，审批哈希始终绑定原始文件字节。四次执行必须使用不同 Run，最终只读核验必须确认没有本轮活跃偏好或待处理候选。

Taste 进度保存在账号级 `.taste-pending.json`。该记录会阻止继续发送和自动交付，交付检查在合并前再次检查。最终家族核验失败时，报告必须保留未通过状态和恢复记录。`reconcile-taste` 只处理已经独立确认的测试资源，不重发原始消息。清理完成只证明资源已清理，不能把原失败改成通过。未知发送结果继续保留 STOP。这个固定流程不代表完整 Taste、授权或作用域回归。

报告新增 `productAcceptance`。固定传输 suite 要求配置并核对 runtime，成功后报告 `TRANSPORT_ONLY`。它不算产品功能 PASS，也不能用于合并。

配置 runtime 的普通 read suite 按用例顺序执行。每条 QQ 回复通过传输断言后，测试器会先独立核对该条 Run、Trace、投递和许可撤销审计，再发送下一条。产品证据失败会停止本轮，并保留该条失败及之前已验证的用例，不重发旧消息。许可撤销未能独立确认时，测试器写入账号级 STOP。确定的回复断言失败只有在 cleanup-only 核验确认原 Run 和撤销审计后才允许结束为 FAIL 而不写 STOP；修复后可在已批准的套件和有效授权窗口内启动新一轮，不能自动重试。

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

群成员数量用例只在 Owner 私聊中读取配置的测试群 A，固定调用 get_group_member_list。正常群权限和 group.members 设置缺失时停止，不增加授权。观察器核对完整未截断的工具结果、字节数和哈希，要求模型可见结果只含 memberCount。测试器还独立读取该测试群的当前计数，成员列表只在读取封装内暂存，不写入报告或日志。计数不一致时判为证据不足，不保留成员名单。该用例不读取个人资料，也不证明成员权限变更或跨群隔离已经通过。

功能观察器目前支持指定工具事件、固定成员数聚合输出及 Task、Memory 候选、Memory 状态。它不接受任意脚本或 SQL。新功能需要新增对应观察器和隔离测试。一次工具执行成功不能代表其他未测试功能通过。

`lib/delivery-gate.mjs` 提供交付检查函数。调用者必须重新查询产品证据及远端 PR，绑定审批套件原文和哈希，覆盖全部必测用例，并核对当前提交的门禁、独立审查与 CI。该函数只判断证据。CLI 已接入 delivery-check、deliver 和 postmerge-check，具体步骤见后文。完整功能基线未通过时不得合并。

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
node tools/qq-live/cli.mjs plan --case transport-smoke
node --env-file=tools/qq-live/.env tools/qq-live/cli.mjs run --live --approve-suite <SHA256>
```

`doctor` 只读取登录身份、在线状态、版本和群成员信息，不发送消息。它通过不代表实机收发通过。

`arm` 开启最多 120 分钟的测试窗口，不发送消息。默认传输套件固定执行私聊、群 A 和群 B 三条用例。套件哈希绑定发起账号、Bot 和两个群号。实机运行要求 runtime 配置、有效授权窗口、`--live`、匹配的 `--approve-suite` 和服务端许可管理接口。每条消息获得只绑定当前输入且工具面为空的临时许可。

报告把这类结果标为 `transportOnly`，产品验收类型为 `TRANSPORT_ONLY`。它只证明固定消息的传输、实际 Run 关联和许可撤销，不计入功能目录、功能 PASS 或完整交付验收。逐条产品核验和清理记录完成后才继续下一条，全部通过后还会进行整轮复核。

每条消息要求 Bot 返回本轮唯一编号。只有 Bot 端观察到原始输入，发起账号在正确会话收到符合断言的回复，且观察窗口内没有重复合格回复，才能通过。接口成功回执不算通过。

测试串行执行，默认限制为 12 条发送消息。出现失败或无法确认时停止，不自动重发发送请求。QQ 或模型响应慢可能得到无法确认结果，需要检查证据，而不是反复运行直到偶然通过。

运行固定三条传输套件。单条 route 选择会被拒绝，避免把部分传输结果写成完整 baseline：

```bash
node tools/qq-live/cli.mjs plan --case transport-smoke
node --env-file=tools/qq-live/.env tools/qq-live/cli.mjs run --live --approve-suite <SHA256>
```

只有同时提供 A 和 B 的配置才能生成这份固定计划。

## 禁言与解禁

禁言与解禁协议 fixture 保留目标身份、同意窗口、原始状态、通知和恢复断言。当前 live CLI 在建立 OneBot 连接前拒绝 moderation，因为服务端还没有能绑定到实际消息和 Run 的精确 mutation lease。不得通过提示词或配置绕过 `MODERATION_LEASE_UNSUPPORTED`。重新接入前，必须增加受限许可、独立状态观察和清理证据。

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

`examples/feature-memory.example.json` 使用 schemaVersion 3，将既有读取用例和两个固定 Memory 流程放在同一套件中。先使用 `plan --scenarios <文件>` 审阅套件，再使用 `run --scenarios <文件> --case <用例标识> --live --approve-suite <套件哈希>` 执行。必须明确启用 Memory fixture 和审计保留。`memory-project-promote-expire` 需要三个独立 Run，消息预算至少为 3。`memory-project-feedback-reject` 需要两个独立 Run，消息预算至少为 2。每次调用只选择一个用例，读取用例也使用同一份套件哈希。

拒绝流程必须证明原候选已被拒绝，没有生成 Memory，项目没有活动 Memory 或待处理候选。它的检查点使用版本 3，恢复时保留固定流程身份。拒绝流程的已验证技能经验必须重新核验两条历史 Run、固定工具操作、Owner 与候选来源、拒绝审计及无残留状态。登记时只能选择最终 memory-reject Run。完整 Memory 隔离和授权负例仍待实现及实机验收。

`history-current-group-complete` 和 `history-owner-group-a-complete` 在原历史读取范围上增加来源及结果窗口完整性检查。它们要求单个群 A、当前测试编号、limit 1、同步终态 end_of_source、没有来源限制或结果截断，并核对 Trace 中的来源数量和返回条目。任何未报告的同步、部分覆盖或不一致元数据都会停止验收。报告不保存历史正文。完整来源窗口不能替代结果来源或跨群隔离验收。

`history-current-group-hit` 核对本轮群内输入的实际归档记录、发送者、时间和有界正文摘要。`history-owner-group-a-no-match` 使用新私聊测试编号，独立确认群 A 的已完整同步归档窗口没有匹配正文。两者都把历史证据的工具输出摘要与实际受保护 Tool result 对应，缺失新证据字段不能通过。无命中结论只适用于该归档窗口，不表示 QQ 历史之外没有相关内容。读取套件现在最多声明 16 个固定范围用例，执行消息预算仍单独检查。固定旧消息回查和跨群隔离另外执行两步流程，授权负例仍需补齐。

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

交付时使用 `delivery-check --pr <URL> --scenarios <套件文件> --reports <报告清单> --approve-suite <SHA256>`。报告清单只能包含 `schemaVersion: 1` 和 `reports` 文件路径数组，路径相对于清单文件。命令会检查完整功能目录，执行当前干净提交的仓库验证，重新核对 QQ 产品证据、清理、GitHub Actions 和当前 PR 提交的独立审查证据。缺少覆盖时会在连接外部服务前拒绝继续。

已有用户合并授权后，使用同样参数运行 `deliver --live`。命令在合并前再次检查提交与证据，先持久记录尝试，再使用精确提交执行一次 squash 合并。尝试记录按 PR 保存在当前系统用户的测试锁目录，更换报告目录、套件或测试账号不能绕过已有记录。结果未知时保留记录，不自动重试合并。本地记录用于关联尝试，不能证明拥有同等系统权限的 Agent 没有修改记录。合并事实仍须由 GitHub 确认，实机结果仍须由 QQ 消息和产品 Trace 核实。

合并确认后的结果仍需核对实际合并提交。开发 Agent 应获取 GitHub 的 `mergeCommit`，把验收 checkout 和共享服务切换到该提交，保留 NapCat、数据目录、登录状态和原生 Pi 配置。安装依赖并重新执行完整套件，使用新报告清单运行 `postmerge-check`。该命令核对原合并记录、实际合并提交的 CI，以及合并之后发送的新 QQ 消息和创建的 Run。原记录还绑定账号、测试群、checkout 和数据目录，切换这些对象不能复用原验收。全部条件通过才返回 `DELIVERED`。PR 候选提交的旧报告不能替代这一步。

当前完整功能目录仍有未实现的实机用例，这些命令会返回 `COVERAGE_GATE`。已实现的交付机制不能作为完整 QQ 回归已经通过的证据。

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

成员数用例的经验目前只能记为 hypothesis。经验记录器尚不能独立重核该计数证据，因此拒绝 verified 声明，也会从同一 Run 的原始工具 Trace 检测删除断言的降级。实机报告和技能经验需要各自通过证据检查。


schemaVersion 5 的 `feature-baseline.example.json` 同时包含既有读取、两个固定 Memory 流程、`history-group-seed-private-recall` 和 `history-cross-group-isolation`。schemaVersion 4 仍只接受原有历史回查流程。每次调用选择一个流程并批准原始套件哈希。固定历史流程先在群 A 验证自己的实际归档输入，再在 Owner 私聊查询该输入编号。后一步的 `until` 取第一条 QQ 回执的整数秒时间，只接受严格晚于第一条的第二条输入。两轮必须使用不同标记和 Run，以及同一服务版本、Owner、Bot 和连接。该流程不覆盖群 B 隔离和授权负例。

最终报告门禁从第一条真实输入重建查询、时间边界、许可和来源 Run，重新读取两轮产品证据及归档来源。不允许指定任意历史 Run 充当种子。失败或进度记录未确认时停止，不自动重发。历史报告的技能经验登记必须独立重核此两轮流程，并选择最终回查 Run。证据缺失时只能记为 hypothesis。不能通过删除来源断言改成 verified。


`history-cross-group-isolation` 先在群 B 发送并验证测试输入。查询编号和 `qq-isolation-secret-` 测试内容使用不同随机编号。Owner 随后在私聊中仅查询群 A，使用群 B 输入的编号和实际 QQ 时间边界。最终校验从第一条真实消息重建两步消息与断言，确认来源 Run 是第一步 Run。独立查询必须证明群 B 来源存在、群 A 完整窗口无匹配，并核对受保护工具输出摘要。Bot 和 Owner 两端读取的实际回复都不得带出该测试内容，包括消息字段中的固定标记。检查不识别图片或其他媒体内部的内容。两步必须使用同一服务版本，撤销临时许可，并保留消息和审计证据。未知结果停止，不重发。该流程验证查询范围隔离，不能代替撤销授权后的拒绝测试。真实 QQ 验收仍未通过。


功能验收还会独立读取持久化许可审计，核对同一许可的注册、Run 绑定和撤销记录。记录必须对应本轮编号、工具摘要、Owner、消息范围、输入摘要和 Run，并按顺序产生。报告里的已撤销字段不能单独作为清理证据。审计缺失、不完整或不一致时停止验收并保留 STOP，不能继续发送下一步消息或合并。

归档经验核验只读取已保存的运行证据，不发送消息，也不产生当前提交的实机通过结果。登记旧消息回查经验时选择最终 history-seed-recall Run，跨群经验选择最终 history-cross-group-private-exclusion Run。核验必须重建两阶段固定规格，并读取成功 Run、授权、入站正文、最终投递正文、来源归档、Raw Trace 和许可撤销审计。核验前后还要确认同一干净提交、服务进程和数据目录，两套 QQ 必须在线，核验器还会只读查询已有入站和回复消息，核对实际双端正文、序号、时间和编号。此路径只调用 get_msg，不发送或修改消息。进程已切换的旧报告缺少独立历史版本证据，只能保留 hypothesis。正文不进入经验文件。当前只支持直接文本投递，合并转发或其他未支持证据仍保留 hypothesis。不能删除流程身份或来源断言后退回单 Run 核验。

登记已验证历史经验时，给 record-lesson.mjs 增加 --config，复用既有本地 QQ 验收配置和 Token 环境变量。身份、群号、提交、checkout 和数据目录必须与报告一致。缺少双端只读消息证据时拒绝 verified，仍可登记不联网的 hypothesis。

既有受保护启动器也可调用 record-lesson --input <lesson-json>，复用其本地配置和 Token 环境变量。该命令拒绝 --live、用例执行和 PR 选项，不新发消息、不执行回归或合并。证据核验通过后才追加脱敏经验。

群信息读取用例 qq-group-a-info-read 固定在 Owner 私聊，只租用测试群 A 的 qq_groups/get_group_info。核验器检查唯一调用、成功结果、完整输出字节与摘要、群身份和 content/details 一致性，再通过 Bot 独立读取同一群。报告只保留群名摘要、成员数量和容量，不保留群名或未知字段。字段变化或无法读取时判为 INCONCLUSIVE，不重试。该用例不能代表完整群操作覆盖。归档群信息经验缺少独立历史见证时仍只能登记 hypothesis，删除报告断言不能绕过同 Run 的实际工具调用检查。

群信息输出预览仍限制为 512 字节。运行时从实际完整工具结果生成固定 groupInfo 字段和完整输出摘要。核验器在预览截断时要求这份独立字段证据，不扩大预览。实际双端回复必须是 QQGROUPINFO 测试编号 count=人数 capacity=容量 的单行纯文本，数量须与工具证据一致。添加文字、媒体消息段或其他字段都不能通过。

The fixed group A root-files read adds exact Owner-private group:files:read narrowing with no arbitrary file IDs, folders, URL resolution or mutations. Runtime groupFiles evidence derives counts and a canonical digest of validated complete returned page data from the actual protected content/details wrapper. The existing full output SHA256/byte count and 512-byte preview remain intact. A separate fixed Bot read must match the page digest and counts. The two account-local actual replies must satisfy the fixed count-only format. Default provider paging is limited to 50 entries at startIndex 0, as recorded in the pinned NapCat GetGroupRootFiles source. This operation supplies no total-directory completeness witness, so directory traversal and wider file coverage remain planned. Changed metadata, malformed entries and unavailable reads cannot pass. Historical root-list lessons remain hypotheses pending an independent historical witness. No ordinary grants, native Pi configuration or locked skill core change.

审查记录须在 Linux 或 WSL 中执行，Windows 缺少这里要求的目录持久化能力，登记会返回 BLOCKED。审查记录使用固定命令。先运行 `record-agent-review --pr <URL>` 获取当前 PR、base、head、tree、完整 diff 和文件清单的绑定。独立审查者必须核对完整改动，并在仓库外保存原始审查 JSON。再传入 `--artifact <文件> --expected-review-binding <SHA256>` 登记该绑定的审查。命令拒绝混入发送或合并选项。登记记录与原始文件保存在仓库外的私密目录，交付前会重新读取核验。记录说明受信任的本机操作者已确认审查来源，不提供密码学身份认证。正式 GitHub approval 仍可作为审查证据。当前提交的未撤销修改请求和实际分支规则仍会阻止合并。审查记录不替代功能覆盖、QQ 实机验收、CI 或已有用户合并授权。
