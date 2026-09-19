import { randomUUID } from "node:crypto";
import type { OpsTraceCapture } from "./task-store.js";

export interface ModelInjectionResponse {
  content: string;
  toolCalls?: Array<{
    name: string;
    arguments: Record<string, unknown>;
  }>;
}

export interface FakeRuntimeTurnInput {
  prompt: string;
  conversationId?: string;
  principalId?: string;
  injectedResponse?: ModelInjectionResponse;
}

export interface FakeRuntimeTurnOutput {
  runId: string;
  content: string;
  toolCalls?: Array<{
    name: string;
    arguments: Record<string, unknown>;
  }>;
}

/**
 * P3.0 Fake Runtime with Model Injection and Trace Capture.
 * Provides a deterministic simulator for P3.0 test harness.
 * Accurately scoped to P3.0 contracts and harness tests, without
 * misrepresenting complete P3.2/P3.4 Pi SDK runtime or four-gate production chain.
 */
export class FakeRuntime {
  private injectedQueue: ModelInjectionResponse[] = [];
  private defaultResponse: ModelInjectionResponse = {
    content: "Deterministic simulated model response",
  };

  constructor(private readonly trace?: OpsTraceCapture) {}

  queueInjectedResponse(response: ModelInjectionResponse): void {
    this.injectedQueue.push(response);
  }

  setDefaultResponse(response: ModelInjectionResponse): void {
    this.defaultResponse = response;
  }

  async runTurn(input: FakeRuntimeTurnInput): Promise<FakeRuntimeTurnOutput> {
    const runId = `run-${randomUUID().slice(0, 8)}`;
    const response = input.injectedResponse ?? this.injectedQueue.shift() ?? this.defaultResponse;

    if (this.trace) {
      this.trace.append({
        type: "runtime.turn",
        runId,
        principalId: input.principalId,
        data: {
          prompt: input.prompt,
          conversationId: input.conversationId,
          content: response.content,
          toolCalls: response.toolCalls,
        },
      });
    }

    return {
      runId,
      content: response.content,
      toolCalls: response.toolCalls,
    };
  }
}
