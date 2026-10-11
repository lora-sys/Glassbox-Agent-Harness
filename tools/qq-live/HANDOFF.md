# 开发 Agent 接手

先阅读 README.md 和 `.agents/skills/qq-live-testing/SKILL.md`。

默认使用 `chat.mjs` 的 send、read、trace。新增业务功能直接发送自然语言测试，不需要修改测试器或维护功能白名单。查看实际 QQ 回复、对应 Run 和工具过程，再判断业务是否正确。

Owner、Bot、测试群、现有服务和持久数据目录由本地 qq-chat.json 提供。不要复制 Pi 配置、修改模型上限或切换 QQ 登录。切业务 checkout 用项目现有服务管理器，保持只有一个 Glassbox 消费者。

每轮先收集结果，再统一修复。发送结果未知时只检查原 requestId，不能自动重发。先区分收发问题、产品问题和观察问题。观察器仅提供证据，不给业务 PASS，不自动提交或合并。

旧固定套件说明保存在 REGRESSION-HANDOFF.md，属于可选专项回归。其专用 schema、清理流程和覆盖门槛不适用于普通 chat.mjs 会话，也不阻止新增功能测试。
