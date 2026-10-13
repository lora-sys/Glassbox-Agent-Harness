---
name: qq-live-testing
description: 用真实 QQ 私聊或群聊测试 Glassbox。发送自然语言，持续收取回复，并查看对应 Run、工具调用和投递过程。新增业务功能无需为测试器编写专用用例。
---

# QQ 实机开发

用这套环境为开发 Agent 提供收发消息和观察运行过程的入口。功能正确性由开发 Agent 根据需求和证据判断。不要为了新增功能先扩建测试器。

## 工具

在仓库执行 `npm run qq:chat -- <command>`。已安装本机入口时可直接用 `qq-chat`。

```sh
qq-chat status
qq-chat up
qq-chat send --chat private --text '帮我看看现在有哪些任务' --wait 60
qq-chat send --chat B --text '你在群里是管理员吗？帮我查一下' --wait 60
qq-chat read --after <cursor> --wait 30
qq-chat trace --request <requestId>
qq-chat trace --run <runId> --after <traceCursor> --limit 200
```

需要多行输入时用 `--message-file /absolute/message.txt`。群聊默认 @ Bot，`--no-at` 可测试普通群消息。不要添加特殊协议前缀、工具名、参数 schema 或固定回复格式来替模型完成意图识别。

send 每次返回 requestId；同一个 requestId 不会再次发送。超时不等于没有执行。先查原 requestId，确认真实状态之后才能决定下一步。

read 返回真实收到的文字和媒体消息以及 cursor。观察器在 send 返回后继续收取，所以稍后到达的图片、视频仍可查。观察器重启后日志和 cursor 保留；停机期间没有观察到的消息不能声称已经收到。

trace 把实际输入关联到 Run，展示模型和工具事件、授权结果、运行错误及投递。Run 成功与 Owner 真正收到回复分开报告。业务有问题时使用 [glassbox-ops](../glassbox-ops/SKILL.md) 的过程查看方法继续定位。按 debug 技能找根因，不修改预期去掩盖问题。

## 工作流程

先确认当前用户已经授权测试账号和群范围。已有授权继续有效，不要重复确认。读取仓库 AGENTS.md、当前需求和相关业务文档。

用 status 查看运行中的 Glassbox checkout、PID 和账号状态。服务切换依照 glassbox-ops，只切业务服务，不重建 NapCat 账号目录，不改 Pi 配置。环境和代码验证分别报告。

每次状态轮询都要读取 OneBot `get_login_info.user_id` 并与该角色配置的 QQ 号比较。`get_status.online` 只表示 OneBot 报告在线，历史 `connected` 事件只证明过去连过；二者都不能单独证明当前账号身份。

选几种真实说法，包括允许执行、明确不执行、含糊表达和上下文连续对话。先完成一轮并记录 requestId、Run、实际回复和发现，再统一改业务代码。新工具和新功能走同一套聊天入口，无需登记测试器白名单。

业务状态变更必须在用户授权的测试对象上进行。需要恢复时通过业务原有操作恢复并检查结果。聊天工具不增加产品权限，不代替开发 Agent 判断副作用。

按群昵称或群名片测试禁言时，使用真实群消息和完整名称，例如"把群里昵称叫 Brian 的成员禁言 30 秒"或"把群名片是「Ripped Space」的群友禁言 2 分钟"。记录原消息、Run、成员解析、禁言工具结果和实际回复。服务端只接受当前成员列表中的唯一精确匹配。重名或查不到时不要猜 QQ 号，也不要自动重发。短时禁言的接口成功只证明请求被接受，若需要证明成员实际被禁言，应在时限内独立读取状态。

修复后运行相关隔离测试，切到正确业务版本，再用相同自然语言回归。按仓库流程处理 Issue、PR 和 CI；聊天入口不自动给 PASS，也不自动合并。

账号确认应先核对 NapCat 保存的快速登录账号、容器启动账号和实例页面地址。开始扫码前，把目标 QQ 号和对应页面地址一并告知用户；只有页面当前选择的 QQ 号与目标号码一致时才扫码，不能只看昵称或页面是否能打开。用户确认扫码后，通过同一实例重新查询 get_login_info 和 get_status。只有账号号匹配且 online=true，才算登录完成。若页面提示 QQ Is Logined、选中账号不一致或 OneBot 未连接，停止扫码和重启操作，先核对实例映射、登录选择器和 NapCat 持久配置，不要删除或重建账号目录。

