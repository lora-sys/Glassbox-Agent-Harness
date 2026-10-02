import { describe, expect, it } from "vite-plus/test";
import { applyWorkbenchTurnEvent, type WorkbenchTurnState } from "./turn-state";
const idle: WorkbenchTurnState = { turnId: null, running: false };
const event = (method: string, turnId?: string) => ({ method, params: { turnId } });
describe("Workbench turn lifecycle", () => {
  it("keeps a pending continuation busy while its old turn is interrupted", () => {
    const old = { turnId: "old", running: true };
    const stopped = applyWorkbenchTurnEvent(old, event("turn/interrupted", "old"), "old");
    expect(stopped).toEqual({ turnId: null, running: true });
    const started = applyWorkbenchTurnEvent(stopped, event("turn/started", "new"), "old");
    expect(started).toEqual({ turnId: "new", running: true });
    expect(applyWorkbenchTurnEvent(started, event("turn/completed", "old"), "old")).toBe(started);
    expect(applyWorkbenchTurnEvent(started, event("turn/completed", "new"), "old")).toEqual(idle);
  });
  it("also tolerates a first turn whose started event preceded the subscription", () => {
    expect(
      applyWorkbenchTurnEvent(
        { turnId: null, running: true },
        event("turn/interrupted", "old"),
        null,
      ),
    ).toEqual({ turnId: null, running: true });
    const newTurn = applyWorkbenchTurnEvent(idle, event("turn/started", "new"), null);
    expect(applyWorkbenchTurnEvent(newTurn, event("turn/completed", "new"), null)).toEqual(idle);
  });
  it("ignores untagged old end notifications for an identified live turn", () => {
    const state = { turnId: "new", running: true };
    expect(applyWorkbenchTurnEvent(state, event("turn/completed"))).toBe(state);
  });
  it.each(["turn/completed", "turn/interrupted", "turn/failed"])(
    "settles %s on the current turn",
    (method) => {
      expect(
        applyWorkbenchTurnEvent({ turnId: "new", running: true }, event(method, "new")),
      ).toEqual(idle);
    },
  );
  it("accepts nested provider turn identifiers", () => {
    expect(
      applyWorkbenchTurnEvent(idle, { method: "turn/started", params: { turn: { id: "nested" } } }),
    ).toEqual({ turnId: "nested", running: true });
  });
  it("ignores unrelated events", () => {
    expect(applyWorkbenchTurnEvent(idle, event("item/agentMessage/delta", "new"))).toBe(idle);
  });
});
