import { describe, expect, it, vi } from "vite-plus/test";
import {
  clearManagementAccess,
  managementFetch,
  readManagementAccess,
  saveManagementAccess,
} from "./access";

const token = "a".repeat(43);
function storage() {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
  };
}

describe("tab-scoped management access", () => {
  it("writes only one management credential and removes it on disconnect", () => {
    const tab = storage();
    saveManagementAccess(token, tab);
    expect(readManagementAccess(tab)).toBe(token);
    expect([...tab.values.entries()]).toEqual([["glassbox:management-access", token]]);
    clearManagementAccess(undefined, tab);
    expect(readManagementAccess(tab)).toBeNull();
    expect(tab.values.size).toBe(0);
  });
  it("does not let a stale unauthorized response erase a replacement token", () => {
    const tab = storage();
    const replacement = "b".repeat(43);
    saveManagementAccess(replacement, tab);
    clearManagementAccess(token, tab);
    expect(readManagementAccess(tab)).toBe(replacement);
    clearManagementAccess(replacement, tab);
    expect(readManagementAccess(tab)).toBeNull();
  });
  it("fails explicitly when session storage is unavailable", () => {
    expect(() => saveManagementAccess(token, null)).toThrow(/会话存储/u);
    expect(readManagementAccess(null)).toBeNull();
  });
  it("rejects invalid stored credentials", () => {
    const tab = storage();
    tab.setItem("glassbox:management-access", "not-a-management-credential");
    expect(readManagementAccess(tab)).toBeNull();
  });
});

describe("authenticated same-origin fetch", () => {
  it("overwrites caller authorization with the shared management token", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response("{}"));
    await managementFetch(
      "/api/state/session-1",
      { headers: { Authorization: "wrong", "content-type": "application/json" } },
      { token, fetch },
    );
    const init = fetch.mock.calls[0]?.[1];
    expect(new Headers(init?.headers).get("Authorization")).toBe(`Bearer ${token}`);
    expect(new Headers(init?.headers).get("content-type")).toBe("application/json");
    expect(init?.redirect).toBe("error");
    expect(fetch.mock.calls[0]?.[0]).not.toContain(token);
  });
  it.each([
    "https://example.test/api/state",
    "//example.test/api/state",
    "/api/state/../manage",
    "/api/state/%2e%2e",
    "/api/state?token=secret",
  ])("rejects unsafe request paths before exposing a credential", async (path) => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    await expect(managementFetch(path, {}, { token, fetch })).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
    expect(fetch).not.toHaveBeenCalled();
  });
  it("rejects missing access without making a request", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    await expect(
      managementFetch("/api/trace/session-1", {}, { token: null, fetch }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each([
    [401, "UNAUTHORIZED"],
    [403, "FORBIDDEN"],
  ] as const)("maps HTTP %s to fixed safe errors", async (status, code) => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(new Response(`private ${token}`, { status }));
    await expect(
      managementFetch("/api/trace/session-1", {}, { token, fetch }),
    ).rejects.toMatchObject({ code });
  });
});
