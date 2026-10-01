import type { ExecutionFailureCode } from "../../execution/run-service/types.js";

export type PiRuntimeFailureCategory =
  | "authentication"
  | "permission"
  | "rate_limit"
  | "quota"
  | "context_limit"
  | "request_rejected"
  | "timeout"
  | "connection"
  | "server"
  | "unknown";

/** Assigned by Glassbox's execution branches, never read from provider error fields. */
export type PiFailureDiagnostic =
  | {
      origin: "runtime_reported";
      category: PiRuntimeFailureCategory;
      httpStatus?: number;
    }
  | {
      origin: "glassbox";
      category:
        | "source_authorization"
        | "context_budget"
        | "trace_write"
        | "runtime_exception"
        | "model_capability";
    };

const MAX_ERROR_CHARS = 8_192;
const categoryByCode: Readonly<Record<string, PiRuntimeFailureCategory>> = {
  invalid_api_key: "authentication",
  authentication_error: "authentication",
  permission_denied: "permission",
  permission_error: "permission",
  rate_limit_exceeded: "rate_limit",
  rate_limit_error: "rate_limit",
  insufficient_quota: "quota",
  context_length_exceeded: "context_limit",
  invalid_request_error: "request_rejected",
  ETIMEDOUT: "timeout",
  ECONNABORTED: "timeout",
  ECONNREFUSED: "connection",
  ECONNRESET: "connection",
  ENOTFOUND: "connection",
  EAI_AGAIN: "connection",
  server_error: "server",
  overloaded_error: "server",
};

function categoryForStatus(status: number): PiRuntimeFailureCategory {
  if (status === 401) return "authentication";
  if (status === 403) return "permission";
  if (status === 408 || status === 504) return "timeout";
  if (status === 429) return "rate_limit";
  return status >= 500 ? "server" : "request_rejected";
}

function httpStatus(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 400 && value <= 599
    ? value
    : undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * Classify bounded SDK error text without recording any of it. A category means the runtime
 * reported that condition; it is not an independently verified provider root cause.
 */
export function classifyPiRuntimeFailure(error: unknown): PiFailureDiagnostic {
  const unknown: PiFailureDiagnostic = { origin: "runtime_reported", category: "unknown" };
  if (typeof error !== "string" || error.length > MAX_ERROR_CHARS) return unknown;
  const text = error.trim();
  if (!text) return unknown;
  if (Object.hasOwn(categoryByCode, text))
    return { origin: "runtime_reported", category: categoryByCode[text]! };

  // Pi 0.85.1 formats HTTP errors as "<status>: <body>" or preserves SDK messages.
  // Require an explicit HTTP prefix or the SDK's anchored status syntax, not incidental digits.
  const match =
    /^HTTP(?:\/\d(?:\.\d)?)?[\t ]+([45]\d{2})(?=$|[\s:])/u.exec(text) ??
    /^([45]\d{2})(?=:\s| status code(?:\s|$))/u.exec(text);
  if (match) {
    const status = Number(match[1]);
    return { origin: "runtime_reported", category: categoryForStatus(status), httpStatus: status };
  }

  if (!text.startsWith("{")) return unknown;
  try {
    const parsed = record(JSON.parse(text));
    if (!parsed) return unknown;
    const nested = record(parsed.error);
    const statuses = [parsed.status, parsed.statusCode, nested?.status, nested?.statusCode].filter(
      (value) => value !== undefined,
    );
    // Ambiguous or invalid metadata must not become a confident diagnosis.
    if (statuses.length > 0) {
      const status = httpStatus(statuses[0]);
      if (status === undefined || statuses.some((value) => value !== status)) return unknown;
      return {
        origin: "runtime_reported",
        category: categoryForStatus(status),
        httpStatus: status,
      };
    }
    const codes = [parsed.code, parsed.type, nested?.code, nested?.type].filter(
      (value): value is string => typeof value === "string" && Object.hasOwn(categoryByCode, value),
    );
    if (codes.length > 0) {
      const category = categoryByCode[codes[0]!]!;
      if (codes.some((code) => categoryByCode[code] !== category)) return unknown;
      return { origin: "runtime_reported", category };
    }
  } catch {
    // Malformed or non-JSON error text stays unknown; do not search its body for keywords.
  }
  return unknown;
}

export function piFailureCode(failure: PiFailureDiagnostic): ExecutionFailureCode {
  if (failure.origin === "runtime_reported") return "runtime_run_errored";
  return failure.category === "source_authorization" ? "gate_refused" : "runtime_internal_error";
}

const runtimeReplies: Record<PiRuntimeFailureCategory, string> = {
  authentication: "运行时报告模型请求认证失败。请联系管理员检查模型凭据配置。",
  permission: "运行时报告模型请求被拒绝访问。请联系管理员检查模型访问权限。",
  rate_limit: "运行时报告模型请求触发限流。请稍后重试。",
  quota: "运行时报告模型请求额度不足。请联系管理员检查服务额度。",
  context_limit: "运行时报告模型请求超出上下文限制。可以缩小问题范围后重试。",
  request_rejected: "运行时报告模型请求被拒绝。请联系管理员检查本次请求与模型配置。",
  timeout: "运行时报告模型请求超时。请稍后重试。",
  connection: "运行时报告模型连接失败。请联系管理员检查模型连接配置。",
  server: "运行时报告模型服务出错。请稍后重试。",
  unknown: "运行时报告请求出错，但没有可识别的错误类别。请查看本次执行记录。",
};

export function piFailureReply(failure: PiFailureDiagnostic): string {
  if (failure.origin === "runtime_reported") return runtimeReplies[failure.category];
  switch (failure.category) {
    case "source_authorization":
      return "来源授权已变化，已停止继续请求模型。";
    case "context_budget":
      return "本次执行触发了内部上下文预算限制，已停止继续请求模型。";
    case "trace_write":
      return "本次执行记录保存失败，因此无法提供本次结果。请联系管理员检查执行记录。";
    case "model_capability":
      return "当前配置的模型不支持这次输入，因此没有发送请求。";
    case "runtime_exception":
      return "本次执行在本地运行时出错，尚未确认是否由模型服务引起。请查看本次执行记录。";
  }
}
