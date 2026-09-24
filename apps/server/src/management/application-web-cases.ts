import { afterEach, describe, expect, it } from "vite-plus/test";
import { createApplicationFixtureScope, type OwnerContext } from "./application-test-helpers.js";
import { ManagementApplication } from "./application.js";

const { fixture, afterEachCleanup } = createApplicationFixtureScope();
afterEach(afterEachCleanup);

const CO_OWNER = "10006";
const GROUP_ID = 10005;
const GROUP = String(GROUP_ID);

const groupRun = (app: ManagementApplication) =>
  app as unknown as {
    setGroupAccess(
      context: OwnerContext,
      input: { groupId: string; enabled: boolean },
    ): Promise<unknown>;
    setGroupWebCapability(
      context: OwnerContext,
      input: {
        groupId: string;
        category: "web.search" | "web.fetch" | "browser.read" | "browser.interact";
        enabled: boolean;
      },
    ): Promise<unknown>;
    resolveRunToolNames(context: OwnerContext): Promise<string[]>;
    createRuntimeTools(getContext: () => OwnerContext | undefined): Array<{
      name: string;
      execute(id: string, params: unknown, signal?: AbortSignal): Promise<{ details?: unknown }>;
    }>;
  };

async function configuredGroup() {
  const f = await fixture(
    async (input) => ({ status: "succeeded", text: `answer:${input.text}` }),
    {
      coOwnerId: CO_OWNER,
    },
  );
  f.send(1, "owner-a", true, 10002);
  const ownerA = await f.started.take();
  await f.reply("answer:owner-a");
  const a: OwnerContext = {
    caller: ownerA.caller,
    conversationId: ownerA.conversation.id,
    runId: ownerA.run.id,
  };
  const application = groupRun(f.app);
  await application.setGroupAccess(a, { groupId: GROUP, enabled: true });
  f.send(2, "group-run", false, 10002, GROUP_ID);
  const run = await f.started.take();
  await f.reply("answer:group-run");
  const context: OwnerContext = {
    caller: run.caller,
    conversationId: run.conversation.id,
    runId: run.run.id,
  };
  expect(context.caller.scope).toMatchObject({ chatType: "group", chatId: GROUP });
  return { application, a, context };
}

describe("group web capability authority", () => {
  it("keeps group web discovery off until the Owner enables that capability", async () => {
    const { application, a, context } = await configuredGroup();
    expect(await application.resolveRunToolNames(context)).not.toContain("web_search");
    expect(await application.resolveRunToolNames(context)).not.toContain("web_fetch");
    await application.setGroupWebCapability(a, {
      groupId: GROUP,
      category: "web.search",
      enabled: true,
    });
    expect(await application.resolveRunToolNames(context)).toContain("web_search");
    expect(await application.resolveRunToolNames(context)).not.toContain("web_fetch");
    await application.setGroupWebCapability(a, {
      groupId: GROUP,
      category: "web.search",
      enabled: false,
    });
    expect(await application.resolveRunToolNames(context)).not.toContain("web_search");
    await application.setGroupWebCapability(a, {
      groupId: GROUP,
      category: "browser.read",
      enabled: true,
    });
    expect(await application.resolveRunToolNames(context)).toContain("browser");
    const browser = application
      .createRuntimeTools(() => context)
      .find((tool) => tool.name === "browser");
    await expect(
      browser?.execute("missing-shared-sandbox", { action: "open", url: "https://example.com/" }),
    ).rejects.toThrow("browser_backend_unavailable");
    await expect(
      browser?.execute("denied-interaction", { action: "click", ref: "@e1" }),
    ).rejects.toThrow("capability_category_disabled");
  });
});
