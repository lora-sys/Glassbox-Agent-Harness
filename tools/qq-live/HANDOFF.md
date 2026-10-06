# 给当前开发 Agent 的执行要求

仓库接入版补充规则：schemaVersion=1 的自由文本用例只允许 plan。schemaVersion=2 仅接入指定的读取工具，需要服务端把许可绑定到真实发送者、完整会话、消息哈希和 Run，并验证工具 Trace。修改操作须先补独立观察和清理执行器。普通发送结果未知也会持久创建 STOP。report 的 productAcceptance 必须为 PASS 才能证明已核对运行版本及产品证据。transport PASS 或 doctor PASS 不满足合并条件。runtime 配置使用 checkout、dataDirectory、expectedCommit 和 connectionId。threadId 默认 null。当前只有 agent-service 登记的服务支持自动进程核对；systemd 服务不能冒充该登记。

用户当前需要在开发 Glassbox 的过程中使用真实 QQ 验收。不做网页 UI，不等待项目全部写完。使用本目录现有工具，不另建聊天 Agent，也不要通过模拟 Owner 事件冒充实机测试。

## 接入

先读取仓库当前 AGENTS.md、相关有效计划、docs/tech-stack.md 和本目录 README.md。不要重写业务架构、修改生产权限或替换整个 package.json。本目录使用 Node 内置功能，不需要额外安装依赖。

模型直接使用 Owner 已配置的 Pi provider 和 model。先核实服务的 PI_CODING_AGENT_DIR，再用同一目录的 Pi CLI 验证指定模型。不要复制一套旧配置、创建独立 Glassbox 模型项或修改 Owner 的上下文与输出上限来绕过兼容问题。Pi CLI 能调用而 Glassbox 拒绝时，检查并修复 Glassbox 的映射和请求预算逻辑。

保留本地未提交改动。所有测试器修改单独审查，不能覆盖用户正在进行的开发。没有明确授权时不提交 main、不部署生产。

执行 `npm --prefix tools/qq-live test`。然后运行 init，由用户在本地完成账号登录、配置和 Token。可以帮助填写非秘密配置，但不得索要扫码凭证、会话文件或把 Token 写入报告。

普通自动化测试使用一次性隔离状态。真实 QQ 验收使用仓库指定的同一个服务及持久数据目录和约定测试群。确认只有一个处理测试消息的实例。不要自动停掉不属于本次开发环境的进程。

## 每次完成业务修改后的步骤

先运行仓库相关本地测试。然后使用仓库服务命令启动或切换到本次修改的 checkout，并从服务状态核实实际 checkout。测试器报告中的工作区摘要不是运行进程证明。

运行 doctor。账号掉线、Token 拒绝、成员关系缺失或实例无法确认时停止。不要为了连通而放宽授权、关闭鉴权或更改测试预期。

在有效授权窗口内运行相关实机用例。首次至少运行 private、group-A 和 group-B。禁言测试只有在目标与同意时段明确、独立配置已启用时才运行。

先读 latest.json 的结果。需要定位时只读对应运行目录，不读取整套个人聊天历史。用测试编号、消息 ID 和时间定位 Glassbox Run。不得仅凭“这是最新 Run”关联执行证据。

FAIL 表示验收结果不满足预期，先查证故障位置。BLOCKED 表示配置、环境、身份或清理阻塞。INCONCLUSIVE 表示证据不足或结果未知。后二者不能伪装为通过，也不能猜测问题后盲目修改产品。

定位到产品问题后，修改业务代码、补充本地回归、重新启动正确版本，再重跑原失败用例和相关回归。每轮修复必须有故障证据和回归结果。继续处理已定位的问题，直到相关验收通过或需要外部条件。没有确认的发送结果不得直接重发，尤其不能重复群操作。

禁止为了得到 PASS 删除断言、降低断言要求、重写证据、把真实调用替换为模拟、跳过未通过用例或更改权限。需要改变验收标准时单独列出原因和差异，不与修复悄悄合并。

## 报告完成情况

说明测了哪个运行版本、哪些真实用例、每条结果和证据路径。区分本地测试通过、环境检查通过及 QQ 实机测试通过。不要声称 no bug，也不要把一条用例通过写成所有 QQ 功能通过。

