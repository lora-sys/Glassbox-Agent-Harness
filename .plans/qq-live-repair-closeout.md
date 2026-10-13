# QQ 实机修复与交付

2026-10-08。按 lora-mode 的 bug-fix，L 档执行。此轮交付以修复已观察的问题并完成真实环境验收为主。用户要求主 Agent 独立完成，审查采用行内自查。

## 当前目标

通用 qq-chat 入口已经完成。继续修复已登记的问题并用自然语言回归，排查 QQ 授权失效。完成当前 PR 后核查 PR #140 及其关联 Issue，再接入 Issue #28/#29 分支并测试真实 QQ 和 Web 界面。只有实际验证的修复可以关闭 Issue 或合并。开发 checkout 与部署 checkout 分离，共用一套明确授权的实机数据，自动化测试使用隔离数据。QQ 掉线时继续修代码和隔离测试，等待用户回来确认登录后完成实机验证。

## 执行步骤

1. [x] 加载 debug skill 并按其全程执行。
2. [ ] 最小化复现。
3. [ ] 定位。
4. [ ] 假设与验证。
5. [ ] 根因处最小修复。
6. [ ] 复验 + 回归面。
7. [ ] 教训沉淀。
8. [ ] 按证据交付。

## 实时事实

两套 QQ 被用户扫反。已分别通过 get_login_info 和 get_status 确认 Bot 在 6701，Owner 在 6700。修改 Glassbox 渠道及 qq-chat 端口映射，保持 QQ 登录和 NapCat 进程不动。Bot WebUI 6100，Owner WebUI 6098。新私聊 Run 898ce1b1-c004-4a10-9ea9-cf3399c5c8ec 已成功并收到 Owner 端真实回执。

## 待验证的问题

- #191。视频请求的动词识别没有覆盖“做一段”；图片生成证据存在但投递依赖模型回写 asset 标记。
- #192。Worker 启动失败后查询只有 protected_tool_failed，最终文本含内部 UUID 导致完全不投递。先读实际派发阶段证据，再修错误投影和任务执行原因。
- #186。管理员身份没有新查询证据，候选代码已有修复，待真实回归。
- #150。账号目录已分开持久化。已观察到 QQ 主动通知登录失效，再由 NapCat 重建 Worker。根因与持续登录验收均未完成。
- PR #142。仍为 draft，远端旧版本存在两项失败检查。当前本地修复未推送，不能把本地通过视为远端通过。
- PR #140。核对实际修复、重复部分、关联 Issue 和测试矩阵后决定集成，不能仅凭 PR 描述认定完成。
- Issue #28/#29。后续接入现有分支，对 QQ 和 Web 完整验收。尚未开始本轮验收。


## 2026-10-11 后续定位

- 通用工具已能持续收取和查看过程。WSL 重启后观察器按原日志继续，没有复制账号状态。
- 群成员工具的根 schema 联合缺少显式 object 外层，模型把 params 序列化成字符串。已补 object envelope，保留原操作分支约束；原 Pi 模型直接 A/B 对比及 432 项测试通过。
- 群身份查询含“不要禁言”时，移除拒绝分句后原实现用空格拼接，能力问句过滤误删相邻查询。已保留分句边界并用原自然语言回归测试覆盖。
- 已发现并修正两套快速登录账号与容器启动账号的错配，未重启 QQ。两套扫码确认后当前账号及在线状态均核对正确，长期与重启验收仍待完成。
- PR 140 的 history-poller 和 Kit 核验部分已存在于候选工作区，不能重复整包复制。其 bounded delivery retry 仍未接入。另发现当前服务回滚缺少启动源码一致性检查，已用失败回归复现，恢复现有源码摘要校验后 38 项服务测试通过。

## 2026-10-13 continuation checkpoint

