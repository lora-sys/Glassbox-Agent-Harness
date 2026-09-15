// Codex 0.154.0 configuration and protocol adaptation. See codex-SOURCES.md.
import path from "node:path";
import { HarnessFailure } from "./types.js";

export const CODEX_DISABLED_FEATURES = [
  "shell_tool",
  "unified_exec",
  "shell_snapshot",
  "shell_snapshot_v2",
  "apply_patch_freeform",
  "multi_agent",
  "multi_agent_v2",
  "multi_agent_mode",
  "collab",
  "collaboration_modes",
  "hooks",
  "codex_hooks",
  "plugin_hooks",
  "plugins",
  "remote_plugin",
  "recommended_plugins",
  "apps",
  "connectors",
  "enable_mcp_apps",
  "skill_search",
  "skill_mcp_dependency_install",
  "skill_env_var_dependency_prompt",
  "memories",
  "memory_tool",
  "external_agent_memory_import",
  "external_migration",
  "browser_use",
  "computer_use",
  "in_app_browser",
  "image_generation",
  "imagegenext",
  "web_search",
  "web_search_cached",
  "web_search_request",
  "standalone_web_search",
  "request_permissions",
  "request_permissions_tool",
  "tool_search",
  "tool_suggest",
  "code_mode",
  "js_repl",
  "js_repl_tools_only",
  "view_image",
  "goals",
  "remote_control",
  "worktrees",
  "workspace_dependencies",
  "in_app_local_automation",
  "search_tool",
  "send_async_message",
] as const;

/** Every value is also checked through config/read before authentication or thread creation. */
export function codexOverrides(): Record<string, unknown> {
  return {
    approval_policy: "never",
    sandbox_mode: "read-only",
    cli_auth_credentials_store: "ephemeral",
    check_for_update_on_startup: false,
    project_doc_max_bytes: 0,
    project_doc_fallback_filenames: [],
    instructions: "",
    developer_instructions: "",
    include_apps_instructions: false,
    include_collaboration_mode_instructions: false,
    include_environment_context: false,
    allow_login_shell: false,
    web_search: "disabled",
    "skills.bundled.enabled": false,
    "skills.include_instructions": false,
    "agents.enabled": false,
    "memories.use_memories": false,
    "memories.generate_memories": false,
    "memories.dedicated_tools": false,
    "shell_environment_policy.inherit": "none",
    "shell_environment_policy.experimental_use_profile": false,
    "history.persistence": "none",
    "analytics.enabled": false,
    "feedback.enabled": false,
    "features.skip_host_skill_discovery": true,
    ...Object.fromEntries(CODEX_DISABLED_FEATURES.map((key) => [`features.${key}`, false])),
  };
}

export function codexLaunchArgs(): string[] {
  return [
    "--strict-config",
    ...Object.entries(codexOverrides()).flatMap(([key, value]) => [
      "--config",
      `${key}=${JSON.stringify(value)}`,
    ]),
  ];
}

export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new HarnessFailure("ISOLATION_VIOLATION");
  return value as Record<string, unknown>;
}

export function verifyCodexConfig(response: unknown, home: string): void {
  const root = record(response);
  const config = record(root.config);
  if (!Array.isArray(root.layers)) throw new HarnessFailure("ISOLATION_VIOLATION");
  for (const layerValue of root.layers) {
    const layer = record(layerValue);
    if (typeof layer.disabledReason === "string" && layer.disabledReason) continue;
    const name = record(layer.name);
    if (name.type === "sessionFlags") continue;
    if (name.type === "user" && name.file === path.join(home, "config.toml")) continue;
    // System and project defaults can contain instructions or commands. Empty layers are inert.
    if (Object.keys(record(layer.config)).length > 0)
      throw new HarnessFailure("ISOLATION_VIOLATION");
  }
  for (const [key, expected] of Object.entries(codexOverrides())) {
    let actual: unknown = config;
    for (const segment of key.split(".")) actual = record(actual)[segment];
    if (JSON.stringify(actual) !== JSON.stringify(expected))
      throw new HarnessFailure("ISOLATION_VIOLATION");
  }
  for (const key of ["mcp_servers", "plugins", "hooks", "model_providers"]) {
    if (config[key] !== undefined && Object.keys(record(config[key])).length)
      throw new HarnessFailure("ISOLATION_VIOLATION");
  }
  for (const key of [
    "notify",
    "model_instructions_file",
    "experimental_compact_prompt_file",
    "profile",
  ]) {
    if (config[key] != null) throw new HarnessFailure("ISOLATION_VIOLATION");
  }
}

export function createCodexEnvironment(input: {
  home: string;
  workspace: string;
  temp: string;
  executablePath: string;
  hostEnvironment?: Readonly<Record<string, string | undefined>>;
  platform?: NodeJS.Platform;
}): Record<string, string> {
  const platform = input.platform ?? process.platform;
  const paths = platform === "win32" ? path.win32 : path.posix;
  const systemRoot = input.hostEnvironment?.SystemRoot ?? input.hostEnvironment?.SYSTEMROOT;
  if (platform === "win32" && (!systemRoot || !paths.isAbsolute(systemRoot)))
    throw new HarnessFailure("INVALID_INPUT");
  return {
    ...(platform === "win32" ? { SystemRoot: systemRoot!, WINDIR: systemRoot! } : {}),
    PATH: [
      paths.dirname(input.executablePath),
      paths.dirname(process.execPath),
      ...(platform === "win32" ? [paths.join(systemRoot!, "System32")] : []),
    ].join(platform === "win32" ? ";" : ":"),
    HOME: input.home,
    USERPROFILE: input.home,
    CODEX_HOME: input.home,
    APPDATA: paths.join(input.home, "AppData", "Roaming"),
    LOCALAPPDATA: paths.join(input.home, "AppData", "Local"),
    XDG_CONFIG_HOME: paths.join(input.home, ".config"),
    XDG_DATA_HOME: paths.join(input.home, ".local", "share"),
    XDG_CACHE_HOME: paths.join(input.home, ".cache"),
    TMP: input.temp,
    TEMP: input.temp,
    TMPDIR: input.temp,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: paths.join(input.home, ".gitconfig"),
    CODEX_DISABLE_UPDATE_CHECK: "1",
  };
}
