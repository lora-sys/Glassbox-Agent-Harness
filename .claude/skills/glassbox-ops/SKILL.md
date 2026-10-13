---
name: glassbox-ops
description: Glassbox 项目的环境启动、服务管理与 trace 调试手册。只要任务涉及把 Glassbox 跑起来或让它跑起来（agent:up / 服务状态 / 日志 / 重启 / 切 checkout / 服务起不来 / agent:up 报错）、定位一次出错的 QQ 对话或 run、查 Raw Trace 溯源（routing / tool / delivery / session 事件）、排查投递被拦、工具失败、runtime 不可用、run failed、trace 损坏，或需要跑 verify:commit / verify:full 门禁，就必须先读这个 skill。它提供确定性命令表和 gbxtrace 调试 CLI，杜绝每次临时写脚本解析 trace.jsonl。触发词：跑项目、起服务、起环境、起不来、trace、查 trace、溯源、定位问题、调试、run 失败、投递被拦、QQ 没回复、agent:logs、agent:status、gbxtrace、runs failed。
---

# Glassbox 运行与调试

这个 skill 固定服务管理和 Raw Trace 排查步骤。Trace 查询使用本 skill 附带的 `gbxtrace` CLI。事件字段以当前仓库的读取器和参考文档为准，不依赖历史机器上的 run 数量。

## 开始前必读

改代码前按仓库既有顺序阅读：`AGENTS.md` → 当前 active Plan（`.plans/` 下）→ 对应 `docs/*.md`。本 skill 不替代这些文件，它只回答"环境怎么起、问题怎么查"。

## 一、环境认知（关键事实）

| 事实           | 值                                                                                                                       |
| :------------- | :----------------------------------------------------------------------------------------------------------------------- |
| 技术栈         | Node >= 24.12.0、npm 12.0.2 工作区、Vite+（入口命令 `vp`）                                                               |
| 服务管理       | `npm run agent:up / agent:status / agent:logs / agent:down / agent:switch`（Windows 下长驻服务不要用 `vp run agent:up`） |
| 管理 CLI       | `npm run glassbox -- <命令>`（status / doctor / runs / trace show / eval …）                                             |
| Raw Trace 位置 | `<数据目录>/runs/<runId>/trace.jsonl`（数据目录由 `GLASSBOX_DATA_DIR` 指定，未设置时为 `~/.glassbox`）                   |
| 服务日志       | `<数据目录>/service.log`（混有二进制/ANSI 字节，用 `grep -a`；先从 `agent:status` 或启动配置确认数据目录）               |
| 提交门禁       | `vp run verify:commit`（每次 commit 前，禁止 `--no-verify`）；PR 前 `vp run verify:full`                                 |
| 起环境最短路径 | `vp install` → `npm run agent:up` → `npm run agent:status`（共享库版本由启动器与目标 checkout 动态比较）                 |

`agent:up` 根据数据目录中的 `service-launch.json` 启动缺少的 Glassbox 服务，以及其中明确配置的 Herdr 或 NapCat。它不拉代码、不切分支、不装依赖。`agent:switch` 只重启 Glassbox，不重启或重建 NapCat。QQ、NapCat、模型凭据不进 `.env`，走管理界面或 CLI 保存。

**每次操作前读取动态环境事实**：

