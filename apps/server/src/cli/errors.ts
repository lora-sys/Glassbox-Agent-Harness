const messages = {
  INVALID_ARGUMENTS: "Invalid command or options. Run glassbox --help.",
  INVALID_CONNECTION: "The management connection must use a loopback HTTP or HTTPS origin.",
  AUTH_REQUIRED: "The local management credential is missing or invalid.",
  FORBIDDEN: "The server denied this operation.",
  NOT_AVAILABLE: "This operation is not available on the connected server.",
  NOT_FOUND: "The requested record was not found.",
  CONFLICT: "The operation conflicts with the current server state.",
  INVALID_REQUEST: "The server rejected the request.",
  RATE_LIMITED: "The server is limiting requests. Try again later.",
  REQUEST_TOO_LARGE: "The management request exceeds the size limit.",
  RESPONSE_TOO_LARGE: "The management response exceeds the size limit.",
  INVALID_RESPONSE: "The server returned an invalid management response.",
  TIMEOUT: "The server did not respond before the deadline. The operation outcome may be unknown.",
  CONNECTION_FAILED: "Could not reach the configured local server. Check glassbox serve.",
  SERVER_ERROR: "The server could not complete the operation.",
  SECRET_REQUIRED: "Provide a nonempty API key through standard input.",
  SECRET_TOO_LARGE: "The API key exceeds the size limit.",
  SECRET_TIMEOUT: "Standard input did not finish before the deadline.",
  INPUT_REQUIRED: "请通过标准输入提供渠道 JSON。",
  INPUT_TOO_LARGE: "渠道 JSON 超过输入大小限制。",
  INPUT_TIMEOUT: "等待标准输入超时。",
  INVALID_INPUT: "渠道 JSON 不符合要求。运行 glassbox --help 查看字段。",
  INVALID_CONFIGURATION: "服务端拒绝了配置，请检查字段和所选执行方式。",
  CHANNEL_ACTIVE: "请先断开渠道，再修改它的配置。",
  START_FAILED: "The local server could not start.",
  INTERNAL_ERROR: "The command could not complete.",
} as const;

export type CliErrorCode = keyof typeof messages;

export class CliError extends Error {
  readonly code: CliErrorCode;

  constructor(code: CliErrorCode) {
    super(messages[code]);
    this.name = "CliError";
    this.code = code;
  }
}

/** Server messages can contain credentials or upstream payloads. Use local text. */
export function responseError(status: number, input: unknown): CliError {
  const error = isRecord(input) && isRecord(input.error) ? input.error : undefined;
  const code = error?.code;
  const allowedServerCodes = new Set([
    "AUTH_REQUIRED",
    "FORBIDDEN",
    "NOT_AVAILABLE",
    "NOT_FOUND",
    "CONFLICT",
    "INVALID_REQUEST",
    "RATE_LIMITED",
    "SERVER_ERROR",
    "INVALID_CONFIGURATION",
    "CHANNEL_ACTIVE",
  ]);
  if (typeof code === "string" && allowedServerCodes.has(code)) {
    return new CliError(code as CliErrorCode);
  }
  switch (status) {
    case 401:
      return new CliError("AUTH_REQUIRED");
    case 403:
      return new CliError("FORBIDDEN");
    case 404:
      return new CliError("NOT_AVAILABLE");
    case 409:
      return new CliError("CONFLICT");
    case 429:
      return new CliError("RATE_LIMITED");
    default:
      return new CliError(status >= 500 ? "SERVER_ERROR" : "INVALID_REQUEST");
  }
}

export function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}

export function hasControlCharacters(text: string): boolean {
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code < 32 || code === 127) return true;
  }
  return false;
}
