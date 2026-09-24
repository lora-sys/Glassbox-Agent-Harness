import {
  BrowserSessionRegistry,
  browserSessionBindingKey,
  type BrowserSessionBinding,
  type BrowserSession,
} from "./browser-session.js";
import type {
  BrowserArtifactReference,
  BrowserExecutionSession,
  BrowserExecutorPort,
} from "./browser-executor-port.js";
import { assertPublicWebUrl, type ResolveWebHost } from "./network-guard.js";

export type BrowserCapability = "browser.read" | "browser.interact";

export type BrowserAction =
  | { type: "open"; url: string }
  | { type: "close" }
  | { type: "goto"; url: string }
  | { type: "back" | "forward" | "reload" }
  | { type: "read" }
  | { type: "snapshot"; interactive?: boolean; compact?: boolean; depth?: number }
  | {
      type: "get";
      kind: "text" | "html" | "value" | "attr" | "box" | "styles";
      ref: string;
      name?: string;
    }
  | { type: "get"; kind: "title" | "url" }
  | { type: "get"; kind: "count"; selector: string }
  | { type: "is"; kind: "visible" | "enabled" | "checked"; ref: string }
  | { type: "click" | "check" | "uncheck" | "hover" | "scroll_into_view"; ref: string }
  | { type: "fill" | "type"; ref: string; text: string }
  | { type: "press"; key: string }
  | { type: "select"; ref: string; value: string }
  | { type: "scroll"; direction: "up" | "down"; pixels?: number }
  | { type: "wait"; condition: "selector" | "text" | "url" | "load"; value: string }
  | { type: "screenshot"; fullPage?: boolean }
  | { type: "network_requests"; filter?: string }
  | { type: "network_request"; requestId: string }
  | { type: "console"; clear?: boolean }
  | { type: "tab_list" | "tab_new" | "tab_close" }
  | { type: "tab_select"; tabId: string };

export type BrowserAuthorizer = (
  binding: BrowserSessionBinding,
  capability: BrowserCapability,
  action: BrowserAction["type"],
) => Promise<boolean>;

export interface BrowserBridgeOptions {
  authorize: BrowserAuthorizer;
  executor: BrowserExecutorPort;
  resolveHost?: ResolveWebHost;
  sessions?: BrowserSessionRegistry;
  timeoutMs?: number;
  maxOutputChars?: number;
  maxArtifactBytes?: number;
}

export interface BrowserBridgeResult {
  output: string;
  truncated: boolean;
  artifact?: BrowserArtifactReference;
  warning?: string;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_OUTPUT_CHARS = 20_000;
const DEFAULT_MAX_ARTIFACT_BYTES = 8_000_000;
const MAX_INPUT_CHARS = 8_000;

interface Command {
  capability: BrowserCapability;
  args: string[];
  navigation?: boolean;
  mutation?: boolean;
  tabChange?: boolean;
  snapshot?: boolean;
  needsRef?: string;
}

interface ParsedCliResult {
  success: boolean;
  data?: unknown;
  error?: string;
  code?: string;
  warning?: string;
}

interface LiveBrowserSession {
  execution: BrowserExecutionSession;
  sessionId: string;
  refs: Set<string>;
  activeTab: string;
  snapshotTab?: string;
}

function validateBinding(binding: BrowserSessionBinding): void {
  if (
    ![
      binding.runId,
      binding.principalId,
      binding.conversationId,
      binding.workspaceId,
      binding.policyVersion,
    ].every((value) => typeof value === "string" && value.length > 0)
  )
    throw new Error("browser_invalid_binding");
  if (binding.purpose !== undefined && binding.purpose !== "tool" && binding.purpose !== "fallback")
    throw new Error("browser_invalid_binding");
}

function validateText(value: string, code = "browser_invalid_text"): string {
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
  if (!/^@e[1-9][0-9]{0,5}$/u.test(value)) throw new Error("browser_invalid_ref");
  return value;
}

function validateKey(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_+.-]{0,31}$/u.test(value)) throw new Error("browser_invalid_key");
  return value;
}

function validateIndex(value: number, code: string, maximum = 1_000): number {
  if (!Number.isInteger(value) || value < 0 || value > maximum) throw new Error(code);
  return value;
}