- 用户表示两套账号已扫码，但当前只读 NapCat 状态没有确认 Bot 登录完成：6098 的 Owner `3526039967` 为 `ready`，6100 的 Bot `3394947361` 为 `waiting_qrcode`。当前只有 OneBot 6700 在监听，6701 未监听。此刻不能开始 Bot 收发验收。
- 两个 NapCat 容器都在运行，`restartCount=0`、策略为 `unless-stopped`。Owner 与 Bot 使用不同的持久化 config 和 QQ profile 挂载，QQ 主进程参数分别绑定 `3526039967` 与 `3394947361`。本次检查没有重启 NapCat，也没有清理或改写 profile。当前证据说明本地容器和账号目录仍在，不能证明 QQ 服务端不会撤销授权。
- 唯一 Glassbox 服务仍为 PID `2814679`，运行于 checkout `/home/yanbingzhao/src/qq-live-followup-verify-20261013`，commit `fefcdec24d31ae1448981e01c235954b40548caa`，数据目录 `/home/yanbingzhao/.glassbox`。PR 候选没有切入该服务。
- 已创建独立的部署源 checkout `/home/yanbingzhao/src/glassbox-deployment`，当前固定在 `origin/main` 的 `3966c3be88ef7f041f2a7c134a1866844cfd34f8`。它尚未安装依赖，也未启动服务。PR 合并后需将其更新到合并提交、安装该提交依赖并通过部署验证，再按单服务流程切换 Glassbox。
- PR #142 远端 head 是 `90c60c4e2f880cfabb5b1f994f91d058ff8176d3`，保持 draft，远端检查通过；此前本地全量验证为 3095 项通过、1 项既有可选 Herdr 测试跳过。该候选尚未在实机服务上验收。PR #140 与其有 25 个重叠文件且当前冲突。PR #142 已带入 #109、#111、#112、#117 对应改动，没有带入 #110 的未知投递自动重试。两边的具体行为仍以代码比较和真实验收为准。
- Tool surface 使用域描述、权限筛选和请求级收窄。存在已识别 required Tool/evidence 时，会在创建 Pi 会话前缩小工具集合；没有识别结果时，模型仍可看到该主体当前获准的完整集合。这不是按需延迟加载。当前没有真实运行的工具发现耗时分布，先在 Bot 上线后的自然语言实测中记录 Tool 数量、schema token 估算和阶段耗时，再决定是否改造。
- 网络检查显示两套 NapCat 使用 host 网络，容器重启次数仍为 0。两个 QQ 进程的子进程均有已建立的连接到 `127.0.0.1:7897`，所以“代理端口不可达”不是当前有证据支持的原因。NapCat 代理环境变量为空，但活动 QQ 连接仍经过该代理端口。
- 两个 NapCat config/profile 目录都包含 3526039967 和 3394947361 的账户配置或 `UnitedConfig` 子目录。6098 的历史截图曾选中 Bot 账号，但只读 `GetQuickLoginListNew` 在两个 WebUI 都返回空列表。当前进程启动参数与 `glassbox-account` 仍各自正确。跨账号目录可能导致登录页选错，但现有证据还不能证明它造成 QQ 会话失效；没有移动、删除或修改任何账号文件。

## 2026-10-12 18:49 UTC 用户确认扫码后的复核

- 用户表示 6100 已完成扫码。随后两次通过 `qq-chat status` 查询实际 OneBot 状态，Owner `3526039967` 为 online，Bot `3394947361` 返回 `WS_NOT_READY`。`ss` 只看到 6700 监听，没有 6701。6100 的 NapCat WebUI 进程仍在监听，页面进程存活不代表 QQ 登录完成。
- 两个 NapCat 容器仍运行，`restartCount=0`。没有发送测试消息，没有重启 NapCat，也没有修改账号资料。Bot 真实收发验收继续等待 OneBot 6701 建立。

## 2026-10-12 18:59 UTC 部署 checkout 状态读取兼容性

- 独立部署 checkout /home/yanbingzhao/src/glassbox-deployment 当前位于 origin/main commit 3966c3be88ef7f041f2a7c134a1866844cfd34f8。依赖安装完成，全量验证仍在运行。
- 从该 checkout 调用只读 agent:status 报 Invalid service state。共享 service-processes.json 含 launchCommit 和 launchClean 字段，main 的状态解析器不接受这些字段。当前服务 checkout 的候选提交 90c60c4 支持这些字段；从候选 checkout 执行 status 可正常读取运行中的 Glassbox PID 2814679。
- 该错误没有修改服务状态。部署 checkout 暂时不能管理当前共享服务状态；合并含有向前兼容解析的版本并重新验证前，不得从旧 main checkout 执行服务切换。

## 2026-10-12 19:04 UTC 部署基线 OneBot 测试复现

