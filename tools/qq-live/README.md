# QQ 实机开发工具

开发 Agent 用真实 QQ 发消息、收回复、查看 Glassbox 的执行过程。新增业务功能不需要向测试器登记工具、编写专用 schema 或增加验证器。

默认入口是 `chat.mjs`。它不调用模型，不实现群管理等业务，不判断功能 PASS，不修改 Pi 配置。消息按普通 Owner 私聊或群聊进入 Glassbox，使用产品现有的身份、权限、上下文和工具。

## 日常使用

本机已配置时，可以直接使用 `qq-chat`。从仓库使用等价命令 `npm run qq:chat --`。

```sh
qq-chat up
qq-chat status
qq-chat send --chat private --text '帮我看看现在有哪些任务' --wait 60
qq-chat send --chat B --text '你在这个群里是管理员吗？帮我查一下' --wait 60
qq-chat read --after 0 --limit 100
qq-chat trace --request <requestId>
qq-chat trace --run <runId> --after 0 --limit 200
```

`send` 返回稳定的 requestId。每个 requestId 最多尝试发送一次。同一个 requestId 重复调用只读取已有记录。发送失败或超时后，先用原 requestId 查过程，不自动重发。新一轮测试才使用新的 requestId。

群聊默认 @ Bot。`--no-at` 可测试没有 @ 的群消息。`--message-file /absolute/request.txt` 可发送多行消息。消息没有额外测试标记，也不要求 Bot 按固定格式回复。

`read` 返回实际观察到的消息和 cursor。下次传入这个 cursor 接着读取，可加 `--wait 30` 等待新消息。观察器持续运行，send 返回后到达的文字、图片、视频仍会保存。`down` 只关闭观察器，不关闭 Glassbox、NapCat 或 QQ 登录。

`trace` 用实际 QQ 消息的账号内编号、原生序号和会话定位 Run，返回运行状态、工具调用、授权和投递事件。它也显示失败的 Run。`receivedByOwner` 只有在 Owner 端确实观察到对应回复时才为 true。没有 Run、没有回执或证据不唯一时，保留 pending 或 ambiguous 状态。

`--wait` 是本次观察时间，不是功能完成承诺。异步任务和晚到的媒体继续用 read 和 trace 查看。工具不把端口就绪、发送成功、Run 成功或 Bot 自称成功自动当成功能通过。

## 首次配置

需要 Node.js 24.12 或更新版本、已经登录的两套独立 NapCat 正向 WebSocket，以及现有的 Glassbox 服务。Linux 本地配置放在 `~/.config/glassbox/qq-chat.json`。

参考 [chat.config.example.json](examples/chat.config.example.json)。指定 Owner、Bot、允许的测试群、现有 Glassbox checkout 和数据目录。Token 可通过环境变量提供，也可用 onebotConfigPath 指向本机已有 NapCat 配置。工具只读取凭证，不复制或输出它。

观察器使用权限为 0600 的本地 Unix socket。事件日志在 stateDirectory，文件权限为 0600。只接收指定两个账号在允许会话内的消息，不收集其他群成员的对话。不要提交本地配置和消息日志。

工具通过现有服务管理器记录实际运行 checkout、提交、源代码摘要和 PID。切换开发版本仍使用项目已有的 agent:switch，只切 Glassbox。测试工具和部署进程可以位于不同 checkout，不需要为每个分支复制 QQ 登录或产品数据。

## 开发 Agent 的流程

1. 用 status 确认两套 QQ 在线，并核对运行中的业务版本。
2. 以真实用户说法发送请求，记住 requestId。
3. 用 read 看实际回复，用 trace 看意图、上下文、授权、工具结果和投递过程。
4. 一轮测多个相关情形，先收集问题，再根据证据修改业务代码。
5. 切换到修复版本后，用相同自然语言再测。按仓库要求完成本地测试和 PR 验证。

这个环境的完成标准是私聊、群聊、持续收取、Run 关联和过程查看可用。各业务功能的验收属于对应开发任务。修改群设置、禁言、记忆或任务等真实状态时，开发 Agent 负责遵守用户给定范围并恢复测试改动。聊天工具不会替它创建业务权限。

QQ 离线时观察器保持运行，read 和 trace 仍可查看已有记录。它只重连 WebSocket，不重启 QQ、不重放消息。QQ 明确要求手机重新授权时，需要账号持有人确认登录。停机或断连期间没有观察到的消息不会被补记成已收到。

## 可选专项回归

旧 `cli.mjs` 固定套件及报告保留，用于需要严格固定断言的专项回归。说明在 [REGRESSION.md](REGRESSION.md) 和 [REGRESSION-HANDOFF.md](REGRESSION-HANDOFF.md)。这些套件的覆盖缺口不阻止使用通用聊天入口，也不是新增功能的接入条件。

## 检查工具自身

```sh
node --test tools/qq-live/test/chat-session.test.mjs
```

测试使用隔离目录和假传输，覆盖会话范围、重复发送、结果未知、重启续读、晚到媒体、实际消息到 Run 的绑定和本地接口。真实收发证据另行记录，不用这些测试冒充实机通过。

最近一次真实运行的结果和未解决项见 [验证记录](VERIFICATION.md)。
