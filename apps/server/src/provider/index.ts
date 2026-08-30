import { CodexAdapter } from "../codex/adapter.js";
import type { ProviderAdapter } from "./types.js";

export function createAdapter(provider: "codex" | "claude-code"): ProviderAdapter {
  switch (provider) {
    case "codex":
      return new CodexAdapter();
    case "claude-code":
      throw new Error("claude-code adapter not yet implemented (P2.2)");
  }
}