- 运行 `npm run agent:status` 确认 Glassbox 进程、PID、checkout、启动 commit、源码是否干净，以及 `checkoutSourceVerified`。Linux 上状态还会核对可执行文件、完整参数、boot ID 和 PID 启动时间。PID 存活本身不足以证明它是当前服务。
- 运行 `gbx env` 确认数据目录和端口。端口从当前 `service-launch.json` 的 `glassbox.env.PORT` 或 `PORT` 环境变量读取；不能假设为 3030 或其他固定端口。管理 CLI 使用自定义端口时，显式传入 `PORT=<端口>`。
- `agent:switch -- --checkout <绝对路径>` 只切换 Glassbox。NapCat、Herdr、QQ 登录和 OneBot 配置保持运行。切换前会检查目标代码支持的 schema，再停止 Glassbox；目标版本低于共享库时拒绝切换。检查连接使用只读 SQLite，busy timeout 为 5000 毫秒。短暂写锁会等待释放，持续锁定或查询错误仍会失败关闭。
- schema 版本每次从目标 checkout 的 `apps/server/src/persistence/schema.ts` 中读取 `CURRENT_SCHEMA_VERSION`，从共享数据库读取 `PRAGMA user_version`。先确认数据目录，再比较当前值；不要把某次机器上的 schema 或分支状态当成默认值，也不要为绕过拒绝而改写数据库版本。
- 一次状态核验样例：2026-10-08，Glassbox PID 592317，数据目录 `/home/yanbingzhao/.glassbox`，端口 43031，共享 schema v29。这只是当时的快照，不是默认配置。
  只有当前账号状态明确报告 `online: false`，qq-live 将明确且无否定或矛盾的原生登录失效提示严格分类为 `ACCOUNT_REAUTH_REQUIRED`，或已认证的 NapCat WebUI 同时显示 `isLogin: false`、`loginPhase: waiting_qrcode`、`coreReady: false` 且没有 OneBot listener 时，才可请用户确认是否用手机登录。最后一种状态只证明当前未登录并等待二维码确认，不证明登录授权已过期。请求超时、端口状态或单独的 `-10003` 都不足以请求登录。不要自动重建 NapCat 数据、删除登录状态或重启以刷新二维码。登录操作由用户在本地 NapCat WebUI 完成。

一次条件化诊断示例：Bot 的 OneBot 状态为 offline，WebUI 的 CheckLoginStatus 同时报告 isOffline=true。刷新二维码后，原生 onUserLoggedIn 仍提示当前账号已登录，无法重复登录。这确认了原生登录状态冲突，不是单纯的界面状态。用户明确授权修复后，只调用 Bot WebUI 的原生 RestartNapCat 工作进程入口。该操作保留容器、账号目录和设备配置；没有删除或重建状态。重启后 WebUI 报告 isLogin=false、isOffline=false、loginPhase=qrcode_scanned、coreReady=false，等待用户手机确认。生成二维码或扫码 accepted 都不代表 coreReady，也不代表真实消息收发通过。
只有在再次确认账号 offline、确认原生重复登录冲突，并取得用户明确授权后，才按这个精确入口修复。不要把此示例推广为 timeout、单独 -10003 或其他状态下的自动重启规则。

**跑任何调试前先确认环境**（服务是否在、数据目录对不对、有多少 run 可查）：

```bash
node .agents/skills/glassbox-ops/scripts/gbxtrace.mjs env
```

## 二、调试 CLI：gbxtrace

路径：`.agents/skills/glassbox-ops/scripts/gbxtrace.mjs`（零依赖，`node` 直接跑，只读，不碰服务、不写数据）。下文用 `gbx` 代指该脚本。

| 命令                                      | 用途                                                                                                                                                                                                                |
| :---------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `gbx env`                                 | 环境检查：数据目录、run 总数、最新 run、token 文件、服务端口可达性（端口按 `PORT` 环境变量 → `service-launch.json` 的 `glassbox.env.PORT` → 3030 的顺序解析）                                                       |
| `gbx runs [--limit N] [--status failed]`  | 列出最近 run：状态、起止、时长、事件数、conversation、principal                                                                                                                                                     |
| `gbx show [runId] [--full]`               | 单 run 时间线；省略 runId 看最新；`message_chunk` 默认折叠，`--full` 展开                                                                                                                                           |
| `gbx events <runId> --type T [--type T2]` | 按事件类型下钻原始事件（`--type` 可重复）                                                                                                                                                                           |
| `gbx grep <模式> [--last N] [--type T]`   | 跨最近 N 个 run 搜 trace 原文（默认 50）                                                                                                                                                                            |
| `gbx failures [--limit N]`                | 非成功 run（failed/interrupted/unknown）+ 错误证据摘要                                                                                                                                                              |
| `gbx delivery [--limit N]`                | 投递事件（changed / blocked / denied）汇总                                                                                                                                                                          |
| `gbx replay [runId] [--gap-ms N]`         | **入站→出站六段回放**：逐段报"有/没有证据"，并列出 >= 5s 的时间空洞。**排查任何一次出错的对话，第一个跑这个**                                                                                                       |
| `gbx ingress [--full]`                    | 群入站证据：哪些消息没变成 run、为什么（`not_addressed`/`empty_message`/`not_ready`/`invalid_message`/`acceptance_failed`…）。落在 `<dataDir>/ingress-diagnostics.jsonl`，**重启不丢**；没有 run 可用时这是唯一入口 |
| `gbx msg [runId]`                         | 这条 run 由哪条消息触发（`messageId`/`externalId`/`textBytes`/`textSha256`），并给出查正文的授权路径——正文按设计不在 trace 里                                                                                       |
| `gbx types`                               | 本地全部 run 的事件类型与终态分布（校准对 trace 的预期）                                                                                                                                                            |
| `gbx drift`                               | **文档漂移检测**：本地 trace 里出现、但 `references/trace-events.md` 没记录的事件类型，附样本 JSON                                                                                                                  |

