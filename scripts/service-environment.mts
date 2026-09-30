export const persistedEnvironmentKeys = new Set([
  "PORT",
  "LORA_PI_KIT_PATH",
  "GLASSBOX_SANDBOX_IMAGE",
  "GLASSBOX_SANDBOX_DNS_MODE",
  "GLASSBOX_RUNTIME_DIR",
  "PI_CODING_AGENT_DIR",
  "GLASSBOX_REPO_ROOT",
  "GLASSBOX_WORKSPACE_CODEX",
  "GLASSBOX_WORKSPACE_CLAUDE",
  "GLASSBOX_WORKSPACE_DEMO",
  "NAPCAT_DISABLE_MULTI_PROCESS",
  "NAPCAT_INJECT_PATH",
  "NAPCAT_WORKDIR",
  "NAPCAT_LOAD_PATH",
  "NAPCAT_MAIN_PATH",
  "NAPCAT_PATCH_PACKAGE",
  "NAPCAT_LAUNCHER_PATH",
  "NAPCAT_QUICK_ACCOUNT",
]);

export const ephemeralEnvironmentKeys = new Set(["AGNES_API_KEY"]);
const sensitiveEnvironmentName = /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/iu;
for (const key of persistedEnvironmentKeys) {
  if (sensitiveEnvironmentName.test(key))
    throw new Error(`Credential key cannot be persisted: ${key}`);
}

export const serviceEnvironmentKeys = new Set([
  ...persistedEnvironmentKeys,
  ...ephemeralEnvironmentKeys,
]);

export function persistedEnvironment(env: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter(
      ([key]) => persistedEnvironmentKeys.has(key) && !sensitiveEnvironmentName.test(key),
    ),
  );
}
