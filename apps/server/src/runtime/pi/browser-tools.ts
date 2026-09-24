import { Type } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { DomainStore } from "../../persistence/index.js";
import type { WebCapability } from "../../management/web-capability-policy.js";
import { BrowserBridge, type BrowserAction } from "../../web/browser-bridge.js";
import { BrowserSessionRegistry, type BrowserSessionBinding } from "../../web/browser-session.js";
import type { BrowserActionResult } from "../../web/contracts.js";
import { WebTargetError } from "../../web/network-guard.js";
import { ProviderCallError } from "./provider-outcome.js";
import {
  createProtectedTool,
  ToolInputError,
  type ProtectedToolContext,
} from "./protected-tools.js";
import type { PiRunContext } from "./types.js";
import { WEB_ACTIONS, WEB_RESOURCE } from "./web-tools.js";

export const BROWSER_TOOL = "browser";

const ACTIONS = [
  "open",
  "goto",
  "close",
  "back",
  "forward",
  "reload",
  "read",
  "snapshot",
  "get",
  "is",
  "click",
  "fill",
  "type",
  "press",
  "select",
  "check",
  "uncheck",
  "hover",
  "scroll_into_view",
  "scroll",
  "wait",
  "screenshot",
  "network_requests",
  "network_request",
  "console",
  "tab_list",
  "tab_new",
  "tab_close",
  "tab_select",
] as const;

type ActionName = (typeof ACTIONS)[number];
export interface BrowserToolInput extends Record<string, unknown> {
  action: ActionName;
  url?: string;
  ref?: string;
  kind?: string;
  name?: string;
  selector?: string;
  text?: string;
  key?: string;
  value?: string;
  direction?: "up" | "down";
  pixels?: number;
  condition?: "selector" | "text" | "url" | "load";
  requestId?: string;
  tabId?: string;
  interactive?: boolean;
  compact?: boolean;
  depth?: number;
  fullPage?: boolean;
  clear?: boolean;
  filter?: string;
}

export interface BrowserToolEvidence {
  type: "browser";
  backend: "agent-browser";
  runId: string;
  conversationId: string;
  principalId: string;
  browserSessionId: string;
  action: ActionName;
  targetOrigin?: string;
  status: "succeeded";
  artifactId?: string;
  truncated: boolean;
  observedAt: string;
}

function contextFrom(getContext: () => PiRunContext | undefined): ProtectedToolContext | undefined {
  const value = getContext();
  return value?.caller && value.conversationId && value.runId
    ? { caller: value.caller, conversationId: value.conversationId, runId: value.runId }
    : undefined;
}

const INTERACTION_ACTIONS = new Set<ActionName>([
  "click",
  "fill",
  "type",
  "press",
  "select",
  "check",
  "uncheck",
  "hover",
  "scroll_into_view",
  "scroll",
  "tab_new",
  "tab_close",
  "tab_select",
  "close",
]);

function capabilityFor(action: ActionName): WebCapability {
  return INTERACTION_ACTIONS.has(action) ? "browser.interact" : "browser.read";
}

function stringField(value: unknown): string {
  if (typeof value !== "string" || !value) throw new ToolInputError("browser_missing_parameter");
  return value;
}

function booleanField(value: unknown): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new ToolInputError("browser_invalid_parameter");
  return value;
}

function numberField(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value)) throw new ToolInputError("browser_invalid_parameter");
  return value as number;
}

function only(input: BrowserToolInput, ...names: string[]): void {
  const allowed = new Set(["action", ...names]);
  if (Object.keys(input).some((key) => !allowed.has(key)))
    throw new ToolInputError("browser_invalid_parameter");
}