所有命令支持 `--json`。`GLASSBOX_DATA_DIR` 与服务管理器一致，指定 Glassbox 数据根目录，CLI 从其 `runs/` 子目录读取 Trace。`--data-dir <path>` 保持原有契约，直接指定 runs 目录，例如 `--data-dir /home/yanbingzhao/.glassbox/runs`。显式目录或环境配置缺失时，不回退到另一套产品数据。没有显式配置时，依次检查用户目录和当前技能所属仓库的 `.glassbox/runs`。runId 支持不冲突的前缀。出错时退出码 2 并给出原因。

常用组合：

```bash
gbx replay                               # 最新 run 哪一段没有证据（先跑这个）
gbx replay <runId> --gap-ms 20000        # 把 >20s 的时间空洞也列出来
gbx runs --status failed --limit 5      # 最近哪些 run 挂了
gbx failures --limit 3                  # 挂掉的 run 附错误证据
gbx show <runId>                        # 完整时间线
gbx msg <runId>                         # 这条消息的入站元数据（正文去库里有授权地查）
gbx ingress                             # 群里"没反应"且没有 run：消息可能根本没进来
gbx events <runId> --type tool_result --type delivery_blocked
gbx grep "empty-rendered-output" --last 100
gbx show <runId> --json                 # 交给后续处理
```

## 三、定位问题的标准流程

按症状选入口，但顺序不变：**环境 → 找 run → 时间线 → 按证据下钻 → 交叉验证**。

1. **环境**：先看 `npm run agent:status` 和 `gbx env`。服务未运行时再用 `npm run agent:up`；要换 checkout 时使用 `npm run agent:switch -- --checkout <绝对路径>`。若版本检查拒绝目标，比较该 checkout 的 `CURRENT_SCHEMA_VERSION` 与共享库 `PRAGMA user_version`。若目标没有可读取的版本声明，检查选定 checkout 的 `schema.ts` 和服务管理器代码；不要改数据库版本绕过检查。数据目录不对时核对 `GLASSBOX_DATA_DIR`。
2. **找 run**：用户说"刚才那条消息不对"→ `gbx runs` 按时间对齐；说"挂了/没回复"→ `gbx runs --status failed` 或 `gbx failures`；完全不知道 → `gbx replay`（先看六段哪段空）再 `gbx show`。**那段时间连 run 都没有 → 跳过 run 直接 `gbx ingress`**。
3. **回放**：`gbx replay <runId>` 按"入站 → 路由 → 会话与 runtime → 模型回合 → 产出 → 投递"逐段报有没有证据，并列出时间空洞。空的那段就是排查起点。一个健康 run 的形状是：
   `message_received → run_queued → run_started → routing_decision → tool_evidence → context_budget → session_start → turn_start → (tool_call → tool_result)* → turn_end → runtime_usage → session_end → run_finished → delivery_changed(sending → sent)`。
   任何一环缺失、顺序错乱、或出现 `✗`/`!` 标记，就是嫌疑点。
4. **时间线**：`gbx show <runId>` 看完整序列（`message_chunk` 默认折叠，`--full` 展开）。
5. **下钻**：按事件类型取原始证据（`gbx events <runId> --type <类型>`），或全文搜索（`gbx grep`）。事件字段速查读 [references/trace-events.md](references/trace-events.md)。
6. **交叉验证**：Raw Trace 是磁盘证据，服务端 API 是授权投影。用 `npm run glassbox -- runs show <runId>` / `trace show <runId>` 核对服务视角；两者矛盾时以 trace 文件为准，并作为线索上报。症状 → 证据的映射手册在 [references/troubleshooting.md](references/troubleshooting.md)。

