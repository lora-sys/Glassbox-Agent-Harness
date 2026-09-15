// @glassbox/contracts — shared schemas, command and event types.

export const contractsVersion = "0.0.0";
export { RUN_INTEGRITY_SUITE } from "./evals.js";
export type {
  EvalVerdict,
  RunEvalCheck,
  RunEvalScore,
  RunEvalAssessment,
  RunEvalView,
  RunEvalPage,
} from "./evals.js";
export { MODEL_PROTOCOLS } from "./management.js";
export type { ClaudeExecutorSettings, PublicExecutor } from "./executors.js";
export type {
  ModelProtocol,
  PublicModelProfile,
  ManagementFailure,
  ManagementStatus,
  ManagementDoctor,
} from "./management.js";
export { CHANNEL_SAFE_ERRORS } from "./channels.js";
export type {
  ChannelConnectionState,
  ChannelSafeError,
  ChannelSaveInput,
  PublicChannelProfile,
} from "./channels.js";