若两套曾扫反，按当前明确分工修正持久启动配置，再分别查询 get_login_info；不要重建账号目录或改设备信息。当前 WSL 验收实例的常见映射是 Owner WebUI 6098 对应 OneBot 6700，Bot WebUI 6100 对应 OneBot 6701。此映射只是提示，每次扫码前仍要核对实际配置和目标账号。

Linux Docker NapCat 的登录状态排查还要核对 QQ 数据根目录。NapCat 上游 PR #2099 于 2026-10-11 合并，修正 Linux global 路径，并在新目录不存在时迁移旧的 nt_qq/global。当前可用的是提交 c358c86 的临时 PR 测试镜像，镜像说明保留 120 小时；它只用于本机开发验收，不是稳定版或部署镜像。使用时固定摘要并保留原账号卷，不要手工移动、删除或合并目录。等待正式稳定镜像包含此修复后再用于部署。若登录库只存在于旧路径，不要手工移动、删除或合并目录；先确认实际镜像包含该迁移，且新目录不存在，再通过支持的启动迁移处理。官方发布说明和迁移实现见 https://github.com/NapNeko/NapCatQQ/pull/2099 。

同机双账号几乎同时要求重新扫码也有上游相似报告，维护者将其归为 QQ 风控，分开的持久卷不能保证平台不撤销会话。保留时间线、容器和账号目录，避免无必要地重复重启或扫码；不能承诺本地代码能阻止 QQ 服务端撤销授权。参考 https://github.com/NapNeko/NapCatQQ/issues/2079 。

NapCat 明确拒绝快速登录并切换到二维码时，保留同一个容器、配置和账号卷，只请账号持有人在对应页面确认当前账号。完成后重新查询 get_login_info 和 get_status；账号身份匹配且 online=true 之前，不发送测试消息。不要读取或转发原始二维码 URL、令牌或未经筛选的登录日志。

QQ 离线时继续使用 read 和 trace 调查，观察器会重新连接 WebSocket。不要把登录授权失效当成业务测试失败，不要循环重启 QQ。确认需要手机授权时再请账号持有人登录。

若两套 QQ 同时掉线，先保留容器和账号目录，记录各自的 `KickedOffLine` 时间、容器启动时间、代理进程状态和 Glassbox checkout。区分 QQ 发来的登录失效通知、NapCat 内部 Worker 重启、Docker 容器重启和 Glassbox 服务切换。WebUI 显示在线后还要用新消息核对实际收发。QQ 服务端撤销授权时，持久目录只能保留设备和会话资料，不能保证免扫码恢复；未找到具体触发因素时不要声称已经解决。


## Tool schema and latency checks

QQ capability Tools have fixed TypeBox schemas and runtime input validation. Required-evidence classification can narrow an already-authorized Tool surface when it recognizes a factual request. This is not lazy progressive discovery; ordinary messages retain the authorized surface. When investigating slow Tool use, collect the Run surface selection, schema size and model timing from real natural-language Runs before attributing latency to Tool count. Keep schema generation, model argument validation, lease admission, provider execution and evidence observation as separate failure stages.

## 配置和证据

配置默认在 `~/.config/glassbox/qq-chat.json`，细节见 [README](../../../../tools/qq-live/README.md)。Token 只留在环境变量或原 NapCat 配置。消息及 trace 属于本地私有调试证据，发 Issue 时只摘录必要且已脱敏的事实。

本工具的完成标准是指定账号的私聊、群聊、持续收取和 Run 过程查看可用。各业务功能的验收属于对应开发任务，不要求先实现全产品专项测试器。

旧固定验收套件仍可按 [专项回归说明](../../../../tools/qq-live/REGRESSION.md) 使用。它们不属于新增功能的必经入口。历史失败报告和未知发送记录必须保留，不能把它们改写为通过。