实机未连接时，准确报告缺少的本地配置，不编造 PASS。当前工具包本身的回归结果不代表用户 QQ 或 Glassbox 已通过。

## 首版范围

固定实机用例覆盖真实私聊、指定群 @ Bot 的收发，以及可选的禁言和解禁效果。它们只证明传输和对应固定操作，不能替代功能回归。结构化读取用例示例见 examples/feature-read.example.json。先运行 plan，审查消息和工具范围，再把套件 SHA256 传入 run 的 --approve-suite。

运行 `node tools/qq-live/cli.mjs coverage` 盘点覆盖缺口。默认功能目录已有受限读取用例和固定 Memory 家族，其余条目仍待实现。planned 条目不能计入执行覆盖。将条目接成真实用例、独立观察和清理之后，再运行覆盖检查。不能把补了一段测试说明解释为已经测试。

成员数用例只在 Owner 私聊读取测试群 A 的聚合总数。必须核对完整工具输出的字节数、哈希和固定 memberCount 结构，不读取成员名单。缺少正常授权时停止，不能改群权限来通过测试。

权限变更、模型切换、文件传输和长任务等需要新增对应的状态观察及断言。不要只根据 Bot 说成功就报告通过。

当工具写入 STOP，或者群操作的结果未知时，先停止相关 Bot 待执行动作并核实群状态。只有原操作已结束且环境恢复后，才允许人工清除 STOP 并重测。

固定记忆流程使用 plan --case memory-lifecycle 审阅消息，再传入 --approve-suite 执行。先明确启用 memoryFixtures.enabled 和 retainAuditConfirmed。每一步核对独立 Run、工具、状态与投递，成功后过期本轮项目 Memory 并保留审计历史。未核实的步骤会保留账号级 .memory-pending.json，禁止通过更换报告目录或删除文件来重试。使用 reconcile-memory 只读核实中断的原流程，再按输出的固定清理计划哈希执行授权清理。恢复只执行 reject 或 expire，不重发反馈或推广。恢复自身中断时继续保留记录，不自动接管。CLEANED 只证明清理完成，固定流程也不能替代完整 Memory 回归。

schemaVersion 3 套件可同时包含推广后过期和 memory-project-feedback-reject 两个固定流程，每次调用只执行一个。反馈后拒绝需要两个独立 Run、原候选来源和拒绝审计证据，不允许出现 Memory 或推广 Run。版本 3 检查点固定记录此流程身份。拒绝流程尚未经过真实 QQ 验收。经验登记现已支持独立重验历史反馈与拒绝 Run，必须选择最终 memory-reject Run，并通过 Owner、候选来源、拒绝审计和无残留状态检查。

## 交付与合并后验收

先使用 delivery-check 核对审批套件、报告清单、完整功能目录、仓库验证、重新读取的产品证据、清理和 GitHub 当前提交的检查与独立审批。缺少任何必需用例时保留阻塞结果。不要修改目录或报告来绕过缺口。

已有用户合并授权且全部门禁通过时，deliver --live 才能执行一次精确候选提交的 squash 合并。命令先持久记录 PR 级尝试。结果未知时不重试，也不能用新目录、套件或账号绕过已有尝试。

合并结果不是最终验收。获取实际 mergeCommit，将原验收 checkout 和共享服务切换到该提交，保留账号、测试群、数据目录、NapCat 和原生 Pi 配置。重新运行完整套件，再运行 postmerge-check。消息必须在合并后新发，Run 必须属于实际合并提交。原候选提交的报告不能替代合并后报告。只有全部证据核对通过才能报告 DELIVERED。


固定旧消息回查使用 schemaVersion 4 套件中的 `history-group-seed-private-recall`。先 plan 审阅 `feature-baseline.example.json`，再逐个用例运行并批准原文件哈希。第一条群 A 输入必须通过当前消息归档命中检查。第二条 Owner 私聊只查第一条编号，并把 until 固定到第一条实际 QQ 时间。第二条输入同秒时停止，不重发。报告和交付门禁必须重建来源关系、重新读取两轮产品证据，不能用单个回查 Run 代替完整流程。群 B 隔离另有固定流程，其他未完成领域仍阻塞完整覆盖门禁。此流程尚未通过真实 QQ 验收。