- 部署 checkout main 的全量验证报告 2790 项通过、1 项失败、1 项既有跳过。失败是 OneBot 私聊 not_ready 诊断测试在 30 秒超时。
- 为排除工具路径影响，用部署 checkout 自己的 npm test 入口单独运行该测试文件，仍复现 57 项通过、该测试超时。测试回调等待一个永不结束的 Promise，afterEach 清理又等待 adapter.stop 完成该队列，因此测试卡住。
- PR 候选将回调改为响应 AbortSignal，并通过 WebSocket terminate spy 控制后续帧顺序。候选分支同名定向测试通过；这项修复属于候选分支，不是部署 main 的通过证据。部署 main 的全量门禁仍失败，不可作为可部署版本。
- 当前 Glassbox 服务和 NapCat 均未受测试影响。


## 2026-10-13 03:34 +08:00 Bot 登录复核

- 用户确认刚完成 6100 页面登录操作。复核时 `qq-chat status` 仍显示 Owner `3526039967` 在线，Bot `3394947361` 为 `WS_NOT_READY`。本机只有 OneBot 6700 在监听，6701 未监听；Bot NapCat 的配置文件仍启用 6701，两个 NapCat 容器仍运行且重启次数为 0。
- 6100 WebUI 端口仍可访问，但页面存活不代表 Bot OneBot 已连通。当前没有发送测试消息、重启 NapCat、改动配置或触碰账号目录。Bot 自然语言收发验收仍未开始。

## 2026-10-13 后续状态与掉线根因调查

- 用户表示已完成登录操作后再次只读检查。Owner 3526039967 仍通过 6700 在线；Bot 3394947361 仍为 WS_NOT_READY，本机没有 6701 监听。当前唯一 Glassbox 进程仍运行在候选 checkout ede59656382fcefadc989bd94b0efc6f47233379，数据目录未变。没有发送 QQ 消息，也没有重启或修改运行中的 NapCat。
- 两个运行中的 NapCat 容器仍使用镜像摘要 sha256:41b1a8e10953065f4796ab19c0c8760cd3175376be976c5480710d29a77357ee。独立下载的官方 v4.18.30 镜像摘要为 sha256:335f9310198504d8d07aba91cc91d89215269891919c26eb4e46052ff8bb176d。它的发布说明包含静默离线后等待 60 秒、重启 Worker 并尝试快速登录的修复；快速登录失败仍要求扫码。
- 上游 issue #2071 描述了与本项目历史 UI 看似在线、OneBot 不再收消息相符的静默离线路径。当前本机历史日志没有足够的匹配事件，不能确认所有 QQ 掉线都是这个根因。新镜像只在无网络、无持久卷的隔离容器中测试，WebUI 返回重定向；未测试 QQ 登录、自动恢复或真实收发。
- 已将仓库部署 compose 更新到固定的 v4.18.30 镜像摘要，并更正文档：agent:status.onebotReady 只检查 6700，账号身份和 Bot 6701 状态以 qq:chat status 为准。该修改尚未部署到运行中的容器。


## 2026-10-13 latest verification

- After the 6100 login operation, both the configured account marker and WebUI auto-login setting identify the Bot account. Its OneBot configuration enables port 6701, but no process listens there. qq-chat status remains WS_NOT_READY. The Owner OneBot connection on 6700 remains online.
- The Glassbox process remains on commit ede59656382fcefadc989bd94b0efc6f47233379 in /home/yanbingzhao/src/qq-self-role-surface with data in /home/yanbingzhao/.glassbox. No NapCat container or account directory was changed during this check.
- The repository compose pin targets NapCat v4.18.30. The config was validated with non-live placeholder values. The live containers still use the previous image digest. No real QQ test can pass until Bot port 6701 is ready.
- PR #142 now points to 01895f4425258567bef522e2d73edcde25c91d61. Local verify:full and verify:commit passed with 3,095 tests passed and one existing optional Herdr test skipped. GitHub checks are still running.
- PR #140 is open and conflicting with PR #142. Their current changed-file lists overlap in 18 paths. PR #140 lists Issues #109, #110, #111, #112, and #117; all five issues remain open. PR #142 already covers #109, #111, #112, and #117. Keep #110 automatic unknown-send retry excluded because it can duplicate a message.


## 2026-10-13 Bot runtime update