## 四、溯源心智模型

trace 里的 id 是一条链，定位问题时顺着链走：

```text
conversationId（持久会话，跨多个 run）
  └─ runId（一次具体执行，一个 trace.jsonl）
       └─ sessionId（运行时会话，一个 run 内可多个 session/turn）
            └─ turn（一问一答，tool_call/tool_result 挂在这里）
                 └─ deliveryId（结果投递，blocked/denied 发生在这里）
```

记住 AGENTS.md 的稳定区分：`Conversation ≠ Session ≠ Run`、`Task ≠ Run`。看到 `sessionId` 不要当成 conversation；看到 run failed 不要自动推断 Task 失败——Task 真相在服务端，trace 只是证据。

## 五、证据纪律

- Raw Trace 是 append-only 证据：**只读**。永远不要改写、拼接、修补 trace.jsonl 去"修好"一个现象；完整性告警（坏行、seq 断点）本身就是要排查的问题。
- CLI 输出可能含消息正文和 principal id。对外汇报时按 AGENTS.md 的要求脱敏：凭据、消息内容不进诊断摘要；需要精确到内容时在本地排查环境里看，不复制进跨环境传播的文本。
- `gbx` 只做读和展示。任何会改变状态的动作（取消 run、改配置、重启服务）用既有入口：`npm run glassbox -- runs cancel <id>`、`npm run agent:down/up`，并且那是用户的决定，先说明再执行。
- 排查结论要能回答：哪个 run、哪条事件、证据字段是什么、和哪条产品规则的哪一句话冲突。

## 六、维护这个 skill（它必须跟着项目长）

trace 的事件类型、字段、失败签名会随开发升级；工具面会增删；服务端口和启动方式也可能变。这个 skill 一旦过期，agent 就会退回临时写脚本的老路——那是它存在的意义被抵消的时刻。所以**使用这个 skill 的 agent 同时是它的维护者**。

什么时候必须更新（满足任一）：

1. `gbx drift` 报告了未记录的事件类型——trace schema 变了，立刻补。
2. 排查中发现文档和现实不符：字段名对不上、事件顺序和「健康 run 的形状」不一致、某个症状在 troubleshooting.md 里找不到或写法是错的。
3. 你打算为一个反复出现的排查需求写临时脚本——这说明 CLI 缺命令，把命令加进 `gbxtrace.mjs`，不要写脚本。
4. 环境事实变了：端口、数据目录、服务启动方式、门禁命令。
5. `gbx replay` 某一段长期报"没有证据"但你确认代码已经会发这个事件——说明事件没接上，那是产品缺陷，按第 134 行的规矩上报，不要在文档里写成"本该没有"。
6. `gbx ingress` 说"没有入站证据日志"但你确认服务早重启过——说明日志没落盘，同上，是产品缺陷。

怎么更新（小步、凭证据、可验证）：

- 新事件类型：先 `gbx events <runId> --type <类型> --full` 取真实样本，把字段名照抄进 `references/trace-events.md`（字段名从样本里来，不要凭印象编），并在 `gbxtrace.mjs` 的 `eventSummary` 里给它一行人类可读摘要。
- 新失败签名：写进 `references/troubleshooting.md` 对应症状节，证据字段精确到 `类型.字段`。
- 新 CLI 命令：加命令表一行 + USAGE 一段 + 分发一个 case；改完 `node --check` 并实跑一次确认。
- 更新后跑 `gbx drift` 确认没有新的未记录类型，再继续排查。

自我约束：更新只做小步事实修正，不借机重构 skill；拿不准的写法照旧保留并在汇报里指出，不要猜。发现的是**产品缺陷**（比如 trace 少记了该记的字段、事件没接上、入站日志没落盘）不要在这个 skill 里打补丁绕过——按 AGENTS.md 记入 active Plan 或 issue。

## 七、什么时候读哪个 reference

- 看到不认识的事件类型、或想知道某类事件有哪些字段 → [references/trace-events.md](references/trace-events.md)
- 有明确症状（QQ 没回复、回复被拦、工具报错、runtime 不可用、run failed、trace 损坏、验证门禁失败）→ [references/troubleshooting.md](references/troubleshooting.md)
