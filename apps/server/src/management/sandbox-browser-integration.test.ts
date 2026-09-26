import { mkdtemp, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vite-plus/test";
import type { BrowserExecutorPort } from "../web/browser-executor-port.js";
import type { BrowserSessionBinding } from "../web/browser-session.js";
import type { IsolatedPiSession } from "../runtime/pi/sandbox-pi-tools.js";
import type { PiRunContext } from "../runtime/pi/types.js";
import { createApplicationFixtureScope } from "./application-test-helpers.js";

const { fixture, afterEachCleanup } = createApplicationFixtureScope();
const directories: string[] = [];
afterEach(async () => {
  await afterEachCleanup();
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

function openHarness(app: unknown) {
  return app as {
    sandboxRuntime: {
      executor: {
        openSession(input: {
          sessionId: string;
          workspacePath: string;
          writable: boolean;
          policyVersion: string;
          network: "none" | "public_web";
        }): Promise<IsolatedPiSession>;
        close(): Promise<void>;
      };
      availableTools: ReadonlySet<string>;
      cliAvailable: boolean;
      image: string;
    };
    kitBrowserExecutor: BrowserExecutorPort;
    sandboxRuns: Map<
      string,
      {
        session: IsolatedPiSession;
        principalId: string;
        workspaceId: string;
        browserEnabled: boolean;
      }
    >;
    getOrCreateDefaultPiAdapter(profileId: string): {
      runtime: {
        options: {
          openSandboxToolSession?: (input: {
            context: PiRunContext;
            selectedNames: readonly string[];
          }) => Promise<{ tools: Array<{ name: string }>; close(): Promise<void> }>;
        };
      };
    };
  };
}

function fakeSession() {
  const closeSpy = vi.fn(async () => undefined);
  return {
    closeSpy,
    session: {
      sessionId: "kit-session",
      toolDefinitions: [
        { name: "read", description: "read", parameters: {}, available: true },
        { name: "bash", description: "bash", parameters: {}, available: true },
      ],
      execute: vi.fn(async () => ({ content: [{ type: "text" as const, text: "ok" }] })),
      executeCli: vi.fn(async () => ({ content: [{ type: "text" as const, text: "ok" }] })),
      cancel: vi.fn(async () => undefined),
      close: closeSpy,
    } satisfies IsolatedPiSession,
  };
}

async function runContext(f: Awaited<ReturnType<typeof fixture>>) {
  f.send(901, "sandbox fixture", true);
  const input = await f.started.take();
  await f.reply("sandbox fixture");
  return {
    caller: input.caller,
    conversationId: input.conversation.id,
    runId: input.run.id,
  } satisfies PiRunContext;
}

function installSandbox(app: unknown, session: IsolatedPiSession) {
  const harness = openHarness(app);
  const openInputs: Array<Parameters<typeof harness.sandboxRuntime.executor.openSession>[0]> = [];
  const openSession = vi.fn(
    async (input: Parameters<typeof harness.sandboxRuntime.executor.openSession>[0]) => {
      openInputs.push(input);
      return session;
    },
  );
  harness.sandboxRuntime = {
    executor: { openSession, close: vi.fn(async () => undefined) },
    availableTools: new Set(["read", "bash"]),
    cliAvailable: true,
    image: "sha256:test",
  };
  harness.kitBrowserExecutor = {
    open: vi.fn(async () => ({
      execute: vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
      cancel: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
    })),
  };
  const openSandboxToolSession =
    harness.getOrCreateDefaultPiAdapter("sandbox-test").runtime.options.openSandboxToolSession;
  if (!openSandboxToolSession) throw new Error("Application did not wire the sandbox callback");
  return { harness, openSandboxToolSession, openSession, openInputs };
}

it("opens a read-only public web scratch session and binds it to the Run", async () => {
  const f = await fixture(async (input) => ({ status: "succeeded", text: input.text }));
  const context = await runContext(f);
  const { session, closeSpy } = fakeSession();
  const { harness, openSandboxToolSession, openInputs } = installSandbox(f.app, session);

  const sandbox = await openSandboxToolSession({ context, selectedNames: ["browser"] });
  const opened = openInputs[0]!;
  const binding: BrowserSessionBinding = {
    runId: context.runId!,
    principalId: context.caller!.principalId,
    conversationId: context.conversationId!,
    workspaceId: `web-${context.runId}`,
    policyVersion: "workspace-sandbox-v1",
  };

  expect(opened).toMatchObject({ writable: false, network: "public_web" });
  expect(await stat(opened.workspacePath)).toBeTruthy();
  expect(harness.sandboxRuns.get(binding.runId)).toMatchObject({
    session,
    principalId: binding.principalId,
    workspaceId: binding.workspaceId,
    browserEnabled: true,
  });
  expect(f.app.workspaceWrites.status(`browser-${binding.runId}`)).toBe("active");

  await sandbox.close();
  expect(closeSpy).toHaveBeenCalledOnce();
  await expect(stat(opened.workspacePath)).rejects.toMatchObject({ code: "ENOENT" });
  expect(harness.sandboxRuns.has(binding.runId)).toBe(false);
  expect(f.app.workspaceWrites.status(`browser-${binding.runId}`)).toBe("free");
});

it("uses one Kit session for workspace tools and browser", async () => {
  const f = await fixture(async (input) => ({ status: "succeeded", text: input.text }));
  const context = await runContext(f);
  const directory = await mkdtemp(join(tmpdir(), "glassbox-shared-sandbox-"));
  directories.push(directory);
  const registered = await f.app.registerWorkspace({
    path: directory,
    label: "Disposable integration workspace",
    ownerPrincipalId: context.caller!.principalId,
  });
  const { session } = fakeSession();
  const { harness, openSandboxToolSession, openInputs } = installSandbox(f.app, session);

  const sandbox = await openSandboxToolSession({
    context: { ...context, workspaceId: registered.id },
    selectedNames: ["read", "bash", "browser"],
  });

  expect(openInputs[0]!).toMatchObject({
    writable: true,
    network: "public_web",
  });
  expect(await realpath(openInputs[0]!.workspacePath)).toBe(await realpath(directory));
  expect(sandbox.tools.map((tool) => tool.name)).toEqual(["read", "bash"]);
  expect(harness.sandboxRuns.get(context.runId!)?.session).toBe(session);
  expect(harness.sandboxRuns.get(context.runId!)?.workspaceId).toBe(registered.id);
  await sandbox.close();
});

it("fails closed when opening the Kit sandbox fails", async () => {
  const f = await fixture(async (input) => ({ status: "succeeded", text: input.text }));
  const context = await runContext(f);
  const { session, closeSpy } = fakeSession();
  const { harness, openSandboxToolSession, openSession } = installSandbox(f.app, session);
  const failure = new Error("docker failed");
  openSession.mockRejectedValueOnce(failure);

  await expect(openSandboxToolSession({ context, selectedNames: ["browser"] })).rejects.toBe(
    failure,
  );
  expect(harness.sandboxRuns.has(context.runId!)).toBe(false);
  expect(f.app.workspaceWrites.status(`browser-${context.runId}`)).toBe("quarantined");
  expect(closeSpy).not.toHaveBeenCalled();
  expect(openSession.mock.calls[0]![0]).toMatchObject({
    writable: false,
    network: "public_web",
  });
});

it("rejects an unbound non-browser sandbox before opening a session", async () => {
  const f = await fixture(async (input) => ({ status: "succeeded", text: input.text }));
  const context = await runContext(f);
  const { harness, openSandboxToolSession, openSession } = installSandbox(
    f.app,
    fakeSession().session,
  );

  await expect(openSandboxToolSession({ context, selectedNames: ["bash"] })).rejects.toThrow(
    "Sandbox workspace binding missing",
  );
  expect(openSession).not.toHaveBeenCalled();
  expect(harness.sandboxRuns.has(context.runId!)).toBe(false);
});
