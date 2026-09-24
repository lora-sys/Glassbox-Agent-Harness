import { describe, expect, it, vi } from "vitest";
import type { BrowserArtifactReference } from "./browser-executor-port.js";
import type { BrowserArtifactStore } from "./browser-artifact-store.js";
import { createKitBrowserExecutor, type KitCliSession } from "./kit-browser-executor.js";
import type { BrowserSessionBinding } from "./browser-session.js";

const binding: BrowserSessionBinding = {
  runId: "run-23",
  principalId: "owner-1",
  conversationId: "conversation-1",
  workspaceId: "workspace-1",
  policyVersion: "policy-2",
};
const sessionId = "gb-0123456789abcdef01234567";
const args = ["--json", "--session", sessionId, "read"];
const limits = { timeoutMs: 100, maxOutputChars: 10, maxArtifactBytes: 3 * 1024 * 1024 };
const screenshotArgs = ["--json", "--session", sessionId, "screenshot"];
const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
const artifactReference: BrowserArtifactReference = {
  id: "artifact-uuid",
  mimeType: "image/png",
  sizeBytes: png.length,
};

function setup(
  session: Omit<KitCliSession, "closeRun"> & Partial<Pick<KitCliSession, "closeRun">>,
  artifacts: Pick<BrowserArtifactStore, "write"> = {
    write: vi.fn(async () => artifactReference),
  },
) {
  const kitSession: KitCliSession = {
    closeRun: vi.fn(async () => undefined),
    ...session,
  };
  const lookup = vi.fn(async (candidate: BrowserSessionBinding) => {
    expect(candidate).toEqual(binding);
    return kitSession;
  });
  return { lookup, kitSession, artifacts, executor: createKitBrowserExecutor(lookup, artifacts) };
}

