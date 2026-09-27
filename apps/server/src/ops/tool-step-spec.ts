const TASK_GET_SPEC = /^tool:task_get:([A-Za-z0-9][A-Za-z0-9_-]{0,127})$/;
const CHECKPOINT_WRITE_SPEC = /^tool:checkpoint_write:([A-Za-z0-9][A-Za-z0-9_-]{0,127})$/;

/** The closed Tool Step form currently supported by P6. */
export function parseTaskGetSpec(ref: string): { targetTaskId: string } | null {
  const match = TASK_GET_SPEC.exec(ref);
  return match ? { targetTaskId: match[1] } : null;
}

/** The bounded, product-owned mutation Tool form. Its suffix is an opaque state reference. */
export function parseCheckpointWriteSpec(ref: string): { stateRef: string } | null {
  const match = CHECKPOINT_WRITE_SPEC.exec(ref);
  return match ? { stateRef: match[1] } : null;
}