/** The model never supplies executable names, argv, files, configuration, or nested actions. */
function toAction(input: BrowserToolInput): BrowserAction {
  switch (input.action) {
    case "open":
    case "goto":
      only(input, "url");
      return { type: input.action, url: stringField(input.url) };
    case "close":
    case "back":
    case "forward":
    case "reload":
    case "tab_list":
    case "tab_new":
    case "tab_close":
      only(input);
      return { type: input.action };
    case "read":
      only(input);
      return { type: "read" };
    case "snapshot":
      only(input, "interactive", "compact", "depth");
      return {
        type: "snapshot",
        ...(booleanField(input.interactive) === undefined
          ? {}
          : { interactive: input.interactive as boolean }),
        ...(booleanField(input.compact) === undefined ? {} : { compact: input.compact as boolean }),
        ...(numberField(input.depth) === undefined ? {} : { depth: input.depth as number }),
      };
    case "get": {
      only(input, "kind", "ref", "name", "selector");
      const kind = stringField(input.kind);
      if (kind === "title" || kind === "url") return { type: "get", kind };
      if (kind === "count") return { type: "get", kind, selector: stringField(input.selector) };
      if (kind === "attr")
        return { type: "get", kind, ref: stringField(input.ref), name: stringField(input.name) };
      if (["text", "html", "value", "box", "styles"].includes(kind))
        return {
          type: "get",
          kind: kind as "text" | "html" | "value" | "box" | "styles",
          ref: stringField(input.ref),
        };
      throw new ToolInputError("browser_invalid_kind");
    }
    case "is": {
      only(input, "kind", "ref");
      const kind = stringField(input.kind);
      if (kind !== "visible" && kind !== "enabled" && kind !== "checked")
        throw new ToolInputError("browser_invalid_kind");
      return { type: "is", kind, ref: stringField(input.ref) };
    }
    case "click":
    case "check":
    case "uncheck":
    case "hover":
    case "scroll_into_view":
      only(input, "ref");
      return { type: input.action, ref: stringField(input.ref) };
    case "fill":
    case "type":
      only(input, "ref", "text");
      return { type: input.action, ref: stringField(input.ref), text: stringField(input.text) };
    case "press":
      only(input, "key");
      return { type: "press", key: stringField(input.key) };
    case "select":
      only(input, "ref", "value");
      return { type: "select", ref: stringField(input.ref), value: stringField(input.value) };
    case "scroll":
      only(input, "direction", "pixels");
      if (input.direction !== "up" && input.direction !== "down")
        throw new ToolInputError("browser_invalid_direction");
      return {
        type: "scroll",
        direction: input.direction,
        ...(numberField(input.pixels) === undefined ? {} : { pixels: input.pixels as number }),
      };
    case "wait":
      only(input, "condition", "value");
      if (!["selector", "text", "url", "load"].includes(input.condition ?? ""))
        throw new ToolInputError("browser_invalid_condition");
      return { type: "wait", condition: input.condition!, value: stringField(input.value) };
    case "screenshot":
      only(input, "fullPage");
      return {
        type: "screenshot",
        ...(booleanField(input.fullPage) === undefined
          ? {}
          : { fullPage: input.fullPage as boolean }),
      };
    case "network_requests":
      only(input, "filter");
      return {
        type: "network_requests",
        ...(input.filter === undefined ? {} : { filter: stringField(input.filter) }),
      };
    case "network_request":
      only(input, "requestId");
      return { type: "network_request", requestId: stringField(input.requestId) };
    case "console":
      only(input, "clear");
      return {
        type: "console",
        ...(booleanField(input.clear) === undefined ? {} : { clear: input.clear as boolean }),
      };
    case "tab_select":
      only(input, "tabId");
      return { type: "tab_select", tabId: stringField(input.tabId) };
    default:
      throw new ToolInputError("browser_action_not_allowed");
  }
}

