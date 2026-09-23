import {
  BrowserSessionRegistry,
  type BrowserSessionBinding,
  type BrowserSession,
} from "./browser-session.js";
import type { BrowserProxyHandle } from "./browser-proxy.js";
import { assertPublicWebUrl, type ResolveWebHost } from "./network-guard.js";

export type BrowserCapability = "browser.read" | "browser.interact";

export type BrowserAction =
  | { type: "open"; url: string }
  | { type: "close" }
  | { type: "goto"; url: string }
  | { type: "go_back" }
  | { type: "go_forward" }
  | { type: "reload" }
  | { type: "snapshot"; depth?: number }
  | { type: "find"; text: string }
  | { type: "tab_list" }
  | { type: "tab_new" }
  | { type: "tab_select"; index: number }
  | { type: "tab_close"; index: number }
  | { type: "console"; level?: "error" | "warning" | "info" | "debug" }
  | { type: "requests" }
  | { type: "request_body"; index: number }
  | { type: "request_headers"; index: number }
  | { type: "response_headers"; index: number }
  | { type: "wait"; condition: "selector" | "url"; value: string }
  | { type: "screenshot" }
  | { type: "download_observation" }
  | { type: "response_body"; index: number }
  | { type: "type"; text: string }
  | { type: "click"; ref: string }
  | { type: "fill"; ref: string; value: string }
  | { type: "press"; key: string }
  | { type: "select"; ref: string; value: string }
  | { type: "check"; ref: string }
  | { type: "uncheck"; ref: string }
  | { type: "hover"; ref: string };

export interface BrowserCliResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface BrowserCliExecutionContext {
  proxyServer: string;
}

export type BrowserCliRunner = (
  args: readonly string[],
  timeoutMs: number,
  context: BrowserCliExecutionContext,
) => Promise<BrowserCliResult>;
export type BrowserProxyFactory = () => BrowserProxyHandle;
export type BrowserAuthorizer = (
  binding: BrowserSessionBinding,
  capability: BrowserCapability,
  action: BrowserAction["type"],
) => Promise<boolean>;

export interface BrowserBridgeOptions {
  authorize: BrowserAuthorizer;
  runner: BrowserCliRunner;
  proxyFactory: BrowserProxyFactory;
  resolveHost?: ResolveWebHost;
  sessions?: BrowserSessionRegistry;
  timeoutMs?: number;
  maxOutputChars?: number;
}

export interface BrowserBridgeResult {
  output: string;
  truncated: boolean;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_OUTPUT_CHARS = 20_000;
const MAX_INPUT_CHARS = 8_000;

function validateBinding(binding: BrowserSessionBinding): void {
  if (
    ![binding.runId, binding.principalId, binding.conversationId].every(
      (value) => typeof value === "string" && value.length > 0,
    )
  )
    throw new Error("browser_invalid_binding");
}

function validateText(value: string, code: string): string {
  if (
    typeof value !== "string" ||
    value.length > MAX_INPUT_CHARS ||
    value.includes("\0") ||
    /^\s*--/u.test(value)
  )
    throw new Error(code);
  return value;
}

function validateRef(value: string): string {
  if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/u.test(value)) throw new Error("browser_invalid_ref");
  return value;
}

function validateKey(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/u.test(value)) throw new Error("browser_invalid_key");
  return value;
}

function validateIndex(value: number, code: string, maximum = 1_000): number {
  if (!Number.isInteger(value) || value < 0 || value > maximum) throw new Error(code);
  return value;
}

