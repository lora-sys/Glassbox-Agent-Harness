import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { GroupRuntimeStore } from "./group-runtime.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "glassbox-group-runtime-"));
  directories.push(directory);
  return { directory, store: await GroupRuntimeStore.open(directory) };
}

describe("durable group Skill policy", () => {
  it("starts from the QQ profile, serializes updates, and survives reopen", async () => {
    const { directory, store } = await fixture();
    expect(store.get("qq-personal", "1126022432", ["unslop"])).toEqual({
      connectionId: "qq-personal",
      groupId: "1126022432",
      enabledSkills: ["unslop"],
      version: 0,
      updatedByPrincipalId: null,
      updatedAt: null,
    });

    await Promise.all([
      store.setSkillEnabled({
        connectionId: "qq-personal",
        groupId: "1126022432",
        skillName: "github-gem-seeker",
        enabled: true,
        availableSkills: ["unslop", "github-gem-seeker"],
        defaultSkills: ["unslop"],
        principalId: "owner",
      }),
      store.setSkillEnabled({
        connectionId: "qq-personal",
        groupId: "1126022432",
        skillName: "unslop",
        enabled: false,
        availableSkills: ["unslop", "github-gem-seeker"],
        defaultSkills: ["unslop"],
        principalId: "owner",
      }),
    ]);

    const reopened = await GroupRuntimeStore.open(directory);
    expect(reopened.get("qq-personal", "1126022432")).toMatchObject({
      enabledSkills: ["github-gem-seeker"],
      version: 2,
      updatedByPrincipalId: "owner",
    });
    const raw = await readFile(join(directory, "group-runtime.json"), "utf8");
    expect(raw).not.toContain("SKILL.md");
  });

  it("rejects unavailable Skills and invalid identifiers without writing state", async () => {
    const { directory, store } = await fixture();
    expect(() =>
      store.setSkillEnabled({
        connectionId: "qq-personal",
        groupId: "1126022432",
        skillName: "unknown-skill",
        enabled: true,
        availableSkills: ["unslop"],
        principalId: "owner",
      }),
    ).toThrow("not available");
    expect(() => store.get("../qq", "1126022432")).toThrow("Invalid connection");
    await expect(readFile(join(directory, "group-runtime.json"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});
