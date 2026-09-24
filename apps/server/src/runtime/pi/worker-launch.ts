import { readFile, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { VERSION } from "@earendil-works/pi-coding-agent";
import { KitLoader } from "./kit-loader.js";

/** Trusted service configuration. None of these values are accepted from a model Tool. */
export async function piWorkerLaunch(input: {
  kitPath: string;
  agentDir: string;
  provider: string;
  model: string;
}) {
  if (
    !isAbsolute(input.kitPath) ||
    !isAbsolute(input.agentDir) ||
    ![input.provider, input.model].every(
      (value) =>
        typeof value === "string" &&
        value.length > 0 &&
        value.length < 200 &&
        !/[\r\n\0]/u.test(value),
    )
  ) {
    throw new Error("Invalid Pi worker configuration");
  }
  const loader = new KitLoader(input.kitPath);
  const herdrExtension = join(input.agentDir, "extensions", "herdr-agent-state.ts");
  if (!(await stat(herdrExtension)).isFile())
    throw new Error("Herdr Pi integration is not installed in the Worker agent directory");
  if (!loader.verifyCompatibility(VERSION).compatible)
    throw new Error("Incompatible Pi worker Kit");
  const runtimeEvidence = loader.runtimeEvidence("herdr-worker");
  const profile = loader.loadProfile("herdr-worker");
  if (profile.enabledMcpServers.length > 0)
    throw new Error("Pi Worker MCP requires an authorized Tool registration");
  const prompt = loader.modelPrompt("herdr-worker");
  return {
    kind: "pi",
    runtimeEvidence: {
      ...runtimeEvidence,
      provider: input.provider,
      model: input.model,
      herdrExtensionSha256: createHash("sha256")
        .update(await readFile(herdrExtension))
        .digest("hex"),
      toolNames: ["worker_read_file", "worker_write_file", "worker_list_files"],
    },
    env: {
      PI_CODING_AGENT_DIR: input.agentDir,
      PI_TELEMETRY: "0",
      GLASSBOX_WORKER_SYSTEM_PROMPT: prompt,
    },
    args: [
      "--provider",
      input.provider,
      "--model",
      input.model,
      "--no-approve",
      "--offline",
      "--no-extensions",
      "--no-skills",
      "--no-context-files",
      "--no-prompt-templates",
      "--no-themes",
      "--system-prompt",
      prompt.replace(/\s+/gu, " "),
      "--thinking",
      profile.thinkingLevel === "none" ? "off" : profile.thinkingLevel,
      "--no-tools",
      "--tools",
      "worker_read_file,worker_write_file,worker_list_files",
      "--extension",
      herdrExtension,
      ...profile.enabledExtensions
        // Glassbox's existing Worker path has its own authorized file tools. The
        // Kit sandbox extension requires a trusted workspace lease and must not
        // be loaded by this path until Herdr shares that lease with the main Agent.
        .filter((name) => name !== "mcp/tool-adapter" && name !== "core/sandbox-tools")
        .flatMap((name) => ["--extension", join(input.kitPath, "extensions", `${name}.ts`)]),
      ...profile.enabledSkills.flatMap((name) => ["--skill", join(input.kitPath, "skills", name)]),
      "--extension",
      fileURLToPath(
        new URL(
          import.meta.url.endsWith(".ts")
            ? "./worker-tools-extension.ts"
            : "./worker-tools-extension.js",
          import.meta.url,
        ),
      ),
    ],
  };
}
