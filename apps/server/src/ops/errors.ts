/** Public diagnostics contain fixed codes, never workspace paths or provider output. */
export const OPS_STATE_CODES = [
  "worker_file_authority_missing",
  "worker_not_started",
  "worker_binding_unverified",
  "task_not_ready_for_rework",
] as const;

export type OpsStateCode = (typeof OPS_STATE_CODES)[number];

export class OpsStateError extends Error {
  constructor(readonly code: OpsStateCode) {
    super(code);
    this.name = "OpsStateError";
  }
}

export interface WorkerDispatchFailure {
  phase: string;
  code: OpsStateCode | "worker_dispatch_failed";
}
