// apps/server/src/codex/schema.ts
// Effect Schema definitions for normalized Codex event payloads.
// Each schema shapes the `params` portion of a JSON-RPC notification,
// wrapped with a `_tag` discriminator so the `CodexEvent` union is
// a proper tagged union.

import { Schema } from "effect";

// ---------------------------------------------------------------------------
// Glassbox-side Action records (added S6)
// ---------------------------------------------------------------------------
// The action schemas are defined inline below (ActionPauseParams, etc.);
// this section exists as a separator only.
// ---------------------------------------------------------------------------
// Shared sub-schemas
// ---------------------------------------------------------------------------

// Decode any unknown value from the wire (placeholder for error-shaped records).
const CodexError: typeof Schema.Unknown = Schema.Unknown;

// ---------------------------------------------------------------------------
// Per-event schemas (params + _tag)
// ---------------------------------------------------------------------------

/** thread/started notification params */
export const ThreadStartedParams = Schema.Struct({
  _tag: Schema.Literal("threadStarted"),
  thread: Schema.Struct({
    id: Schema.String,
    sessionId: Schema.String,
    status: Schema.Struct({ type: Schema.String }),
    cwd: Schema.String,
  }),
});
export type ThreadStartedParams = Schema.Schema.Type<
  typeof ThreadStartedParams
>;

/** turn/started notification params */
export const TurnStartedParams = Schema.Struct({
  _tag: Schema.Literal("turnStarted"),
  threadId: Schema.String,
  input: Schema.optional(Schema.Array(
    Schema.Struct({
      type: Schema.String,
      text: Schema.optional(Schema.String),
    })
  )),
  turn: Schema.Struct({
    id: Schema.String,
    status: Schema.String,
  }),
});
export type TurnStartedParams = Schema.Schema.Type<typeof TurnStartedParams>;

/** item/started notification params (item.type varies, captured as string) */
export const ItemStartedParams = Schema.Struct({
  _tag: Schema.Literal("itemStarted"),
  item: Schema.Struct({
    type: Schema.String,
    id: Schema.String,
    text: Schema.optional(Schema.String),
    phase: Schema.optional(Schema.String),
  }),
  threadId: Schema.String,
  turnId: Schema.String,
  startedAtMs: Schema.Number,
});
export type ItemStartedParams = Schema.Schema.Type<typeof ItemStartedParams>;

/** item/agentMessage/delta notification params */
export const AgentMessageDeltaParams = Schema.Struct({
  _tag: Schema.Literal("agentMessageDelta"),
  threadId: Schema.String,
  turnId: Schema.String,
  itemId: Schema.String,
  delta: Schema.String,
});
export type AgentMessageDeltaParams = Schema.Schema.Type<
  typeof AgentMessageDeltaParams
>;

/** item/completed notification params */
export const ItemCompletedParams = Schema.Struct({
  _tag: Schema.Literal("itemCompleted"),
  item: Schema.Struct({
    type: Schema.String,
    id: Schema.String,
    status: Schema.String,
    aggregatedOutput: Schema.optional(Schema.String),
    exitCode: Schema.optional(Schema.Number),
    durationMs: Schema.optional(Schema.Number),
  }),
  threadId: Schema.String,
  turnId: Schema.String,
  completedAtMs: Schema.Number,
});
export type ItemCompletedParams = Schema.Schema.Type<typeof ItemCompletedParams>;

/** turn/completed notification params */
export const TurnCompletedParams = Schema.Struct({
  _tag: Schema.Literal("turnCompleted"),
  threadId: Schema.String,
  turn: Schema.Struct({
    id: Schema.String,
    status: Schema.String,
    startedAt: Schema.Number,
    completedAt: Schema.Number,
    durationMs: Schema.Number,
    error: CodexError,
  }),
});
export type TurnCompletedParams = Schema.Schema.Type<typeof TurnCompletedParams>;

/** item/{fileChange}/notification params (distinct from requestApproval) */
export const ItemFileChangeParams = Schema.Struct({
  _tag: Schema.Literal("itemFileChange"),
  threadId: Schema.String,
  turnId: Schema.String,
  itemId: Schema.String,
  changes: Schema.Array(
    Schema.Struct({
      path: Schema.String,
      kind: Schema.String,
      diff: Schema.optional(Schema.String),
    })
  ),
});
export type ItemFileChangeParams = Schema.Schema.Type<
  typeof ItemFileChangeParams
>;

/** turn/diff/updated — notification of a filesystem diff during a turn */
export const TurnDiffUpdatedParams = Schema.Struct({
  _tag: Schema.Literal("turnDiffUpdated"),
  threadId: Schema.String,
  turnId: Schema.String,
  diff: Schema.String,
});
export type TurnDiffUpdatedParams = Schema.Schema.Type<
  typeof TurnDiffUpdatedParams
>;

/** item/{fileChange,commandExecution}/requestApproval notification params */
export const RequestApprovalParams = Schema.Struct({
  _tag: Schema.Literal("requestApproval"),
  threadId: Schema.String,
  turnId: Schema.String,
  itemId: Schema.String,
  startedAtMs: Schema.Number,
  reason: Schema.Union([Schema.String, Schema.Null]),
  grantRoot: Schema.Union([Schema.String, Schema.Null]),
});
export type RequestApprovalParams = Schema.Schema.Type<
  typeof RequestApprovalParams