跨群流程是 schemaVersion 5 中的 `history-cross-group-isolation`。baseline 文件同时保留群 A 旧消息回查。跨群流程先验证群 B 的实际输入，再在 Owner 私聊仅查询群 A。最终校验将测试内容摘要、来源 Run 和实际时间重新绑定到第一步输入，独立重核两步 Trace、归档和回复，并确认两项临时许可撤销。目录仅声明这项范围隔离覆盖，授权撤销拒绝和其他完整历史用例仍未完成。当前两套 QQ 登录均需手机扫码，不能把本地模拟结果称为实机通过。


功能验收还会独立读取持久化许可审计，核对同一许可的注册、Run 绑定和撤销记录。记录必须对应本轮编号、工具摘要、Owner、消息范围、输入摘要和 Run，并按顺序产生。报告里的已撤销字段不能单独作为清理证据。审计缺失、不完整或不一致时停止验收并保留 STOP，不能继续发送下一步消息或合并。

归档经验核验只读取已保存的运行证据，不发送消息，也不产生当前提交的实机通过结果。登记旧消息回查经验时选择最终 history-seed-recall Run，跨群经验选择最终 history-cross-group-private-exclusion Run。核验必须重建两阶段固定规格，并读取成功 Run、授权、入站正文、最终投递正文、来源归档、Raw Trace 和许可撤销审计。核验前后还要确认同一干净提交、服务进程和数据目录，两套 QQ 必须在线，核验器还会只读查询已有入站和回复消息，核对实际双端正文、序号、时间和编号。此路径只调用 get_msg，不发送或修改消息。进程已切换的旧报告缺少独立历史版本证据，只能保留 hypothesis。正文不进入经验文件。当前只支持直接文本投递，合并转发或其他未支持证据仍保留 hypothesis。不能删除流程身份或来源断言后退回单 Run 核验。

登记已验证历史经验时，给 record-lesson.mjs 增加 --config，复用既有本地 QQ 验收配置和 Token 环境变量。身份、群号、提交、checkout 和数据目录必须与报告一致。缺少双端只读消息证据时拒绝 verified，仍可登记不联网的 hypothesis。

既有受保护启动器也可调用 record-lesson --input <lesson-json>，复用其本地配置和 Token 环境变量。该命令拒绝 --live、用例执行和 PR 选项，不新发消息、不执行回归或合并。证据核验通过后才追加脱敏经验。

群信息读取用例 qq-group-a-info-read 固定在 Owner 私聊，只租用测试群 A 的 qq_groups/get_group_info。核验器检查唯一调用、成功结果、完整输出字节与摘要、群身份和 content/details 一致性，再通过 Bot 独立读取同一群。报告只保留群名摘要、成员数量和容量，不保留群名或未知字段。字段变化或无法读取时判为 INCONCLUSIVE，不重试。该用例不能代表完整群操作覆盖。归档群信息经验缺少独立历史见证时仍只能登记 hypothesis，删除报告断言不能绕过同 Run 的实际工具调用检查。

群信息输出预览仍限制为 512 字节。运行时从实际完整工具结果生成固定 groupInfo 字段和完整输出摘要。核验器在预览截断时要求这份独立字段证据，不扩大预览。实际双端回复必须是 QQGROUPINFO 测试编号 count=人数 capacity=容量 的单行纯文本，数量须与工具证据一致。添加文字、媒体消息段或其他字段都不能通过。

The fixed group A root-files read adds exact Owner-private group:files:read narrowing with no arbitrary file IDs, folders, URL resolution or mutations. Runtime groupFiles evidence derives counts and a canonical digest of validated complete returned page data from the actual protected content/details wrapper. The existing full output SHA256/byte count and 512-byte preview remain intact. A separate fixed Bot read must match the page digest and counts. The two account-local actual replies must satisfy the fixed count-only format. Default provider paging is limited to 50 entries at startIndex 0, as recorded in the pinned NapCat GetGroupRootFiles source. This operation supplies no total-directory completeness witness, so directory traversal and wider file coverage remain planned. Changed metadata, malformed entries and unavailable reads cannot pass. Historical root-list lessons remain hypotheses pending an independent historical witness. No ordinary grants, native Pi configuration or locked skill core change.
