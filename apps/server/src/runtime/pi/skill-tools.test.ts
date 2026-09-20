import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vite-plus/test";
import { openDomainStore } from "../../persistence/index.js";
import { KitLoader } from "./kit-loader.js";
import { createSkillTools, SKILL_CATALOG_RESOURCE, SKILL_READ_ACTION } from "./skill-tools.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

it("re-authorizes locked Skill reads against the Run snapshot and current group policy", async () => {
  const directory = await mkdtemp(join(tmpdir(), "glassbox-skill-tool-"));
  directories.push(directory);
  const skill = "---\nname: fixture\ndescription: Fixture Skill.\n---\n\nDo fixture work.";
  await mkdir(join(directory, "locks"), { recursive: true });
  await mkdir(join(directory, "skills/fixture"), { recursive: true });
  await writeFile(join(directory, "skills/fixture/SKILL.md"), skill);
  await writeFile(
    join(directory, "locks/skills.lock.json"),
    JSON.stringify({
      sourceCommit: "1".repeat(40),
      includedSkills: ["fixture"],
      skills: {
        fixture: {
          name: "fixture",
          description: "Fixture Skill.",
          files: [
            {
              path: "skills/fixture/SKILL.md",
              sha256: createHash("sha256").update(skill).digest("hex"),
              bytes: Buffer.byteLength(skill),
            },
          ],
        },
      },
    }),
  );

  const store = await openDomainStore({ databasePath: ":memory:" });
  const caller = {
    principalId: "owner",
    scope: {
      connectionId: "qq",
      botId: "bot",
      chatType: "group" as const,
      chatId: "1126022432",
      senderId: "owner",
    },
  };
  let liveAuthorized = true;
  try {
    await store.identities.bindOwner("owner", caller.scope);
    await store.conversations.createAgent("personal");
    await store.authorization.grant({
      principalId: "owner",
      resourceId: "agent:personal",
      action: "run:create",
      scope: caller.scope,
      effect: "allow",
    });
    const accepted = await store.conversations.acceptIncoming({
      agentId: "personal",
      scope: caller.scope,
      messageId: "message-1",
      text: "Use the Skill",
      executionRef: "pi:test",
    });
    const context = {
      caller,
      conversationId: accepted.conversation.id,
      runId: accepted.run.id,
      authorizedSkillNames: ["fixture"],
    };
    await store.authorization.registerResource({
      id: SKILL_CATALOG_RESOURCE,
      kind: "skill-catalog",
      visibility: "public",
    });
    const grant = await store.authorization.grant({
      principalId: "owner",
      resourceId: SKILL_CATALOG_RESOURCE,
      action: SKILL_READ_ACTION,
      scope: caller.scope,
      effect: "allow",
    });
    const read = createSkillTools({
      store,
      loader: new KitLoader(directory),
      getContext: () => context,
      isSkillAuthorized: async () => liveAuthorized,
    })[0]!;

    await expect(
      read.execute("read", { skillName: "fixture" }, undefined, undefined, {} as never),
    ).resolves.toMatchObject({
      details: { skillName: "fixture", path: "SKILL.md", content: skill },
    });
    await expect(
      read.execute(
        "unauthorized",
        { skillName: "unauthorized-skill" },
        undefined,
        undefined,
        {} as never,
      ),
    ).rejects.toThrow("protected_tool_failed");
    liveAuthorized = false;
    await expect(
      read.execute("changed", { skillName: "fixture" }, undefined, undefined, {} as never),
    ).rejects.toThrow("protected_tool_failed");
    liveAuthorized = true;
    await store.authorization.revoke(grant);
    await expect(
      read.execute("revoked", { skillName: "fixture" }, undefined, undefined, {} as never),
    ).rejects.toThrow("Permission denied");
  } finally {
    await store.close();
  }
});
