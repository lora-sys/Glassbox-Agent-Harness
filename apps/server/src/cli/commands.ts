// Command grouping and model-profile choices adapted from OpenHarness. See SOURCES.md.
import { parseArgs } from "node:util";
import { validCursor, type ManagementRequest } from "./client.ts";
import { CliError, hasControlCharacters } from "./errors.ts";

const protocols = ["openai-completions", "openai-responses", "anthropic-messages"] as const;
type ModelProtocol = (typeof protocols)[number];
export interface ModelSaveBody {
  id: string;
  label: string;
  protocol: ModelProtocol;
  baseUrl: string;
  model: string;
  apiKey?: string | null;
}
export type ParsedCommand =
  | { kind: "help"; json: boolean }
  | { kind: "serve"; json: boolean }
  | {
      kind: "request";
      json: boolean;
      request: ManagementRequest;
      input: "none" | "api-key" | "channel-json" | "executor-json";
    };

export const CLI_HELP = `Glassbox 本机管理

用法: glassbox <命令> [选项]

  serve                       启动本机服务
  status                      查看服务和实际可用能力
  doctor                      检查本机执行器
  executors list              查看共享的本机执行器配置和检查状态
  executors save              从标准输入读取并保存执行器 JSON
  executors check claude-code  调用模型检查隔离执行，可能产生费用
  models list                 列出已保存的模型配置
  models set <id>              保存模型配置
  channels list               列出渠道配置和当前连接状态
  channels save               从标准输入读取并保存渠道 JSON
  channels connect <id>       连接指定渠道，并保存重启后自动连接的设置
  channels disconnect <id>    断开指定渠道，并关闭自动连接
  capabilities probe <渠道> <群号>
                              真实调用该群的只读 QQ 能力并记录结果，不会修改群
  conversations list         列出持久会话，可用 --cursor 翻页
  runs list                   列出任务，可用 --cursor 翻页
  runs show <id>               查看任务
  runs cancel <id>             请求取消，显示服务端实际状态
  trace show <run-id>          查看任务 Trace，可用 --cursor 翻页
  runs trace <run-id>          trace show 的兼容命令
  eval run <run-id>            执行该任务的 run-integrity-v1 固定验收
  eval list <run-id>           列出该任务的 Eval 结果，可用 --cursor 翻页

模型选项:
  --label <名称> --protocol <协议> --base-url <地址> --model <模型>
  --api-key-stdin              从标准输入读取 API key
  --clear-api-key              删除已保存的 API key
  不带这两个 key 选项时保留原值。
  协议: ${protocols.join(", ")}

渠道 JSON 字段:
  id、label、kind、endpoint、botId、ownerId、coOwnerId、groupIds、executionRef、token
  kind 为 qq-onebot。QQ 号和群号使用字符串。endpoint 使用本机 ws 或 wss 地址。
  executionRef 为 claude-code、codex 或 model:<模型配置 ID>。
  token 字段省略时保留原值，null 删除原值，字符串替换原值。
  保存不会建立连接。token 只通过标准输入提交，不支持命令行 token 参数。

通用选项:
  --json                      输出结构化 JSON
  --help, -h                  显示帮助，不连接服务
  --cursor <nextCursor>       将上次结果的 nextCursor 原样用于下一页
  --run-id <id>               Eval 命令可用此选项代替位置参数

CLI 和 WebUI 共用服务端配置。尚未接通的功能返回 NOT_AVAILABLE。
runs retry <id> 保留兼容入口，当前服务尚未接通重试。
成功提交取消或 Eval 请求不代表底层执行已经结束，以返回状态为准。
`;