function actionArgs(action: BrowserAction): {
  capability: BrowserCapability;
  args: string[];
  url?: string;
} {
  switch (action.type) {
    case "open":
    case "goto":
      return {
        capability: "browser.read",
        args: [action.type, validateText(action.url, "browser_invalid_url")],
        url: action.url,
      };
    case "close":
      return { capability: "browser.interact", args: ["close"] };
    case "go_back":
      return { capability: "browser.read", args: ["go-back"] };
    case "go_forward":
      return { capability: "browser.read", args: ["go-forward"] };
    case "reload":
      return { capability: "browser.read", args: ["reload"] };
    case "snapshot": {
      const depth = action.depth ?? 8;
      if (!Number.isInteger(depth) || depth < 1 || depth > 20)
        throw new Error("browser_invalid_depth");
      return { capability: "browser.read", args: ["snapshot", `--depth=${depth}`] };
    }
    case "find":
      return {
        capability: "browser.read",
        args: ["find", validateText(action.text, "browser_invalid_text")],
      };
    case "tab_list":
      return { capability: "browser.read", args: ["tab-list"] };
    case "tab_new":
      return { capability: "browser.interact", args: ["tab-new"] };
    case "tab_select":
      return {
        capability: "browser.interact",
        args: ["tab-select", `${validateIndex(action.index, "browser_invalid_tab_index", 99)}`],
      };
    case "tab_close":
      return {
        capability: "browser.interact",
        args: ["tab-close", `${validateIndex(action.index, "browser_invalid_tab_index", 99)}`],
      };
    case "console":
      if (
        action.level !== undefined &&
        !["error", "warning", "info", "debug"].includes(action.level)
      )
        throw new Error("browser_invalid_console_level");
      return { capability: "browser.read", args: ["console", action.level ?? "info"] };
    case "requests":
      return { capability: "browser.read", args: ["requests"] };
    case "request_headers":
      return {
        capability: "browser.read",
        args: [
          "request-headers",
          `${validateIndex(action.index, "browser_invalid_request_index", 1_000)}`,
        ],
      };
    case "request_body":
      validateIndex(action.index, "browser_invalid_request_index", 1_000);
      throw new Error("browser_action_unsupported_file_output");
    case "response_headers":
      return {
        capability: "browser.read",
        args: [
          "response-headers",
          `${validateIndex(action.index, "browser_invalid_request_index", 1_000)}`,
        ],
      };
    case "wait":
      validateText(action.value, "browser_invalid_text");
      throw new Error("browser_action_unsupported_wait");
    case "screenshot":
      throw new Error("browser_action_unsupported_file_output");
    case "download_observation":
      throw new Error("browser_action_unsupported_download_observation");
    case "response_body":
      validateIndex(action.index, "browser_invalid_request_index", 1_000);
      throw new Error("browser_action_unsupported_file_output");
    case "type":
      return {
        capability: "browser.interact",
        args: ["type", validateText(action.text, "browser_invalid_text")],
      };
    case "click":
      return { capability: "browser.interact", args: ["click", validateRef(action.ref)] };
    case "fill":
      return {
        capability: "browser.interact",
        args: ["fill", validateRef(action.ref), validateText(action.value, "browser_invalid_text")],
      };
    case "press":
      return { capability: "browser.interact", args: ["press", validateKey(action.key)] };
    case "select":
      return {
        capability: "browser.interact",
        args: [
          "select",
          validateRef(action.ref),
          validateText(action.value, "browser_invalid_text"),
        ],
      };
    case "check":
    case "uncheck":
    case "hover":
      return { capability: "browser.interact", args: [action.type, validateRef(action.ref)] };
    default:
      throw new Error("browser_action_not_allowed");
  }
}

/**
 * The bridge accepts a caller-provided authorization decision on every action.
 * The isolated-container runner builds the CLI configuration with the supplied
 * mandatory proxy endpoint. Callers cannot provide CLI configuration.
 */
export class BrowserBridge {
  private readonly runner: BrowserCliRunner;
  private readonly sessions: BrowserSessionRegistry;
  private readonly proxyFactory: BrowserProxyFactory;
  private readonly sessionResources = new Map<
    string,
    { proxy: BrowserProxyHandle; proxyServer: string }
  >();

  constructor(private readonly options: BrowserBridgeOptions) {
    this.runner = options.runner;
    this.sessions = options.sessions ?? new BrowserSessionRegistry();
    this.proxyFactory = options.proxyFactory;
  }

