export interface WorkbenchTurnState {
  turnId: string | null;
  running: boolean;
}

/** Turn identity prevents a late old completion from ending a newer live turn. */
export function applyWorkbenchTurnEvent(
  state: WorkbenchTurnState,
  event: { method?: unknown; params?: unknown },
  pendingPreviousTurn?: string | null,
): WorkbenchTurnState {
  const params =
    event.params && typeof event.params === "object"
      ? (event.params as Record<string, unknown>)
      : {};
  const turn =
    params.turn && typeof params.turn === "object" ? (params.turn as Record<string, unknown>) : {};
  const id =
    typeof params.turnId === "string"
      ? params.turnId
      : typeof turn.id === "string"
        ? turn.id
        : null;
  if (event.method === "turn/started") return { turnId: id, running: true };
  if (
    !["turn/completed", "turn/interrupted", "turn/failed"].includes(
      typeof event.method === "string" ? event.method : "",
    )
  )
    return state;
  if (state.turnId && id && state.turnId !== id) return state;
  // An untagged legacy notification cannot end an identified newer turn.
  if (state.turnId && !id) return state;
  return {
    turnId: null,
    running:
      pendingPreviousTurn !== undefined &&
      (id === pendingPreviousTurn || (pendingPreviousTurn === null && state.turnId === null)),
  };
}
