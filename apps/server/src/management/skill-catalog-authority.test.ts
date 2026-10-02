import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { ManagementApplication } from "./application.js";
import type { GroupRuntimeStore } from "../config/group-runtime.js";
import { ModelProfileStore } from "../config/model-profiles.js";
import { KitLoader } from "../runtime/pi/kit-loader.js";
import type { PiSdkRuntimeOptions } from "../runtime/pi/adapter.js";
import type { PiRunContext } from "../runtime/pi/types.js";

type Resolver = NonNullable<PiSdkRuntimeOptions["resolveSkillNames"]>;
const kitPath = fileURLToPath(new URL("../runtime/pi/fixtures/lora-pi-kit", import.meta.url));
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function fixture(chatType: "private" | "group" = "private", owner = true) {
  const directory = await mkdtemp(join(tmpdir(), "glassbox-catalog-test-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const app = await ManagementApplication.open({
    dataDirectory: directory,
    databasePath: ":memory:",
    kitPath,
    piAgentDirectory: null,
    models: await ModelProfileStore.open(directory),
  });
  cleanups.push(() => app.close());
  const scope = {
    connectionId: "fixture",
    botId: "10001",
    chatType,
    chatId: "10003",
    senderId: "10002",
  };
  const caller = { principalId: "speaker", scope };
  if (owner) await app.store.identities.bindOwner(caller.principalId, scope);
  else {
    await app.store.identities.createPrincipal(caller.principalId, "visitor");
    await app.store.identities.bindPrincipal(caller.principalId, scope);
  }
  for (const action of ["run:create", "conversation:read", "run:control"])
    await app.store.authorization.grant({
      principalId: caller.principalId,
      resourceId: "agent:personal",
      action,
      scope,
      effect: "allow",
    });
  await app.store.authorization.registerResource({
    id: "skill-catalog",
    kind: "skill-catalog",
    visibility: "public",
  });
  const accepted = await app.store.conversations.acceptIncoming({
    agentId: "personal",
    scope,
    messageId: "one",
    text: "hello",
    executionRef: "pi:fixture",
  });
  const context: PiRunContext = {
    caller,
    runId: accepted.run.id,
    conversationId: accepted.conversation.id,
  };
  const internal = app as unknown as {
    getOrCreateDefaultPiAdapter(profile: string): {
      runtime: { options: { resolveSkillNames: Resolver } };
    };
    kitLoader: KitLoader;
    groupRuntime: GroupRuntimeStore;
  };
  const resolve = internal.getOrCreateDefaultPiAdapter("fixture").runtime.options.resolveSkillNames;
  const profile = {
    ...new KitLoader(kitPath).loadProfile(chatType === "group" ? "qq-group" : "main-agent"),
    enabledSkills: ["unslop"],
  };
  const grant = (effect: "allow" | "approval" = "allow") =>
    app.store.authorization.grant({
      principalId: caller.principalId,
      resourceId: "skill-catalog",
      action: "skill:read",
      scope,
      effect,
    });
  const sources = async () =>
    (
      await app.store.db.transaction((tx) =>
        tx.execute({
          sql: "SELECT delivery_source FROM authorization_decisions WHERE run_id = ? AND resource_id = 'skill-catalog' AND delivery_source = 'content_source'",
          args: [accepted.run.id],
        }),
      )
    ).rows;
  return {
    app,
    context,
    resolve,
    profile,
    grant,
    sources,
    loader: internal.kitLoader,
    groups: internal.groupRuntime,
  };
}
describe("Run Skill catalog authority", () => {
  for (const [chatType, owner] of [
    ["private", true],
    ["group", false],
  ] as const)
    for (const state of ["missing", "revoked", "approval"] as const)
      it(`${chatType} ${state} permission exposes no metadata`, async () => {
        const f = await fixture(chatType, owner);
        if (state === "revoked") await f.app.store.authorization.revoke(await f.grant());
        if (state === "approval") await f.grant("approval");
        const read = vi.spyOn(f.loader, "availableSkills");
        const result = await f.resolve(f.context, f.profile);
        expect(result.names).toEqual([]);
        expect(result.modelVisibleNames).toEqual([]);
        expect(read).not.toHaveBeenCalled();
        expect(await f.sources()).toEqual([]);
      });
  it("records the allowed visible directory as a Run source", async () => {
    const f = await fixture();
    await f.grant();
    expect((await f.resolve(f.context, f.profile)).modelVisibleNames).toEqual(["unslop"]);
    expect(await f.sources()).toHaveLength(1);
  });
  it("keeps the Owner group directory hidden without an unused source", async () => {
    const f = await fixture("group");
    await f.grant();
    const result = await f.resolve(f.context, f.profile);
    expect(result.names).toEqual(["unslop"]);
    expect(result.modelVisibleNames).toEqual([]);
    expect(await f.sources()).toEqual([]);
  });
  for (const missing of ["caller", "runId", "conversationId"] as const)
    it(`fails closed without ${missing}`, async () => {
      const f = await fixture();
      await f.grant();
      delete f.context[missing];
      const read = vi.spyOn(f.loader, "availableSkills");
      expect((await f.resolve(f.context, f.profile)).names).toEqual([]);
      expect(read).not.toHaveBeenCalled();
    });
  it("does not expose optional Skills to a task-step model", async () => {
    const f = await fixture();
    await f.grant();
    f.context.executionMode = "task_step_model";
    const read = vi.spyOn(f.loader, "availableSkills");
    expect((await f.resolve(f.context, f.profile)).names).toEqual([]);
    expect(read).not.toHaveBeenCalled();
  });
  it("rechecks authority before releasing the selected directory", async () => {
    const f = await fixture();
    const grantId = await f.grant();
    const complete = f.app.store.authorization.authorizeReadResults.bind(f.app.store.authorization);
    vi.spyOn(f.app.store.authorization, "authorizeReadResults").mockImplementationOnce(
      async (reads) => {
        await f.app.store.authorization.revoke(grantId);
        return complete(reads);
      },
    );
    expect((await f.resolve(f.context, f.profile)).names).toEqual([]);
    expect(await f.sources()).toEqual([]);
  });
  it("does not release untracked metadata after a storage error", async () => {
    const f = await fixture();
    await f.grant();
    vi.spyOn(f.app.store.authorization, "authorizeReadResults").mockRejectedValueOnce(
      new Error("storage unavailable"),
    );
    await expect(f.resolve(f.context, f.profile)).rejects.toThrow("storage unavailable");
  });
  it("rechecks a displayed group whitelist before another provider request", async () => {
    const f = await fixture("group", false);
    await f.grant();
    expect((await f.resolve(f.context, f.profile)).modelVisibleNames).toEqual(["unslop"]);
    expect(f.context.authorizeSkillContext).toBeTypeOf("function");
    await f.context.authorizeSkillContext!();
    await f.groups.setSkillEnabled({
      connectionId: "fixture",
      groupId: "10003",
      skillName: "unslop",
      enabled: false,
      availableSkills: ["unslop"],
      defaultSkills: ["unslop"],
      principalId: "speaker",
    });
    await expect(f.context.authorizeSkillContext!()).rejects.toThrow("skill_policy_changed");
    expect((await f.resolve(f.context, f.profile)).modelVisibleNames).toEqual([]);
    expect(f.context.authorizeSkillContext).toBeUndefined();
  });
});