export function createBrowserTools(options: {
  store: DomainStore;
  getContext: () => PiRunContext | undefined;
  binding: (context: ProtectedToolContext) => Promise<BrowserSessionBinding>;
  bridge?: BrowserBridge;
  sessions: BrowserSessionRegistry;
  isEnabled: (context: ProtectedToolContext, capability: WebCapability) => Promise<boolean>;
  onActivated: (context: ProtectedToolContext, cleanup: () => Promise<void>) => void;
  onClosed: (runId: string) => void;
  recordEvidence?: (record: BrowserToolEvidence, context: ProtectedToolContext) => Promise<void>;
}): ToolDefinition[] {
  const getContext = () => contextFrom(options.getContext);
  const tool = createProtectedTool<BrowserToolInput, BrowserActionResult>({
    name: BROWSER_TOOL,
    description:
      "Use the authorized isolated browser to read, inspect, and interact with public pages. Take a fresh snapshot before using an element reference. Screenshot returns a protected Artifact reference.",
    parameters: Type.Object(
      {
        action: Type.Union(ACTIONS.map((name) => Type.Literal(name))),
        url: Type.Optional(Type.String({ maxLength: 2048 })),
        ref: Type.Optional(Type.String({ maxLength: 64 })),
        kind: Type.Optional(Type.String({ maxLength: 32 })),
        name: Type.Optional(Type.String({ maxLength: 64 })),
        selector: Type.Optional(Type.String({ maxLength: 1000 })),
        text: Type.Optional(Type.String({ maxLength: 8000 })),
        key: Type.Optional(Type.String({ maxLength: 32 })),
        value: Type.Optional(Type.String({ maxLength: 8000 })),
        direction: Type.Optional(Type.Union([Type.Literal("up"), Type.Literal("down")])),
        pixels: Type.Optional(Type.Integer({ minimum: 1, maximum: 5000 })),
        condition: Type.Optional(
          Type.Union([
            Type.Literal("selector"),
            Type.Literal("text"),
            Type.Literal("url"),
            Type.Literal("load"),
          ]),
        ),
        requestId: Type.Optional(Type.String({ maxLength: 128 })),
        tabId: Type.Optional(Type.String({ maxLength: 32 })),
        interactive: Type.Optional(Type.Boolean()),
        compact: Type.Optional(Type.Boolean()),
        depth: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
        fullPage: Type.Optional(Type.Boolean()),
        clear: Type.Optional(Type.Boolean()),
        filter: Type.Optional(Type.String({ maxLength: 1000 })),
      },
      { additionalProperties: false },
    ),
    action: (params) => WEB_ACTIONS[capabilityFor(params.action)],
    resourceId: WEB_RESOURCE,
    authService: options.store.authorization,
    getContext,
    execute: async (params, context) => {
      const action = toAction(params);
      const capability = capabilityFor(params.action);
      if (!(await options.isEnabled(context, capability)))
        throw new ProviderCallError("denied", "capability_category_disabled");
      if (!options.bridge)
        throw new ProviderCallError("provider_unavailable", "browser_backend_unavailable");
      const target = await options.binding(context);
      const browserSessionId = options.sessions.session(target).cliSession;
      options.onActivated(context, () => options.bridge!.cleanup(target));
      try {
        const result = await options.bridge.execute(target, action);
        if (params.action === "close") options.onClosed(context.runId);
        const observedAt = new Date().toISOString();
        const response: BrowserActionResult = {
          status: "succeeded",
          backend: "agent-browser",
          browserSessionId,
          action: params.action,
          output: result.output,
          truncated: result.truncated,
          observedAt,
          ...(capability === "browser.interact" ? { postStateVerified: false } : {}),
          ...(result.artifact ? { artifact: result.artifact } : {}),
        };
        const targetOrigin = params.url ? new URL(params.url).origin : undefined;
        await options.recordEvidence?.(
          {
            type: "browser",
            backend: "agent-browser",
            runId: context.runId,
            conversationId: context.conversationId,
            principalId: context.caller.principalId,
            browserSessionId,
            action: params.action,
            ...(targetOrigin ? { targetOrigin } : {}),
            ...(result.artifact ? { artifactId: result.artifact.id } : {}),
            status: "succeeded",
            truncated: result.truncated,
            observedAt,
          },
          context,
        );
        return response;
      } catch (error) {
        if (error instanceof WebTargetError) throw new ToolInputError(error.code);
        if (
          error instanceof Error &&
          /^browser_(?:invalid|stale|action_not_allowed)/u.test(error.message)
        )
          throw new ToolInputError(error.message);
        if (error instanceof Error && error.message === "browser_denied")
          throw new ProviderCallError("denied", "browser_denied");
        if (error instanceof ToolInputError || error instanceof ProviderCallError) throw error;
        throw new ProviderCallError("provider_failed", "browser_failed");
      }
    },
    projectResult: (result) => JSON.stringify(result),
  });
  return [tool];
}