- The Bot driver Compose image was updated to the pinned v4.18.30 digest. Its existing config and NTQQ bind mounts were preserved. The Owner container was not restarted.
- The first Compose invocation used the directory-derived project name and briefly started a second container against the same account mounts. It was stopped and removed immediately. The existing project label was then verified as glassbox-qq-live-driver, and only that project was recreated. A final container check showed one Bot container and one Owner container. The operations skill now records the explicit project-name requirement.
- NapCat reported the Bot login state expired, rejected quick login, and generated a QR. The latest qq-chat status still reports Owner online and Bot WS_NOT_READY. Port 6700 listens; port 6701 does not. The user must confirm the current 6100 QR before real acceptance can continue.
- No new real QQ messages or group actions were executed after the update.
- PR #142 head ef47bd4 has local commit verification passed. The full suite reports 3,095 passed and one existing optional Herdr skip. GitHub CI is still pending for code and dependency review.

## 2026-10-13 Bot QR confirmation checkpoint

- After the user reported scanning the wrong account, only the Bot NapCat container was restarted. Its existing config and account-volume mounts were preserved; the Owner container and Glassbox service were not restarted.
- The Bot startup reported that its saved quick-login state had expired, then entered QR login. The QR itself is intentionally not recorded. This explains the current Bot outage at the NapCat session layer; it does not establish the cause of every earlier QQ logout.
- A fresh qq-chat status still showed Owner online and Bot WS_NOT_READY. Port 6700 listened; 6701 did not. The current real-QQ gate is confirmation of the Bot account on the 6100 page, followed by verifying 6701 and the account identity before sending any message.
- No test message or group action was sent. No credentials, QR links, account files, or message contents were copied or modified.

## 2026-10-13 PR overlap review

- GitHub currently reports PR #142 open, draft, and mergeable at head 420b89b64aa1bf9611962b81dc0bd20430842b1c. Its Text portability and Hygiene CI runs both completed successfully. Review submissions are empty.
- PR #140 remains open and conflicting. It changes 27 files; 26 also appear in PR #142. The history poller implementation for #109 is already present in both candidates. PR #142 also contains the configured gate wording and evidence-bound capability command for #112, launch checkout identity safeguards for #111, and the narrowed reply identity check for #117. All five issues #109, #110, #111, #112, and #117 remain open.
- PR #140's #110 bounded retry resends transport-unknown QQ deliveries. The same immutable delivery ID does not guarantee QQ deduplication. Keep this change out under the no-automatic-retry rule; preserve the unknown outcome and investigate through Trace.
- Do not merge PR #140 as a unit. After PR #142 acceptance, compare any remaining #111, #112, and #117 changes against the merged implementation and port only independently justified gaps with focused tests.

## 2026-10-13 Linux NapCat persistence path investigation

- Read-only directory metadata shows both separate QQ data mounts contain nt_qq/global/login.db and nt_qq/global/nt_data/msf/machine-info, while neither mount has a top-level global directory. The two machine-info hashes differ. No account file was opened, copied, moved, or changed.
- Both active containers use host networking and separate data mounts. Bot runs the pinned v4.18.30 image; Owner uses the older image digest 41b1a8. The current offline Bot startup rejected its saved quick-login state and fell back to QR.
- NapCat upstream PR #2099 merged on 2026-10-11. It changes Linux global data from nt_qq/global to global and migrates the old path only when the new path is absent. The official v4.18.30 release predates that merge. This is a concrete local persistence defect candidate, but it does not prove that QQ-side revocation never occurs.
- Upstream NapCat issue #2079 reports two separate QQ containers losing sessions close together despite separate persistent mounts; the maintainer closed it as QQ risk control. Local persistence and automatic recovery reduce avoidable failures but cannot prevent QQ from revoking a session.
- The official NapCat release page lists v4.18.30 as latest, which predates PR #2099. The PR provides a temporary Docker image built from c358c86 and labels it for cleanup after 120 hours. Its pinned OCI index digest is sha256:9d9fc425c0a4dfb9a7aa8f84a6181f741ad12a589b86b844959eb3e4dd57e188. Do not use it as a deployment image.


## 2026-10-13 Bot persistence test image checkpoint