describe("Kit browser executor adapter", () => {
  it("uses the existing Run session and preserves bounded stdout, stderr, and exit code", async () => {
    const executeCli = vi.fn<KitCliSession["executeCli"]>(async (input) => ({
      content: [{ type: "text", text: "ignored display content" }],
      details:
        input.args[3] === "close"
          ? { stdout: '{"success":true}', stderr: "", exitCode: 0 }
          : { stdout: "123456789012", stderr: "diagnostic text", exitCode: 7 },
    }));
    const cancel = vi.fn(async () => undefined);
    const closeRun = vi.fn(async () => undefined);
    const state = setup({ executeCli, cancel, closeRun });
    const wrapper = await state.executor.open(binding, sessionId);
    const result = await wrapper.execute(args, limits);

    expect(state.lookup).toHaveBeenCalledOnce();
    expect(executeCli).toHaveBeenCalledWith({
      id: expect.stringMatching(/^browser_[a-f0-9]{32}$/u),
      executable: "agent-browser",
      args,
    });
    expect(result).toEqual({ exitCode: 7, stdout: "1234567890", stderr: "diagnostic" });
    await wrapper.close();
    expect(cancel).not.toHaveBeenCalled();
    expect(executeCli).toHaveBeenLastCalledWith({
      id: expect.stringMatching(/^browser_[a-f0-9]{32}$/u),
      executable: "agent-browser",
      args: ["--json", "--session", sessionId, "close"],
    });
    expect(closeRun).not.toHaveBeenCalled();
  });

  it("fails closed when the session is missing, argv is malformed, or result details are absent", async () => {
    const artifacts = { write: vi.fn(async () => artifactReference) };
    const noSession = createKitBrowserExecutor(async () => undefined, artifacts);
    await expect(noSession.open(binding, sessionId)).rejects.toThrow(
      "browser_kit_session_unavailable",
    );

    const kitSession = {
      executeCli: vi.fn<KitCliSession["executeCli"]>(async () => ({
        content: [{ type: "text", text: "0" }],
      })),
      cancel: vi.fn(async () => undefined),
    };
    const wrapper = await setup(kitSession, artifacts).executor.open(binding, sessionId);
    await expect(wrapper.execute(["--json", "--session", "other", "read"], limits)).rejects.toThrow(
      "browser_invalid_argv",
    );
    await expect(wrapper.execute(args, limits)).rejects.toThrow("browser_cli_result_invalid");
  });

  it("closes the shared Run sandbox when the browser daemon cannot confirm cleanup", async () => {
    const closeRun = vi.fn(async () => undefined);
    const state = setup({
      executeCli: vi.fn<KitCliSession["executeCli"]>(async () => ({
        content: [],
        details: { stdout: '{"success":false}', stderr: "", exitCode: 1 },
      })),
      cancel: vi.fn(async () => undefined),
      closeRun,
    });
    const wrapper = await state.executor.open(binding, sessionId);
    await expect(wrapper.close()).rejects.toThrow("browser_cleanup_uncertain");
    expect(closeRun).toHaveBeenCalledOnce();
  });

  it("stores screenshot bytes and returns only the protected Artifact reference", async () => {
    const executeCli = vi.fn<KitCliSession["executeCli"]>(async () => ({
      content: [{ type: "text", text: "screenshot saved" }],
      details: {
        stdout: JSON.stringify({ success: true, data: "screenshot saved" }),
        stderr: "",
        exitCode: 0,
        artifact: { mimeType: "image/png", data: png.toString("base64"), sizeBytes: png.length },
      },
    }));
    const artifacts = { write: vi.fn(async () => artifactReference) };
    const wrapper = await setup({ executeCli, cancel: vi.fn() }, artifacts).executor.open(
      binding,
      sessionId,
    );

    const result = await wrapper.execute(screenshotArgs, { ...limits, maxOutputChars: 100 });

    expect(executeCli).toHaveBeenCalledWith({
      id: expect.stringMatching(/^browser_[a-f0-9]{32}$/u),
      executable: "agent-browser",
      args: screenshotArgs,
      maxArtifactBytes: 2 * 1024 * 1024,
    });
    expect(artifacts.write).toHaveBeenCalledWith(binding, png.toString("base64"), 2 * 1024 * 1024);
    expect(result).toEqual({
      exitCode: 0,
      stdout: JSON.stringify({ success: true, data: "screenshot saved" }),
      stderr: "",
      artifact: artifactReference,
    });
  });

  it("rejects unexpected artifacts and malformed screenshot metadata", async () => {
    const result = (artifact: unknown) => ({
      content: [{ type: "text", text: "ok" }],
      details: { stdout: "{}", stderr: "", exitCode: 0, artifact },
    });
    const unexpected = await setup({
      executeCli: vi.fn<KitCliSession["executeCli"]>(async () => result({})),
      cancel: vi.fn(async () => undefined),
    }).executor.open(binding, sessionId);
    await expect(unexpected.execute(args, limits)).rejects.toThrow("browser_cli_result_invalid");

    const malformed = await setup({
      executeCli: vi.fn<KitCliSession["executeCli"]>(async () =>
        result({
          mimeType: "image/jpeg",
          data: "AA==",
          sizeBytes: 1,
        }),
      ),
      cancel: vi.fn(async () => undefined),
    }).executor.open(binding, sessionId);
    await expect(malformed.execute(screenshotArgs, limits)).rejects.toThrow(
      "browser_cli_result_invalid",
    );
  });

  it("waits for Kit cancellation confirmation on explicit cancellation and timeout", async () => {
    const stopped = new Map<string, (error: Error) => void>();
    const executeCli = vi.fn<KitCliSession["executeCli"]>(
      ({ id }) =>
        new Promise((_, reject) => {
          stopped.set(id, reject);
        }),
    );
    let confirmCancellation!: () => void;
    let confirmation = new Promise<void>((resolve) => {
      confirmCancellation = resolve;
    });
    const cancel = vi.fn(async (id: string) => {
      await confirmation;
      stopped.get(id)?.(new Error("cancelled"));
    });
    const wrapper = await setup({ executeCli, cancel }).executor.open(binding, sessionId);

    const running = wrapper.execute(args, { ...limits, timeoutMs: 1_000 });
    await vi.waitFor(() => expect(executeCli).toHaveBeenCalledOnce());
    const cancellation = wrapper.cancel();
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
    let cancelSettled = false;
    void cancellation.then(() => (cancelSettled = true));
    await Promise.resolve();
    expect(cancelSettled).toBe(false);
    confirmCancellation();
    await cancellation;
    await expect(running).rejects.toThrow("cancelled");

    confirmation = new Promise<void>((resolve) => {
      confirmCancellation = resolve;
    });
    const timed = wrapper.execute(args, { ...limits, timeoutMs: 10 });
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledTimes(2));
    let timeoutSettled = false;
    void timed.catch(() => (timeoutSettled = true));
    await Promise.resolve();
    expect(timeoutSettled).toBe(false);
    confirmCancellation();
    await expect(timed).rejects.toThrow("browser_timeout");
  });

  it("surfaces uncertain cancellation so the Run can close its shared sandbox", async () => {
    const stopPending = new Map<string, (error: Error) => void>();
    const executeCli = vi.fn<KitCliSession["executeCli"]>(
      ({ id }) =>
        new Promise((_, reject) => {
          stopPending.set(id, reject);
        }),
    );
    const wrapper = await setup({
      executeCli,
      cancel: vi.fn(async () => {
        stopPending.values().next().value?.(new Error("shared session closed"));
        throw new Error("transport lost");
      }),
    }).executor.open(binding, sessionId);
    const running = wrapper.execute(args, { ...limits, timeoutMs: 1_000 });
    await vi.waitFor(() => expect(executeCli).toHaveBeenCalledOnce());
    await expect(wrapper.cancel()).rejects.toThrow("browser_cancel_uncertain");
    await expect(running).rejects.toThrow("browser_cancel_uncertain");
  });
});
