import type { IncomingMessage } from "node:http";
import { isAbsolute, resolve } from "node:path";
import { Readable } from "node:stream";
import { describe, expect, it } from "vite-plus/test";
import { ManagementError } from "./access.js";
import { routeManagementRequest, type ManagementRouteDependencies } from "./routes.js";

function request(method: string, url: string, body?: unknown): IncomingMessage {
  const stream = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
  return Object.assign(stream, {
    method,
    url,
    headers: body === undefined ? {} : { "content-type": "application/json" },
  }) as IncomingMessage;
}

type TestDependencies = ManagementRouteDependencies & { calls: Array<[string, unknown]> };

function dependencies(): TestDependencies {
  const calls: Array<[string, unknown]> = [];
  return {
    calls,
    sandboxStatus: () => ({ ready: false, reason: "not installed" }),
    listWorkspaces: async (value: string) => {
      calls.push(["list", value]);
      return [{ id: "default-abc" }];
    },
    registerWorkspace: async (value: unknown) => {
      calls.push(["register", value]);
      return { id: "workspace-created" };
    },
    grantWorkspace: async (value: unknown) => {
      calls.push(["grant", value]);
      return { granted: true };
    },
    revokeWorkspace: async (value: unknown) => {
      calls.push(["revoke", value]);
      return { revoked: true };
    },
    selectWorkspace: async (value: unknown) => {
      calls.push(["select", value]);
      return { selected: true };
    },
  } as unknown as TestDependencies;
}

const id = `workspace-${"a".repeat(36)}`;

describe("workspace management routes", () => {
  it("returns sandbox status and principal-scoped workspace list", async () => {
    const deps = dependencies();
    expect(await routeManagementRequest(request("GET", "/manage/sandbox"), deps)).toEqual({
      status: 200,
      body: { sandbox: { ready: false, reason: "not installed" } },
    });
    expect(
      await routeManagementRequest(request("GET", "/manage/workspaces?principalId=owner-a"), deps),
    ).toEqual({ status: 200, body: { workspaces: [{ id: "default-abc" }] } });
    expect(deps.calls).toEqual([["list", "owner-a"]]);
  });

  it("passes validated and narrowed registration, grant, revoke, and selection inputs", async () => {
    const deps = dependencies();
    const project = resolve("some-project");
    expect(isAbsolute(project)).toBe(true);
    await routeManagementRequest(
      request("POST", "/manage/workspaces/register", {
        path: project,
        label: " Project ",
        ownerPrincipalId: "owner-a",
        ignored: "no",
      }),
      deps,
    );
    expect(deps.calls[0]).toEqual([
      "register",
      {
        path: project,
        label: "Project",
        ownerPrincipalId: "owner-a",
      },
    ]);
    await routeManagementRequest(
      request("POST", "/manage/workspaces/grant", {
        workspaceId: id,
        principalId: "owner-b",
        access: "read",
        ignored: true,
      }),
      deps,
    );
    expect(deps.calls[1]).toEqual([
      "grant",
      { workspaceId: id, principalId: "owner-b", access: "read" },
    ]);
    await routeManagementRequest(
      request("POST", "/manage/workspaces/revoke", {
        workspaceId: id,
        principalId: "owner-b",
      }),
      deps,
    );
    expect(deps.calls[2]).toEqual(["revoke", { workspaceId: id, principalId: "owner-b" }]);
    await routeManagementRequest(
      request("POST", "/manage/workspaces/select", {
        workspaceId: id,
        principalId: "owner-a",
      }),
      deps,
    );
    expect(deps.calls[3]).toEqual(["select", { workspaceId: id, principalId: "owner-a" }]);
  });

  it("rejects malformed identifiers and host paths before calling dependencies", async () => {
    const deps = dependencies();
    await expect(
      routeManagementRequest(request("GET", "/manage/workspaces?principalId=..%2F"), deps),
    ).rejects.toBeInstanceOf(ManagementError);
    await expect(
      routeManagementRequest(
        request("POST", "/manage/workspaces/register", {
          path: "relative/path",
          label: "Project",
          ownerPrincipalId: "owner-a",
        }),
        deps,
      ),
    ).rejects.toBeInstanceOf(ManagementError);
    await expect(
      routeManagementRequest(
        request("POST", "/manage/workspaces/grant", {
          workspaceId: "../../other",
          principalId: "owner-a",
          access: "write",
        }),
        deps,
      ),
    ).rejects.toBeInstanceOf(ManagementError);
    await expect(
      routeManagementRequest(
        request("POST", "/manage/workspaces/select", {
          workspaceId: id,
          principalId: "owner a",
        }),
        deps,
      ),
    ).rejects.toBeInstanceOf(ManagementError);
    expect(deps.calls).toEqual([]);
  });
});
