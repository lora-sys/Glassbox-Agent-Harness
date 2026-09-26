import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vite-plus/test";
import { piWorkerLaunch } from "./worker-launch.js";

it("launches Pi with explicit Kit resources and disables ambient resource discovery", async () => {
  const directory = await mkdtemp(join(tmpdir(), "glassbox-worker-launch-"));
  try {
    await cp(fileURLToPath(new URL("./fixtures/lora-pi-kit", import.meta.url)), directory, {
      recursive: true,
    });
    const profile = JSON.parse(await readFile(join(directory, "profiles/main-agent.json"), "utf8"));
    await writeFile(
      join(directory, "profiles/herdr-worker.json"),
      JSON.stringify({
        ...profile,
        name: "herdr-worker",
        enabledExtensions: [...profile.enabledExtensions, "core/sandbox-tools"],
      }),
    );
    await mkdir(join(directory, "extensions/core"), { recursive: true });
    await writeFile(join(directory, "extensions/core/sandbox-tools.ts"), "// Kit fixture");
    const input = {
      kitPath: directory,
      agentDir: join(directory, "isolated-agent"),
      provider: "fixture",
      model: "local",
    };
    await mkdir(join(input.agentDir, "extensions"), { recursive: true });
    await writeFile(join(input.agentDir, "extensions/herdr-agent-state.ts"), "// test fixture");
    const launch = await piWorkerLaunch(input);
    expect(launch.kind).toBe("pi");
    expect(launch.runtimeEvidence).toMatchObject({
      profileName: "herdr-worker",
      provider: "fixture",
      model: "local",
    });
    expect(launch.runtimeEvidence.herdrExtensionSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(launch.env.PI_CODING_AGENT_DIR).toBe(input.agentDir);
    expect(launch.args).toContain(join(input.agentDir, "extensions/herdr-agent-state.ts"));
    for (const flag of [
      "--no-approve",
      "--no-skills",
      "--no-context-files",
      "--no-extensions",
      "--no-tools",
    ])
      expect(launch.args).toContain(flag);
    expect(launch.args.every((value) => !/[\r\n]/u.test(value))).toBe(true);
    expect(launch.args[launch.args.indexOf("--tools") + 1]).toBe(
      "worker_read_file,worker_write_file,worker_list_files",
    );
    expect(launch.args).toContain(
      fileURLToPath(new URL("./worker-tools-extension.ts", import.meta.url)),
    );
    expect(launch.args).not.toContain(join(directory, "extensions/core/sandbox-tools.ts"));
    await expect(piWorkerLaunch({ ...input, agentDir: "relative" })).rejects.toThrow(
      "Invalid Pi worker configuration",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
