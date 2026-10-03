import path from "node:path";
import type { HarnessLayout } from "./layout.js";
import { HarnessFailure, type ClaudeCredentialEnvironment } from "./types.js";

const credentialKeys = new Set([
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
]);

export function createHarnessEnvironment(input: {
  layout: HarnessLayout;
  executablePath: string;
  credentials: ClaudeCredentialEnvironment;
  apiBaseUrl?: string;
  nodeExecutable?: string;
}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(input.credentials)) {
    if (
      !credentialKeys.has(key) ||
      typeof value !== "string" ||
      !value ||
      /[\r\n\0]/u.test(value)
    ) {
      throw new HarnessFailure("CREDENTIAL_UNAVAILABLE");
    }
    env[key] = value;
  }
  if (Object.keys(env).length !== 1) throw new HarnessFailure("CREDENTIAL_UNAVAILABLE");
  const { home, config, temp } = input.layout;
  env.PATH = [
    path.dirname(input.executablePath),
    path.dirname(input.nodeExecutable ?? process.execPath),
  ].join(":");
  Object.assign(env, {
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, ".config"),
    XDG_CACHE_HOME: path.join(home, ".cache"),
    XDG_DATA_HOME: path.join(home, ".local", "share"),
    CLAUDE_CONFIG_DIR: config,
    CLAUDE_CODE_ENTRYPOINT: "sdk-ts",
    TMPDIR: temp,
    TMP: temp,
    TEMP: temp,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: path.join(home, ".gitconfig"),
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
    CLAUDE_CODE_DISABLE_AGENT_VIEW: "1",
    CLAUDE_CODE_DISABLE_WORKFLOWS: "1",
    CLAUDE_CODE_DISABLE_BUNDLED_SKILLS: "1",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    DISABLE_AUTOUPDATER: "1",
    DISABLE_TELEMETRY: "1",
    DISABLE_ERROR_REPORTING: "1",
  });
  if (input.apiBaseUrl) {
    const url = new URL(input.apiBaseUrl);
    if (
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      (url.protocol !== "https:" &&
        !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))
    ) {
      throw new HarnessFailure("INVALID_INPUT");
    }
    env.ANTHROPIC_BASE_URL = url.href;
  }
  return env;
}
