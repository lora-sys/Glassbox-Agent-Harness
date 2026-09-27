const TASK_GET_SPEC = /^tool:task_get:([A-Za-z0-9][A-Za-z0-9_-]{0,127})$/;

/** The closed Tool Step form currently supported by P6. */
export function parseTaskGetSpec(ref: string): { targetTaskId: string } | null {
  const match = TASK_GET_SPEC.exec(ref);
  return match ? { targetTaskId: match[1] } : null;
}