function commandFor(action: BrowserAction): Command {
  switch (action.type) {
    case "open":
    case "goto":
      return {
        capability: "browser.read",
        args: ["open", validateText(action.url, "browser_invalid_url")],
        navigation: true,
      };
    case "close":
      return { capability: "browser.interact", args: ["close"] };
    case "back":
      return { capability: "browser.read", args: ["back"], navigation: true };
    case "forward":
      return { capability: "browser.read", args: ["forward"], navigation: true };
    case "reload":
      return { capability: "browser.read", args: ["reload"], navigation: true };
    case "read":
      if ("url" in action) throw new Error("browser_action_not_allowed");
      return { capability: "browser.read", args: ["read"] };
    case "snapshot": {
      const args = ["snapshot"];
      if (action.interactive) args.push("-i");
      if (action.compact) args.push("-c");
      if (action.depth !== undefined) {
        validateIndex(action.depth, "browser_invalid_depth", 20);
        if (action.depth < 1) throw new Error("browser_invalid_depth");
        args.push("-d", `${action.depth}`);
      }
      return { capability: "browser.read", args, snapshot: true };
    }
    case "get": {
      if (action.kind === "count")
        return {
          capability: "browser.read",
          args: ["get", "count", validateText(action.selector)],
        };
      if (action.kind === "title" || action.kind === "url")
        return { capability: "browser.read", args: ["get", action.kind] };
      if (!("ref" in action)) throw new Error("browser_invalid_action");
      const ref = validateRef(action.ref);
      if (action.kind === "attr") {
        if (!action.name || !/^[A-Za-z_:][A-Za-z0-9_.:-]{0,63}$/u.test(action.name))
          throw new Error("browser_invalid_attribute");
        return {
          capability: "browser.read",
          args: ["get", "attr", ref, action.name],
          needsRef: ref,
        };
      }
      return { capability: "browser.read", args: ["get", action.kind, ref], needsRef: ref };
    }
    case "is": {
      const ref = validateRef(action.ref);
      return { capability: "browser.read", args: ["is", action.kind, ref], needsRef: ref };
    }
    case "click":
    case "check":
    case "uncheck":
    case "hover":
    case "scroll_into_view": {
      const ref = validateRef(action.ref);
      return {
        capability: "browser.interact",
        args: [action.type === "scroll_into_view" ? "scrollintoview" : action.type, ref],
        mutation: true,
        needsRef: ref,
      };
    }
    case "fill":
    case "type": {
      const ref = validateRef(action.ref);
      return {
        capability: "browser.interact",
        args: [action.type, ref, validateText(action.text)],
        mutation: true,
        needsRef: ref,
      };
    }
    case "press":
      return {
        capability: "browser.interact",
        args: ["press", validateKey(action.key)],
        mutation: true,
      };
    case "select": {
      const ref = validateRef(action.ref);
      return {
        capability: "browser.interact",
        args: ["select", ref, validateText(action.value)],
        mutation: true,
        needsRef: ref,
      };
    }
    case "scroll": {
      const pixels = action.pixels ?? 300;
      if (action.direction !== "up" && action.direction !== "down")
        throw new Error("browser_invalid_scroll");
      if (!Number.isInteger(pixels) || pixels < 1 || pixels > 5_000)
        throw new Error("browser_invalid_scroll");
      return {
        capability: "browser.interact",
        args: ["scroll", action.direction, `${pixels}`],
        mutation: true,
      };
    }
    case "wait": {
      const value = validateText(action.value);
      if (action.condition === "selector")
        return { capability: "browser.read", args: ["wait", value] };
      if (action.condition === "text")
        return { capability: "browser.read", args: ["wait", "--text", value] };
      if (action.condition === "url")
        return { capability: "browser.read", args: ["wait", "--url", value] };
      if (!["domcontentloaded", "load", "networkidle"].includes(value))
        throw new Error("browser_invalid_wait");
      return { capability: "browser.read", args: ["wait", "--load", value] };
    }
    case "screenshot":
      return {
        capability: "browser.read",
        args: action.fullPage ? ["screenshot", "--full"] : ["screenshot"],
      };
    case "network_requests":
      return {
        capability: "browser.read",
        args: action.filter
          ? ["network", "requests", "--filter", validateText(action.filter)]
          : ["network", "requests"],
      };
    case "network_request": {
      if (!/^[A-Za-z0-9_-]{1,128}$/u.test(action.requestId))
        throw new Error("browser_invalid_request_id");
      return { capability: "browser.read", args: ["network", "request", action.requestId] };
    }
    case "console":
      return {
        capability: "browser.read",
        args: action.clear ? ["console", "--clear"] : ["console"],
      };
    case "tab_list":
      return { capability: "browser.read", args: ["tab"] };
    case "tab_new":
      return {
        capability: "browser.interact",
        args: ["tab", "new"],
        tabChange: true,
        mutation: true,
      };
    case "tab_close":
      return {
        capability: "browser.interact",
        args: ["tab", "close"],
        tabChange: true,
        mutation: true,
      };
    case "tab_select": {
      if (!/^t[1-9][0-9]{0,5}$/u.test(action.tabId)) throw new Error("browser_invalid_tab_id");
      return { capability: "browser.interact", args: ["tab", action.tabId], tabChange: true };
    }
    default:
      throw new Error("browser_action_not_allowed");
  }
}

