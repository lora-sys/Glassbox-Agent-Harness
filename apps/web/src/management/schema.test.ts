import { describe, expect, it } from "vite-plus/test";
import {
  buildModelSave,
  decodeDoctor,
  decodeModelList,
  decodeStatus,
  emptyModelDraft,
} from "./schema";

const profile = {
  id: "daily",
  label: "Daily",
  protocol: "openai-completions" as const,
  baseUrl: "https://api.example.test/v1",
  model: "example-model",
  credentialConfigured: true,
};
const status = {
  service: "glassbox",
  version: "0.0.0",
  status: "ready",
  platform: "win32",
  defaultExecution: "claude-code",
  capabilities: {
    modelConfiguration: true,
    channels: false,
    conversations: false,
    runs: false,
    trace: false,
    eval: false,
  },
};
const draft = {
  ...emptyModelDraft(),
  id: profile.id,
  label: profile.label,
  protocol: profile.protocol,
  baseUrl: profile.baseUrl,
  model: profile.model,
};

describe("management response boundaries", () => {
  it("keeps only supported public service fields", () => {
    expect(decodeStatus({ ...status, paths: ["private-server-path"] })).toEqual(status);
  });
  it.each([
    null,
    {},
    { ...status, status: "pretend-ready" },
    { ...status, capabilities: { ...status.capabilities, channels: "true" } },
  ])("rejects incomplete or misleading status responses", (input) => {
    expect(() => decodeStatus(input)).toThrow();
  });
  it("rejects secret-bearing, duplicate or malformed model profiles", () => {
    for (const profiles of [
      [{ ...profile, apiKey: "secret" }],
      [profile, profile],
      [{ ...profile, credentialConfigured: "yes" }],
      [{ ...profile, baseUrl: "https://user:secret@example.test" }],
    ]) {
      expect(() => decodeModelList({ profiles })).toThrow();
    }
  });
  it("does not equate detected executables with successful execution", () => {
    const checks = [
      {
        id: "claude",
        label: "Claude Code",
        status: "detected",
        message: "Executable found. Login and execution were not tested.",
      },
    ];
    expect(decodeDoctor({ checks })).toEqual(checks);
    expect(() => decodeDoctor({ checks: [{ ...checks[0], status: "connected" }] })).toThrow();
  });
});

describe("model draft serialization", () => {
  it("omits a blank key so the server preserves its saved credential", () => {
    const input = buildModelSave(draft, profile);
    expect(input).not.toHaveProperty("apiKey");
    expect(input).not.toHaveProperty("credentialConfigured");
    expect(input).not.toHaveProperty("clearApiKey");
  });
  it("sends an explicit replacement or clear", () => {
    expect(buildModelSave({ ...draft, apiKey: " new-secret " }, profile).apiKey).toBe("new-secret");
    expect(buildModelSave({ ...draft, clearApiKey: true }, profile).apiKey).toBeNull();
  });
  it("requires an explicit credential decision before changing origins", () => {
    const changed = { ...draft, baseUrl: "https://different.example.test/v1" };
    expect(() => buildModelSave(changed, profile)).toThrow(/替换或清除/u);
    expect(buildModelSave({ ...changed, clearApiKey: true }, profile).apiKey).toBeNull();
    expect(
      buildModelSave({ ...draft, baseUrl: "https://api.example.test/v2" }, profile),
    ).not.toHaveProperty("apiKey");
  });
  it.each([
    { ...draft, id: "../outside" },
    { ...draft, label: "" },
    { ...draft, apiKey: "secret", clearApiKey: true },
    { ...draft, apiKey: "line1\nline2" },
    { ...draft, baseUrl: "http://public.example.test" },
    { ...draft, baseUrl: "https://api.example.test?key=secret" },
  ])("rejects invalid drafts before a request", (input) => {
    expect(() => buildModelSave(input, profile)).toThrow();
  });
});