- Rechecked the local mapping from mounted configuration and the account marker: WebUI 6100 is Bot 3394947361 with OneBot 6701; WebUI 6098 is Owner 3526039967 with OneBot 6700.
- The Bot test Compose now pins the temporary upstream PR #2099 image digest above. The existing Bot config and QQ data bind mounts remain in place. Owner and the separate docs NapCat deployment container were not changed.
- The local Compose uses localhost/napcat:pr-2099-c358c86 with pull_policy never. That local-only tag points to the same digest and remains available in this workstation cache after upstream cleanup. The active Bot container still references the pinned digest.
- The single Glassbox process remains on /home/yanbingzhao/src/qq-self-role-surface at commit ede59656382fcefadc989bd94b0efc6f47233379 with /home/yanbingzhao/.glassbox. PR #142 remains in a separate worktree at 420b89b. No service switch has occurred.
- A first Compose invocation used the directory-derived project name and briefly started a second Bot container against the same bind mount. It was stopped and removed promptly. The correct existing project, glassbox-qq-live-driver, was then recreated in place. The active process list now has one Bot NapCat using the volume.
- The new image has the expected Linux data layout: global/nt_db/login.db and global/nt_data/msf/machine-info exist, and nt_qq/global no longer exists. No account file content was opened or copied.
- Bot still reports WS_NOT_READY and 6701 is not listening. The migration does not establish a QQ session.
- Owner remains online on 6700 in the older docs-napcat-1 image, created 2026-09-14, with login.db and machine-info under nt_qq/global. That running Owner container was not changed. Its path migration and restart recovery remain unverified. No test message or group action has been sent. Real acceptance remains gated on confirming Bot 3394947361 in the 6100 page and verifying get_login_info plus OneBot readiness.


## 2026-10-13 Tool schema and discovery audit

- QQ capability Tools have fixed TypeBox operation schemas. Object alternatives are exposed through an object envelope with nested params, while anyOf preserves exact operation validation. The runtime validates inputs with TypeBox Value and rechecks the acceptance lease at execution.
- A schema projection defect did recur in real tests: the Owner managed-group inventory incorrectly required a group ID, lease-derived inputs were missing from model-visible schemas, and a root union led Pi to serialize nested params incorrectly. The candidate repairs these contracts rather than removing schema validation.
- Required-evidence classification narrows already-authorized Tools for recognized factual requests before Pi session creation. Ordinary messages with no required-evidence match retain the authorized surface. Progressive lazy discovery is not implemented; the architecture document describes it as a possible future option.
- Seven focused runtime files passed 263 tests, including the actual Pi argument validator, intent-required Tool selection and nickname moderation. Nine qq-live observer and reply files passed 98 tests. These tests do not measure real-model latency.
- Issue #155's candidate observer now uses the wrapped status/data success envelope and verifies the complete Tool output. Its mismatch and group-files companion tests pass, but fresh live QQ evidence remains required.
- Measure selected Tool count, serialized schema size and model request duration from a fresh natural-language Run before changing discovery architecture. No current evidence attributes the reported delay to Tool count.

## 2026-10-13 Post-scan status checkpoint

- The user reported that the Bot QR confirmation was complete. The 6100 account marker and WebUI auto-login account both identify Bot 3394947361. The Bot container is running with the migrated data layout and the pinned PR #2099 image.
- A fresh `qq-chat status` still reports Owner 3526039967 online and Bot 3394947361 offline with WS_NOT_READY. Port 6701 is not listening. No live test message was sent in this checkpoint.
- The PR #142 candidate passed `npm run verify:full`; `git diff --check` passed. PR #142 remains open and draft at the candidate head. PR #140 remains open with conflicts. Real QQ acceptance remains pending Bot OneBot readiness.

## 2026-10-13 Upstream logout and recovery evidence

