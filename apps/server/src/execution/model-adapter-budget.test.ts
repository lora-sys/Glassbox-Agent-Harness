import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "vite-plus/test";
import { ModelProfileStore } from "../config/model-profiles.js";
import { configuredModelAdapter } from "./model-adapter.js";
import type { ModelAgentEvent } from "./model-agent/index.js";
import type { ExecutionInput } from "./run-service/types.js";

it("fails closed before model construction when configured capacity is unknown", async () => {
  const directory = await mkdtemp(join(tmpdir(), "glassbox-model-unknown-capacity-"));
  try {
    const profiles = await ModelProfileStore.open(directory);
    await profiles.save({
      id: "unknown",
      label: "Unknown capacity",
      protocol: "openai-completions",
      model: "fixture",
      baseUrl: "http://127.0.0.1:1/v1",
    });
    const events: ModelAgentEvent[] = [];
    const result = await configuredModelAdapter({
      profiles,
      profileId: "unknown",
      onEvent: (_runId, event) => {
        events.push(event);
      },
    }).execute({
      text: "do not send",
      history: [],
      run: { id: "run-unknown-capacity" },
      signal: new AbortController().signal,
    } as unknown as ExecutionInput);

    expect(result).toEqual({ status: "failed", failureCode: "model_capacity_unknown" });
    expect(events).toEqual([
      { type: "model_capacity", state: "unknown", reasonCode: "capacity_unknown" },
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("fails before a provider call when the authorized current message exceeds model capacity", async () => {
  const directory = await mkdtemp(join(tmpdir(), "glassbox-model-budget-"));
  try {
    const profiles = await ModelProfileStore.open(directory);
    await profiles.save({
      id: "bounded",
      label: "Bounded",
      protocol: "openai-completions",
      model: "fixture",
      baseUrl: "http://127.0.0.1:1/v1",
      contextWindowTokens: 8192,
      maxOutputTokens: 4096,
    });
    const events: ModelAgentEvent[] = [];
    const adapter = configuredModelAdapter({
      profiles,
      profileId: "bounded",
      onEvent: (_runId, event) => {
        events.push(event);
      },
    });
    const result = await adapter.execute({
      text: "中".repeat(5000),
      history: [],
      run: { id: "run-budget" },
      signal: new AbortController().signal,
    } as unknown as ExecutionInput);
    expect(result.status).toBe("failed");
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "context_budget",
        overflow: "fixed_floor_exceeds_capacity",
        omittedExchanges: 0,
      }),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
