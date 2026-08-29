import { describe, it } from "vitest";
import { CodexAdapter } from "./adapter.js";

describe("CodexAdapter direct", () => {
  it("initialize responds", async () => {
    const adapter = new CodexAdapter();
    adapter.start();
    const result = await adapter.initialize();
    console.log("INIT RESULT:", JSON.stringify(result).slice(0, 100));
    adapter.stop();
  }, 60000);
});
