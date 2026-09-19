import { mkdtemp, writeFile, rm, cp, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vite-plus/test";
import { loadAgentOperations } from "./agent-operations.js";
import { fileURLToPath } from "node:url";

it("uses the configured product database for Pi worker authorization", async () => {
  const directory = await mkdtemp(join(tmpdir(), "glassbox-pi-ops-config-"));
  try {
    const data = join(directory, "data");
    const kit = join(directory, "kit");
    const agent = join(directory, "agent");
    const worker = join(directory, "worker");
    await Promise.all(
      [data, worker, join(agent, "extensions")].map((path) => mkdir(path, { recursive: true })),
    );
    await cp(fileURLToPath(new URL("../runtime/pi/fixtures/lora-pi-kit", import.meta.url)), kit, {
      recursive: true,
    });
    const profile = JSON.parse(await readFile(join(kit, "profiles/main-agent.json"), "utf8"));
    await writeFile(
      join(kit, "profiles/herdr-worker.json"),
      JSON.stringify({ ...profile, name: "herdr-worker" }),
    );
    await writeFile(join(agent, "extensions/herdr-agent-state.ts"), "// fixture");
    await writeFile(
      join(data, "agent-operations.json"),
      JSON.stringify({
        socketPath: join(directory, "herdr.sock"),
        sessionId: "test",
        workspaceId: "worker",
        agentKind: "pi",
        worktreePath: worker,
        pi: { kitPath: kit, agentDir: agent, provider: "fixture", model: "local" },
      }),
    );
    const databasePath = join(data, "custom.db");
    const operations = await loadAgentOperations(data, databasePath);
    expect(operations?.workerPolicy?.databasePath).toBe(databasePath);
    expect(operations?.protectedValues).toEqual(
      expect.arrayContaining(["test", "worker", worker, kit, agent, "fixture", "local"]),
    );
    await expect(loadAgentOperations(data, ":memory:")).rejects.toThrow(
      "persistent absolute database path",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("requires explicit local worker routing and rejects unknown or relative configuration", async () => {
  const directory = await mkdtemp(join(tmpdir(), "glassbox-ops-config-"));
  const file = join(directory, "agent-operations.json");
  try {
    expect(await loadAgentOperations(directory)).toBeUndefined();
    const config = {
      socketPath: join(directory, "herdr.sock"),
      sessionId: "integration",
      workspaceId: "isolated",
      agentKind: "codex",
      worktreePath: directory,
    };
    await writeFile(file, JSON.stringify(config));
    expect((await loadAgentOperations(directory))?.workerTarget).toMatchObject({
      workspaceId: "isolated",
      worktreePath: directory,
    });
    for (const invalid of [
      { ...config, worktreePath: "../other" },
      { ...config, command: "shell" },
      null,
    ]) {
      await writeFile(file, JSON.stringify(invalid));
      await expect(loadAgentOperations(directory)).rejects.toThrow(
        "Invalid agent operations configuration",
      );
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
