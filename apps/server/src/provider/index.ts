import { CodexAdapter } from "../codex/adapter.js";
import { ClaudeCodeAdapter } from "../claude-code/adapter.js";
import type { ProviderAdapter } from "./types.js";

export function createAdapter(provider: "codex" | "claude-code"): ProviderAdapter {
  switch (provider) {
    case "codex":
      return new CodexAdapter();
    case "claude-code":
      return new ClaudeCodeAdapter();
  }
}
