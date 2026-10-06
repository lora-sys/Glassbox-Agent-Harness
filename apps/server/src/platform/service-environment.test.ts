import { describe, expect, it } from "vite-plus/test";
import {
  ephemeralEnvironmentKeys,
  persistedEnvironment,
  persistedEnvironmentKeys,
  serviceEnvironmentKeys,
} from "../../../../scripts/service-environment.mjs";

describe("service state environment", () => {
  it("permits the runtime API key but never persists it", () => {
    expect(serviceEnvironmentKeys.has("AGNES_API_KEY")).toBe(true);
    expect(ephemeralEnvironmentKeys.has("AGNES_API_KEY")).toBe(true);
    expect(persistedEnvironmentKeys.has("AGNES_API_KEY")).toBe(false);
    expect(
      persistedEnvironment({ PORT: "3030", AGNES_API_KEY: "secret", UNKNOWN_TOKEN: "secret" }),
    ).toEqual({ PORT: "3030" });
  });

  it("preserves the opt-in environment proxy flag across service switches", () => {
    const proxy = new URL("http://proxy");
    proxy.username = "fixture-user";
    proxy.password = "fixture-password";
    expect(serviceEnvironmentKeys.has("NODE_USE_ENV_PROXY")).toBe(true);
    expect(persistedEnvironment({ NODE_USE_ENV_PROXY: "1", HTTPS_PROXY: proxy.href })).toEqual({
      NODE_USE_ENV_PROXY: "1",
    });
  });

  it("keeps credential-like names out of the persisted allowlist", () => {
    for (const key of persistedEnvironmentKeys)
      expect(key).not.toMatch(/KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/iu);
  });
});
