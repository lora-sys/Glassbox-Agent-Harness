const errorMessages = {
  UNAUTHORIZED: "管理密钥无效或已失效，请重新连接。",
  ACCESS_STORAGE: "浏览器无法保存或清除当前标签页的管理访问凭据，请检查会话存储设置。",
  FORBIDDEN: "服务器拒绝了这次管理操作。",
  NOT_AVAILABLE: "当前服务器尚未提供这项管理能力。",
  INVALID_CONFIGURATION: "服务器拒绝了配置。请检查字段，修改 API 来源时需要替换或清除密钥。",
  INVALID_RESPONSE: "服务器返回了无法识别的数据，请检查服务版本。",
  TOO_LARGE: "请求或响应超过了大小限制。",
  TIMEOUT: "请求超时。操作可能已到达服务器，请先刷新确认状态。",
  ABORTED: "请求已停止。",
  CONNECTION_FAILED: "无法连接本机服务，请确认服务器已启动后重试。",
  SERVICE_UNAVAILABLE: "本机服务暂时不可用，请确认服务器正在运行后刷新重试。",
  SERVER_ERROR: "服务器未能完成操作，请稍后重试。",
  INVALID_INPUT: "请检查表单中的必填字段和 API 地址。",
  INVALID_CHANNEL: "请检查渠道地址、机器人 QQ 号、Owner QQ 号、群号、执行方式和 token。",
  CHANNEL_ORIGIN: "修改 OneBot 服务来源时，需要替换或清除已保存的 token。",
  CHANNEL_ACTIVE: "渠道正在连接或已连接，请先断开，再保存配置。",
  RECORD_UNAVAILABLE: "这条执行记录不存在或当前不可访问，请返回列表刷新。",
  RUN_CHANGED: "执行状态或证据已变化，请刷新后再操作。",
  INVALID_RECORD_INPUT: "服务器无法处理这次记录请求，请刷新页面后重试。",
  INVALID_EXECUTOR: "请检查 Claude Code 的凭据来源、Anthropic 模型配置和模型名称。",
  EXECUTOR_BUSY: "本机执行器正在使用或检查中，请稍后刷新再操作。",
} as const;

export class ManagementApiError extends Error {
  readonly code: keyof typeof errorMessages;

  constructor(code: keyof typeof errorMessages) {
    super(errorMessages[code]);
    this.name = "ManagementApiError";
    this.code = code;
  }
}

export function failureMessage(error: unknown): string {
  return error instanceof ManagementApiError ? error.message : errorMessages.SERVER_ERROR;
}