/** Maps product actions to the allowlisted agent-browser 0.38.1 CLI surface. */
export class BrowserBridge {
  private readonly sessions: BrowserSessionRegistry;
  private readonly live = new Map<string, LiveBrowserSession>();

  constructor(private readonly options: BrowserBridgeOptions) {
    this.sessions = options.sessions ?? new BrowserSessionRegistry();
  }

  async execute(
    binding: BrowserSessionBinding,
    action: BrowserAction,
  ): Promise<BrowserBridgeResult> {
    binding = { ...binding, purpose: binding.purpose ?? "tool" };
    validateBinding(binding);
    const command = commandFor(action);
    if (!(await this.options.authorize(binding, command.capability, action.type))) {
      await this.cleanup(binding).catch(() => undefined);
      throw new Error("browser_denied");
    }
    if (action.type === "open" || action.type === "goto") {
      const targetUrl = action.url;
      if (!targetUrl) throw new Error("browser_invalid_url");
      const safe = await assertPublicWebUrl(targetUrl, this.options.resolveHost);
      command.args[command.args.length - 1] = safe.href;
    }

    return this.sessions.exclusive(binding, async (session) => {
      const key = browserSessionBindingKey(binding);
      if (action.type === "open") {
        if (session.opened) throw new Error("browser_session_already_open");
        try {
          const execution = await this.options.executor.open(binding, session.cliSession);
          this.live.set(key, {
            execution,
            sessionId: session.cliSession,
            refs: new Set(),
            activeTab: "t1",
          });
          session.opened = true;
        } catch (error) {
          this.sessions.forget(binding);
          throw error;
        }
      } else if (!session.opened) {
        throw new Error("browser_session_not_open");
      }
      const live = this.live.get(key);
      if (!live) throw new Error("browser_executor_session_missing");
      if (
        command.needsRef &&
        (live.snapshotTab !== live.activeTab || !live.refs.has(command.needsRef))
      )
        throw new Error("browser_stale_ref");
      if (command.navigation || command.mutation || command.tabChange) this.invalidateRefs(live);
      const args = ["--json", "--session", session.cliSession, ...command.args];
      try {
        if (!(await this.options.authorize(binding, command.capability, action.type)))
          throw new Error("browser_denied");
        if (action.type !== "open" && action.type !== "close")
          await this.assertCurrentUrlSafe(live);
        const result = await live.execution.execute(args, this.limits());
        if (!(await this.options.authorize(binding, command.capability, action.type)))
          throw new Error("browser_denied");
        if (result.exitCode !== 0) throw new Error("browser_cli_failed");
        const parsed = parseJsonResult(result.stdout);
        if (!parsed.success) throw new Error(`browser_cli_${parsed.code ?? "failed"}`);
        if (command.snapshot) {
          live.refs = extractRefs(parsed.data);
          live.snapshotTab = live.activeTab;
        }
        if (
          action.type === "tab_select" ||
          action.type === "tab_new" ||
          action.type === "tab_close"
        ) {
          live.activeTab = action.type === "tab_select" ? action.tabId : `unknown-${Date.now()}`;
        }
        const needsUrlCheck = command.navigation || command.mutation || command.tabChange;
        if (needsUrlCheck) await this.assertCurrentUrlSafe(live);
        const artifact = action.type === "screenshot" ? result.artifact : undefined;
        if (action.type === "screenshot") {
          if (
            !artifact?.id ||
            (artifact.sizeBytes !== undefined &&
              artifact.sizeBytes > (this.options.maxArtifactBytes ?? DEFAULT_MAX_ARTIFACT_BYTES))
          )
            throw new Error("browser_artifact_invalid");
        }
        const output = safeOutput(
          parsed.data,
          artifact,
          action.type === "network_requests" || action.type === "network_request",
        );
        const max = this.options.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS;
        if (action.type === "close") await this.closeSession(binding, session, true);
        return {
          output: output.slice(0, max),
          truncated: output.length > max,
          ...(artifact ? { artifact } : {}),
          ...(parsed.warning ? { warning: parsed.warning.slice(0, 500) } : {}),
        };
      } catch (error) {
        await this.closeSession(binding, session, false).catch(() => undefined);
        throw error;
      }
    });
  }

  async cleanup(binding: BrowserSessionBinding): Promise<void> {
    binding = { ...binding, purpose: binding.purpose ?? "tool" };
    validateBinding(binding);
    await this.sessions.exclusive(binding, async (session) =>
      this.closeSession(binding, session, false),
    );
  }