- NapCat PR #2099 merged into upstream main on Oct 11. It corrects the Linux global-data path and migrates existing `nt_qq/global` data when the destination is absent. The Bot test image is built from the reviewed PR commit and has already migrated its existing account data. The Owner container still runs the older image and its existing path layout; it remains untouched while the account is online. See [NapCat PR #2099](https://github.com/NapNeko/NapCatQQ/pull/2099).
- NapCat issue #2079 documents two different accounts on one Docker host simultaneously requiring QR reauthorization despite separate persistent volumes and no shared account. The issue was closed after a maintainer identified risk control. This is evidence that QQ-side session revocation can happen outside Glassbox; it is not proof of the exact cause for our accounts. See [NapCat issue #2079](https://github.com/NapNeko/NapCatQQ/issues/2079).
- NapCat release notes for v4.18.32 describe recovery from silent offline state by restarting the Worker and trying quick login. This can recover some session failures, but an explicit QQ authorization revocation still needs phone confirmation. See [NapCat releases](https://github.com/NapNeko/NapCatQQ/releases).
- Local protection remains necessary: independent account directories, correct WebUI-to-account mapping, the Linux path migration, no duplicate Glassbox consumers, and identity-checked `qq-chat status`. No local measure can guarantee that QQ will never revoke an account session.

## 2026-10-13 Service status semantics

- The managed status command reported `onebotReady: true` solely because port 6700 accepted TCP. It did not inspect the Bot endpoint on 6701 or QQ identity. The candidate now returns `onebotListener` with the checked host, port, and listening boolean. Account identity and online checks remain in `qq-chat status`.
- Focused agent-service status tests passed 4/4. The candidate full verification passed after the code change. The running Glassbox remains on `/home/yanbingzhao/src/qq-self-role-surface`; development remains on PR #142 branch `codex/qq-live-followup-20261011`. No service switch or NapCat restart occurred.


## 2026-10-13 QR expiry and PR comparison checkpoint

- After the user reported that login was okay, a fresh read-only check still showed Owner 3526039967 online and Bot 3394947361 offline with `WS_NOT_READY`. NapCat WebUI 6098 is configured for Owner and 6100 for Bot. Bot OneBot is enabled for `127.0.0.1:6701`, but that port is not listening. No QQ message or group action was sent.
- Bot NapCat logs repeat `ErrType 1 ErrCode 3` about every two minutes and issue a replacement QR. NapCat's current framework source maps this pair to an expired QR. This proves the login attempt is expiring, not why QQ or the client fails to complete it. Do not copy QR URLs from logs; inspect only redacted status summaries. See [NapCat login handler](https://github.com/NapNeko/NapCatQQ/blob/main/packages/napcat-framework/napcat.ts).
- `qq-chat --help` exposes the generic `up`, `status`, `send`, `read`, `trace`, and `down` interface. It has no feature registry, expected-tool assertion, automatic retry, automatic PASS, or merge action. Real acceptance remains blocked until Bot 3394947361 is online through 6701.
- PR #142 at `f53b26767ff4389bcfa9f9b44c3fcc781b534c1f` is a draft with 59 commits, 423 changed files, 125421 additions, and 1396 deletions against main at `3966c3be88ef7f041f2a7c134a1866844cfd34f8`. Local full verification passed before this checkpoint; GitHub checks passed except dependency review, which was still pending at the last poll. Review this scope before merge.
- PR #140 is still open and conflicting. It has 27 changed files and references Issues #109, #110, #111, #112, and #117, all still open. Its head is not an ancestor of PR #142; 17 of its changed files have different final contents between the two branches. PR #140 retries deliveries after `timeout`, `disconnected`, and `send_error` outcomes. Those outcomes may mean QQ already accepted the first send, so importing that retry can duplicate a message. Keep it out; compare and port only safe, still-missing changes after PR #142 acceptance.


## 2026-10-13 Session invalidation timeline

- Rechecked after the user said both accounts were logged in and may have been scanned in reverse. The live OneBot identity check still reports Owner 3526039967 online on 6700 and Bot 3394947361 offline; 6701 has no listener. The WebUI configuration maps 6098 to Owner and 6100 to Bot. Both accounts cannot be verified until Bot 6701 reconnects.
- The two NapCat bind mounts remain separate and both contain their account login database. Owner's account data is still under the legacy `nt_qq/global/nt_db/login.db` path. Bot's account data is under the migrated `global/nt_db/login.db` path. No login data was read, copied, or changed.
- Owner NapCat logged a QQ logout notice at 2026-10-12 21:31 local time, then restarted its Worker and tried quick login. The Docker container had started at 21:27 local time and has restart count 0. NapCat then received QR-expired results about every two minutes. This shows the later session loss happened inside a stable container after a QQ logout event; it does not establish why QQ invalidated the session. A prior quick-login cycle began around 20:45 local time before that container start.
- Bot NapCat has continued to receive QR-expired results about every two minutes through 2026-10-13 08:59 local time, with no confirmed login and no logout notice. The current evidence is consistent with an unfinished or rejected login flow, not proof that the account was scanned successfully.
- The active Glassbox service remains on the deployment checkout and has not been restarted or switched. The observer is running but reports the Bot offline. Do not send or retry QQ messages until both configured identities are confirmed by OneBot.
- The latest PR #142 head is `897cf9367f0fd7767b54dd54c72f62e37db0fc07`. It remains open and draft with 423 changed files. GitHub code/test and dependency-review checks were pending after the documentation push; the other reported checks passed. PR #140 remains open and conflicting. Do not merge either PR before real acceptance and the scope review recorded above.
