import type { ProviderEnv } from "../types.ts";

// Glassbox credentials and settings are scoped by the trusted caller. Never discover host environment.
export function getProviderEnvValue(name: string, env?: ProviderEnv): string | undefined {
  return env?.[name] || undefined;
}