  private invalidateRefs(live: LiveBrowserSession): void {
    live.refs.clear();
    live.snapshotTab = undefined;
  }

  private limits() {
    return {
      timeoutMs: this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxOutputChars: this.options.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS,
      maxArtifactBytes: this.options.maxArtifactBytes ?? DEFAULT_MAX_ARTIFACT_BYTES,
    };
  }

  private async assertCurrentUrlSafe(live: LiveBrowserSession): Promise<void> {
    const result = await live.execution.execute(
      ["--json", "--session", live.sessionId, "get", "url"],
      this.limits(),
    );
    if (result.exitCode !== 0) throw new Error("browser_result_url_unavailable");
    const parsed = parseJsonResult(result.stdout);
    if (!parsed.success) throw new Error("browser_result_url_unavailable");
    const url = extractCurrentUrl(parsed.data);
    if (url === "about:blank") return;
    if (!url || !/^https?:\/\//iu.test(url)) throw new Error("browser_result_target_denied");
    try {
      await assertPublicWebUrl(url, this.options.resolveHost);
    } catch {
      throw new Error("browser_result_target_denied");
    }
  }

  private async closeSession(
    binding: BrowserSessionBinding,
    session: BrowserSession,
    cliAlreadyClosed: boolean,
  ): Promise<void> {
    const key = browserSessionBindingKey(binding);
    const live = this.live.get(key);
    let failure: unknown;
    try {
      if (live && !cliAlreadyClosed && session.opened) {
        const result = await live.execution.execute(
          ["--json", "--session", session.cliSession, "close"],
          {
            timeoutMs: this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
            maxOutputChars: this.options.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS,
            maxArtifactBytes: this.options.maxArtifactBytes ?? DEFAULT_MAX_ARTIFACT_BYTES,
          },
        );
        if (result.exitCode !== 0 || !parseJsonResult(result.stdout).success)
          throw new Error("browser_cleanup_failed");
      }
    } catch (error) {
      failure = error;
    } finally {
      try {
        if (live) {
          if (!cliAlreadyClosed) await live.execution.cancel().catch(() => undefined);
          await live.execution.close();
        }
      } catch (error) {
        failure ??= error;
      }
      this.live.delete(key);
      session.opened = false;
      this.sessions.forget(binding);
    }
    if (failure) throw failure;
  }
}

function parseJsonResult(stdout: string): ParsedCliResult {
  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch {
    throw new Error("browser_cli_invalid_json");
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("browser_cli_invalid_json");
  const result = value as Record<string, unknown>;
  if (typeof result.success !== "boolean") throw new Error("browser_cli_invalid_json");
  return {
    success: result.success,
    ...(result.data !== undefined ? { data: result.data } : {}),
    ...(typeof result.error === "string" ? { error: result.error } : {}),
    ...(typeof result.code === "string" ? { code: result.code } : {}),
    ...(typeof result.warning === "string" ? { warning: result.warning } : {}),
  };
}

function extractRefs(data: unknown): Set<string> {
  const text = typeof data === "string" ? data : JSON.stringify(data ?? "");
  return new Set([...text.matchAll(/@e[1-9][0-9]{0,5}\b/gu)].map((match) => match[0]));
}

function extractCurrentUrl(data: unknown): string | undefined {
  if (typeof data === "string") return data.trim();
  if (!data || typeof data !== "object" || Array.isArray(data)) return undefined;
  const record = data as Record<string, unknown>;
  for (const key of ["url", "href", "currentUrl"])
    if (typeof record[key] === "string") return record[key] as string;
  return undefined;
}

function safeOutput(data: unknown, artifact?: BrowserArtifactReference, redact = false): string {
  if (artifact) return JSON.stringify({ artifact });
  const output = redact ? redactSensitiveData(data) : data;
  return typeof output === "string" ? output : JSON.stringify(output ?? null);
}

function redactSensitiveData(value: unknown): unknown {
  if (Array.isArray(value))
    return value.map((entry) => {
      if (entry && typeof entry === "object" && !Array.isArray(entry)) {
        const record = entry as Record<string, unknown>;
        if (
          typeof record.name === "string" &&
          /^(?:authorization|proxy-authorization|cookie|set-cookie|password|token|secret)$/iu.test(
            record.name,
          )
        )
          return { ...record, value: "[redacted]" };
      }
      return redactSensitiveData(entry);
    });
  if (!value || typeof value !== "object") return value;
  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    result[key] =
      /^(?:authorization|proxy-authorization|cookie|set-cookie|password|token|secret)$/iu.test(key)
        ? "[redacted]"
        : redactSensitiveData(child);
  }
  return result;
}