function identifier(value: string | undefined, kind: "run" | "channel" | "group"): string {
  const pattern =
    kind === "channel"
      ? /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/u
      : kind === "group"
        ? /^[1-9]\d{0,15}$/u
        : /^[A-Za-z0-9][A-Za-z0-9-]{0,159}$/u;
  if (!value || !pattern.test(value)) throw new CliError("INVALID_ARGUMENTS");
  return value;
}
function requiredText(value: string | undefined, maximum: number): string {
  if (!value?.trim() || value.length > maximum || hasControlCharacters(value))
    throw new CliError("INVALID_ARGUMENTS");
  return value.trim();
}
function modelEndpoint(value: string | undefined): string {
  const input = requiredText(value, 2048);
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new CliError("INVALID_ARGUMENTS");
  }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (
    (url.protocol !== "https:" && !(url.protocol === "http:" && local)) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new CliError("INVALID_ARGUMENTS");
  return input;
}
export function parseCommand(args: readonly string[]): ParsedCommand {
  try {
    const parsed = parseArgs({
      args: [...args],
      strict: true,
      allowPositionals: true,
      tokens: true,
      options: {
        json: { type: "boolean" },
        help: { type: "boolean", short: "h" },
        label: { type: "string" },
        protocol: { type: "string" },
        "base-url": { type: "string" },
        model: { type: "string" },
        "api-key-stdin": { type: "boolean" },
        "clear-api-key": { type: "boolean" },
        cursor: { type: "string" },
        "run-id": { type: "string" },
      },
    });
    const seen = new Set<string>();
    for (const token of parsed.tokens) {
      if (token.kind !== "option") continue;
      if (seen.has(token.name)) throw new CliError("INVALID_ARGUMENTS");
      seen.add(token.name);
    }
    const { values, positionals } = parsed;
    const json = values.json ?? false;
    if (values.help || (positionals.length === 0 && seen.size === Number(json)))
      return { kind: "help", json };
    const only = (...options: string[]) => {
      if ([...seen].some((option) => option !== "json" && !options.includes(option)))
        throw new CliError("INVALID_ARGUMENTS");
    };
    const request = (
      method: "GET" | "POST",
      path: string,
      body?: unknown,
      input: "none" | "api-key" | "channel-json" | "executor-json" = "none",
    ): ParsedCommand => ({
      kind: "request",
      json,
      input,
      request: { method, path, ...(body === undefined ? {} : { body }) },
    });
    const page = (path: string): ParsedCommand => {
      only("cursor", ...(positionals[0] === "eval" ? ["run-id"] : []));
      if (values.cursor !== undefined && !validCursor(values.cursor))
        throw new CliError("INVALID_ARGUMENTS");
      return {
        kind: "request",
        json,
        input: "none",
        request: {
          method: "GET",
          path,
          ...(values.cursor === undefined ? {} : { query: { cursor: values.cursor } }),
        },
      };
    };
    const command = positionals.join(" ");
    if (command === "serve") {
      only();
      return { kind: "serve", json };
    }
    const simple = new Map([
      ["status", "/manage/status"],
      ["doctor", "/manage/doctor"],
      ["models list", "/manage/models"],
      ["channels list", "/manage/channels"],
      ["executors list", "/manage/executors"],
    ]);
    const path = simple.get(command);
    if (path) {
      only();
      return request("GET", path);
    }
    if (command === "conversations list") return page("/manage/conversations");
    if (command === "runs list") return page("/manage/runs");
    if (command === "channels save") {
      only();
      return request("POST", "/manage/channels", undefined, "channel-json");
    }
    if (command === "executors save") {
      only();
      return request("POST", "/manage/executors", undefined, "executor-json");
    }
    if (command === "executors check claude-code") {
      only();
      return request("POST", "/manage/executors/claude-code/check", {});
    }
    if (
      positionals[0] === "channels" &&
      positionals.length === 3 &&
      ["connect", "disconnect"].includes(positionals[1]!)
    ) {
      only();
      return request(
        "POST",
        `/manage/channels/${identifier(positionals[2], "channel")}/${positionals[1]}`,
        {},
      );
    }
    if (positionals[0] === "models" && positionals[1] === "set" && positionals.length === 3) {
      only("label", "protocol", "base-url", "model", "api-key-stdin", "clear-api-key");
      const profileId = requiredText(positionals[2], 80);
      if (
        !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/u.test(profileId) ||
        (values["api-key-stdin"] && values["clear-api-key"])
      )
        throw new CliError("INVALID_ARGUMENTS");
      if (!protocols.some((protocol) => protocol === values.protocol))
        throw new CliError("INVALID_ARGUMENTS");
      const body: ModelSaveBody = {
        id: profileId,
        label: requiredText(values.label, 120),
        protocol: values.protocol as ModelProtocol,
        baseUrl: modelEndpoint(values["base-url"]),
        model: requiredText(values.model, 256),
        ...(values["clear-api-key"] ? { apiKey: null } : {}),
      };
      return request("POST", "/manage/models", body, values["api-key-stdin"] ? "api-key" : "none");
    }
    if (
      positionals[0] === "capabilities" &&
      positionals[1] === "probe" &&
      positionals.length === 4
    ) {
      only();
      return request("POST", "/manage/capabilities/probe", {
        channelId: identifier(positionals[2], "channel"),
        // The dedicated acceptance group, named explicitly. There is no default: a probe that
        // picked a group for the operator could call one that was never meant to be touched.
        groupId: identifier(positionals[3], "group"),
      });
    }
    if (
      positionals.length === 3 &&
      ((positionals[0] === "trace" && positionals[1] === "show") ||
        (positionals[0] === "runs" && positionals[1] === "trace"))
    )
      return page(`/manage/runs/${identifier(positionals[2], "run")}/trace`);
    if (positionals[0] === "runs" && positionals.length === 3) {
      only();
      const runId = identifier(positionals[2], "run");
      const action = positionals[1];
      if (action === "show") return request("GET", `/manage/runs/${runId}`);
      if (action === "cancel" || action === "retry")
        return request("POST", `/manage/runs/${runId}/${action}`, {});
    }
    if (
      positionals[0] === "eval" &&
      ["run", "list"].includes(positionals[1] ?? "") &&
      positionals.length <= 3
    ) {
      only("run-id", ...(positionals[1] === "list" ? ["cursor"] : []));
      if (values["run-id"] !== undefined && positionals[2] !== undefined)
        throw new CliError("INVALID_ARGUMENTS");
      const runId = identifier(values["run-id"] ?? positionals[2], "run");
      const path = `/manage/runs/${runId}/evals`;
      return positionals[1] === "list"
        ? page(path)
        : request("POST", path, { suiteId: "run-integrity-v1" });
    }
    throw new CliError("INVALID_ARGUMENTS");
  } catch (error) {
    // parseArgs errors can echo a mistyped secret argument.
    if (error instanceof CliError) throw error;
    throw new CliError("INVALID_ARGUMENTS");
  }
}