  async execute(
    binding: BrowserSessionBinding,
    action: BrowserAction,
  ): Promise<BrowserBridgeResult> {
    validateBinding(binding);
    const command = actionArgs(action);
    if (!(await this.options.authorize(binding, command.capability, action.type)))
      throw new Error("browser_denied");
    if (command.url) {
      const publicUrl = await assertPublicWebUrl(command.url, this.options.resolveHost);
      command.args[command.args.length - 1] = publicUrl.href;
    }

    return this.sessions.exclusive(binding, async (session) => {
      if (action.type === "open") {
        if (session.opened) throw new Error("browser_session_already_open");
      } else if (action.type !== "goto" && !session.opened) {
        throw new Error("browser_session_not_open");
      } else if (action.type === "goto" && !session.opened) {
        throw new Error("browser_session_not_open");
      }
      let proxyServer: string | undefined;
      if (action.type === "open") {
        const resources = await this.createSessionResources(session);
        proxyServer = resources.proxyServer;
        // Mark the session as potentially live before launching the CLI. Cleanup
        // must still close it if the CLI returns an error after starting Chromium.
        session.opened = true;
      }
      const resources = this.sessionResources.get(session.cliSession);
      const result = await this.call(session, command.args, proxyServer ?? resources?.proxyServer);
      if (result.code !== 0) throw new Error("browser_cli_failed");
      await assertReportedPageUrlsSafe(
        result.stdout,
        this.options.resolveHost,
        action.type !== "close",
      );
      const output = bounded(
        result.stdout,
        this.options.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS,
      );
      if (action.type === "close") await this.closeSession(binding, session, true);
      return output;
    });
  }

  async cleanup(binding: BrowserSessionBinding): Promise<void> {
    validateBinding(binding);
    await this.sessions.exclusive(binding, async (session) => {
      await this.closeSession(binding, session, false);
    });
  }

  private async closeSession(
    binding: BrowserSessionBinding,
    session: BrowserSession,
    cliAlreadyClosed: boolean,
  ): Promise<void> {
    let failure: unknown;
    const resources = this.sessionResources.get(session.cliSession);
    try {
      if (session.opened && !cliAlreadyClosed) {
        if (!resources) throw new Error("browser_cleanup_state_missing");
        const result = await this.call(session, ["close"], resources.proxyServer);
        if (result.code !== 0) throw new Error("browser_cleanup_failed");
      }
    } catch (error) {
      failure = error;
    } finally {
      try {
        await resources?.proxy.close();
      } catch (error) {
        failure ??= error;
      } finally {
        this.sessionResources.delete(session.cliSession);
        session.opened = false;
        this.sessions.forget(binding);
      }
    }
    if (failure) throw failure;
  }

  private async createSessionResources(
    session: BrowserSession,
  ): Promise<{ proxy: BrowserProxyHandle; proxyServer: string }> {
    const proxy = this.proxyFactory();
    try {
      const proxyServer = await proxy.start();
      const resources = { proxy, proxyServer };
      this.sessionResources.set(session.cliSession, resources);
      return resources;
    } catch {
      await proxy.close().catch(() => undefined);
      throw new Error("browser_proxy_setup_failed");
    }
  }

  private call(
    session: BrowserSession,
    command: readonly string[],
    proxyServer?: string,
  ): Promise<BrowserCliResult> {
    if (!proxyServer) throw new Error("browser_proxy_unavailable");
    return this.runner(
      [`-s=${session.cliSession}`, ...command],
      this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      { proxyServer },
    );
  }
}

function bounded(value: string, maxChars: number): BrowserBridgeResult {
  const max = Number.isInteger(maxChars) && maxChars > 0 ? maxChars : DEFAULT_MAX_OUTPUT_CHARS;
  return { output: value.slice(0, max), truncated: value.length > max };
}

async function assertReportedPageUrlsSafe(
  output: string,
  resolveHost?: ResolveWebHost,
  requirePageUrl = true,
): Promise<void> {
  const urls = [...output.matchAll(/^\s*(?:[-*]\s*)?Page URL:\s*(\S+)\s*$/gimu)].map(
    (match) => match[1]!,
  );
  if (!urls.length && requirePageUrl) throw new Error("browser_result_page_url_missing");
  for (const value of urls) {
    if (value === "about:blank") continue;
    try {
      await assertPublicWebUrl(value, resolveHost);
    } catch {
      throw new Error("browser_result_target_denied");
    }
  }
}