>;

/** Glassbox action.send record (appended to trace after new turn starts with edited task) */
export const ActionSendParams = Schema.Struct({
  _tag: Schema.Literal("actionSend"),
  kind: Schema.Literal("action.send"),
  source: Schema.String,
  sessionId: Schema.String,
  threadId: Schema.String,
  turnId: Schema.String,
  task: Schema.String,
  ts: Schema.String,
});
export type ActionSendParams = Schema.Schema.Type<
  typeof ActionSendParams
>;

/** Glassbox action.pause record (appended to trace after turn/interrupt) */
export const ActionPauseParams = Schema.Struct({
  _tag: Schema.Literal("actionPause"),
  kind: Schema.Literal("action.pause"),
  source: Schema.String,
  sessionId: Schema.String,
  threadId: Schema.String,
  turnId: Schema.String,
  turnStatus: Schema.String,
  ts: Schema.String,
});
export type ActionPauseParams = Schema.Schema.Type<
  typeof ActionPauseParams
>;

/** thread/tokenUsage/updated notification params (Codex usage event) */
export const TokenUsageUpdatedParams = Schema.Struct({
  _tag: Schema.Literal("tokenUsageUpdated"),
  threadId: Schema.String,
  turnId: Schema.String,
  tokenUsage: Schema.Struct({
    total: Schema.Struct({
      totalTokens: Schema.Number,
      inputTokens: Schema.Number,
      cachedInputTokens: Schema.optional(Schema.Number),
      cacheWriteInputTokens: Schema.optional(Schema.Number),
      outputTokens: Schema.Number,
      reasoningOutputTokens: Schema.optional(Schema.Number),
    }),
    last: Schema.Struct({
      totalTokens: Schema.Number,
      inputTokens: Schema.Number,
      cachedInputTokens: Schema.optional(Schema.Number),
      cacheWriteInputTokens: Schema.optional(Schema.Number),
      outputTokens: Schema.Number,
      reasoningOutputTokens: Schema.optional(Schema.Number),
    }),
    modelContextWindow: Schema.Number,
  }),
  costUsd: Schema.optional(Schema.Number),
});
export type TokenUsageUpdatedParams = Schema.Schema.Type<
  typeof TokenUsageUpdatedParams
>;

/** Glassbox action.steer record (appended to trace after new turn starts) */
export const ActionSteerParams = Schema.Struct({
  _tag: Schema.Literal("actionSteer"),
  kind: Schema.Literal("action.steer"),
  source: Schema.String,
  sessionId: Schema.String,
  threadId: Schema.String,
  turnId: Schema.String,
  instruction: Schema.String,
  ts: Schema.String,
});
export type ActionSteerParams = Schema.Schema.Type<
  typeof ActionSteerParams
>;

// ---------------------------------------------------------------------------
// Full event union
// ---------------------------------------------------------------------------

export const CodexEvent = Schema.Union([
  ThreadStartedParams,
  TurnStartedParams,
  ItemStartedParams,
  AgentMessageDeltaParams,
  ItemCompletedParams,
  TurnCompletedParams,
  ItemFileChangeParams,
  RequestApprovalParams,
  ActionPauseParams,
  ActionSteerParams,
  ActionSendParams,
  TurnDiffUpdatedParams,
  TokenUsageUpdatedParams,
]);

export type CodexEvent = Schema.Schema.Type<typeof CodexEvent>;

// ---------------------------------------------------------------------------
// Method → schema dispatch tables
// ---------------------------------------------------------------------------

export const METHOD_TAG: ReadonlyMap<string, CodexEvent["_tag"]> = new Map([
  ["thread/started", "threadStarted"],
  ["turn/started", "turnStarted"],
  ["item/started", "itemStarted"],
  ["item/agentMessage/delta", "agentMessageDelta"],
  ["item/completed", "itemCompleted"],
  ["turn/completed", "turnCompleted"],
  ["item/fileChange", "itemFileChange"],
  ["item/fileChange/requestApproval", "requestApproval"],
  ["item/commandExecution/requestApproval", "requestApproval"],
  ["thread/tokenUsage/updated", "tokenUsageUpdated"],
  ["action.steer", "actionSteer"],
  ["action.send", "actionSend"],
  ["turn/diff/updated", "turnDiffUpdated"],
]);

export const TAG_SCHEMA: Map<string, unknown> = new Map()
  .set("threadStarted", ThreadStartedParams)
  .set("turnStarted", TurnStartedParams)
  .set("itemStarted", ItemStartedParams)
  .set("agentMessageDelta", AgentMessageDeltaParams)
  .set("itemCompleted", ItemCompletedParams)
  .set("turnCompleted", TurnCompletedParams)
  .set("itemFileChange", ItemFileChangeParams)
  .set("requestApproval", RequestApprovalParams)
  .set("actionPause", ActionPauseParams)
  .set("actionSteer", ActionSteerParams)
  .set("actionSend", ActionSendParams)
  .set("turnDiffUpdated", TurnDiffUpdatedParams)
  .set("tokenUsageUpdated", TokenUsageUpdatedParams);
