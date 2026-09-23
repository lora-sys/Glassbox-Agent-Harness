import { Type } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { DomainStore } from "../../persistence/index.js";
import type { WebCapability } from "../../management/web-capability-policy.js";
import { BrowserBridge, type BrowserAction } from "../../web/browser-bridge.js";
import { BrowserSessionRegistry, type BrowserSessionBinding } from "../../web/browser-session.js";
import { DockerBrowserEnvironment } from "../../web/docker-browser.js";
import type { BrowserActionResult } from "../../web/contracts.js";
import { dohResolveWebHost, WebTargetError } from "../../web/network-guard.js";
import { ProviderCallError } from "./provider-outcome.js";
import {
  createProtectedTool,
  ToolInputError,
  type ProtectedToolContext,
} from "./protected-tools.js";
import type { PiRunContext } from "./types.js";
import { WEB_ACTIONS, WEB_RESOURCE } from "./web-tools.js";

export const PLAYWRIGHT_CLI_TOOL = "playwright_cli";

export interface BrowserToolInput extends Record<string, unknown> {
  action: BrowserAction["type"] | "close";
  url?: string;
  ref?: string;
  value?: string;
  key?: string;
  text?: string;
  depth?: number;
  index?: number;
  level?: "error" | "warning" | "info" | "debug";
}

export interface BrowserToolEvidence {
  type: "playwright_cli";
  runId: string;
  conversationId: string;
  principalId: string;
  browserSessionId: string;
  action: string;
  targetOrigin?: string;
  status: "succeeded";
  truncated: boolean;
  observedAt: string;
}

function contextFrom(getContext: () => PiRunContext | undefined): ProtectedToolContext | undefined {
  const value = getContext();
  return value?.caller && value.conversationId && value.runId
    ? { caller: value.caller, conversationId: value.conversationId, runId: value.runId }
    : undefined;
}

function capabilityFor(action: BrowserToolInput["action"]): WebCapability {
  return [
    "click",
    "fill",
    "type",
    "press",
    "select",
    "check",
    "uncheck",
    "hover",
    "tab_new",
    "tab_select",
    "tab_close",
    "close",
  ].includes(action)
    ? "browser.interact"
    : "browser.read";
}

function requiredString(value: unknown): string {
  if (typeof value !== "string" || !value) throw new ToolInputError("browser_missing_parameter");
  return value;
}

function browserAction(input: BrowserToolInput): BrowserAction {
  switch (input.action) {
    case "open":
    case "goto":
      return { type: input.action, url: requiredString(input.url) };
    case "go_back":
    case "go_forward":
    case "reload":
    case "tab_list":
    case "tab_new":
    case "requests":
      return { type: input.action };
    case "snapshot":
      return { type: "snapshot", ...(input.depth === undefined ? {} : { depth: input.depth }) };
    case "find":
      return { type: "find", text: requiredString(input.text) };
    case "type":
      return { type: "type", text: requiredString(input.text) };
    case "tab_select":
    case "tab_close":
    case "request_headers":
    case "response_headers":
      if (typeof input.index !== "number") throw new ToolInputError("browser_missing_parameter");
      return { type: input.action, index: input.index };
    case "console":
      return { type: "console", ...(input.level ? { level: input.level } : {}) };
    case "click":
    case "check":
    case "uncheck":
    case "hover":
      return { type: input.action, ref: requiredString(input.ref) };
    case "fill":
    case "select":
      return {
        type: input.action,
        ref: requiredString(input.ref),
        value: requiredString(input.value),
      };
    case "press":
      return { type: "press", key: requiredString(input.key) };
    default:
      throw new ToolInputError("browser_action_not_allowed");
  }
}

function binding(context: ProtectedToolContext): BrowserSessionBinding {
  return {
    principalId: context.caller.principalId,
    conversationId: context.conversationId,
    runId: context.runId,
  };
}

