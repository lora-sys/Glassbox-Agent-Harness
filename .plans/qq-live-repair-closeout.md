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