export function createBrowserTools(options: {
  store: DomainStore;
  getContext: () => PiRunContext | undefined;
  isEnabled: (context: ProtectedToolContext, capability: WebCapability) => Promise<boolean>;
  onActivated: (context: ProtectedToolContext, cleanup: () => Promise<void>) => void;
  onClosed: (runId: string) => void;
  recordEvidence?: (record: BrowserToolEvidence, context: ProtectedToolContext) => Promise<void>;
}): ToolDefinition[] {
  const getContext = () => contextFrom(options.getContext);
  const sessions = new BrowserSessionRegistry();
  const sandbox = new DockerBrowserEnvironment();
  const bridge = new BrowserBridge({
    runner: sandbox.run,
    proxyFactory: () => sandbox,
    sessions,
    resolveHost: dohResolveWebHost,
    authorize: async (requested, capability) => {
      const context = getContext();
      return Boolean(
        context &&
        context.runId === requested.runId &&
        context.conversationId === requested.conversationId &&
        context.caller.principalId === requested.principalId &&
        (await options.isEnabled(context, capability)),
      );
    },
  });
  const tool = createProtectedTool<BrowserToolInput, BrowserActionResult>({
    name: PLAYWRIGHT_CLI_TOOL,
    description:
      "Use an isolated public-web browser when search or fetch cannot read a page. Read and interaction actions have separate authorization. Use snapshot refs for interaction and close when done.",
    parameters: Type.Object(
      {
        action: Type.Union([
          Type.Literal("open"),
          Type.Literal("goto"),
          Type.Literal("snapshot"),
          Type.Literal("go_back"),
          Type.Literal("go_forward"),
          Type.Literal("reload"),
          Type.Literal("tab_list"),
          Type.Literal("tab_new"),
          Type.Literal("tab_select"),
          Type.Literal("tab_close"),
          Type.Literal("console"),
          Type.Literal("requests"),
          Type.Literal("request_headers"),
          Type.Literal("response_headers"),
          Type.Literal("find"),
          Type.Literal("type"),
          Type.Literal("click"),
          Type.Literal("fill"),
          Type.Literal("press"),
          Type.Literal("select"),
          Type.Literal("check"),
          Type.Literal("uncheck"),
          Type.Literal("hover"),
          Type.Literal("close"),
        ]),
        url: Type.Optional(Type.String({ maxLength: 2_048 })),
        ref: Type.Optional(Type.String({ maxLength: 64 })),
        value: Type.Optional(Type.String({ maxLength: 8_000 })),
        key: Type.Optional(Type.String({ maxLength: 32 })),
        text: Type.Optional(Type.String({ maxLength: 8_000 })),
        depth: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
        index: Type.Optional(Type.Integer({ minimum: 0, maximum: 1_000 })),
        level: Type.Optional(
          Type.Union([
            Type.Literal("error"),
            Type.Literal("warning"),
            Type.Literal("info"),
            Type.Literal("debug"),
          ]),
        ),
      },
      { additionalProperties: false },
    ),
    action: (params) => WEB_ACTIONS[capabilityFor(params.action)],
    resourceId: WEB_RESOURCE,
    authService: options.store.authorization,
    getContext,
    execute: async (params, context) => {
      const capability = capabilityFor(params.action);
      if (!(await options.isEnabled(context, capability)))
        throw new ProviderCallError("denied", "capability_category_disabled");
      const target = binding(context);
      const browserSessionId = sessions.session(target).cliSession;
      options.onActivated(context, () => bridge.cleanup(target));
      try {
        const result =
          params.action === "close"
            ? (await bridge.cleanup(target), { output: "", truncated: false })
            : await bridge.execute(target, browserAction(params));
        if (params.action === "close") options.onClosed(context.runId);
        const observedAt = new Date().toISOString();
        const response: BrowserActionResult = {
          status: "succeeded",
          browserSessionId,
          action: params.action,
          output: result.output,
          truncated: result.truncated,
          observedAt,
        };
        const targetOrigin = params.url ? new URL(params.url).origin : undefined;
        await options.recordEvidence?.(
          {
            type: "playwright_cli",
            runId: context.runId,
            conversationId: context.conversationId,
            principalId: context.caller.principalId,
            browserSessionId,
            action: params.action,
            ...(targetOrigin ? { targetOrigin } : {}),
            status: "succeeded",
            truncated: result.truncated,
            observedAt,
          },
          context,
        );
        return response;
      } catch (error) {
        if (error instanceof WebTargetError) throw new ToolInputError(error.code);
        if (error instanceof ToolInputError || error instanceof ProviderCallError) throw error;
        throw new ProviderCallError("provider_failed", "browser_failed");
      }
    },
    projectResult: (result) => JSON.stringify(result),
  });
  return [tool];
}
