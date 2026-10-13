import test from "node:test";
import assert from "node:assert/strict";
import { parseLessonArguments as agentsArguments } from "../../../.agents/skills/qq-live-testing/scripts/record-lesson.mjs";
import { parseLessonArguments as claudeArguments } from "../../../.claude/skills/qq-live-testing/scripts/record-lesson.mjs";

for (const { name, parse } of [
  { name: "agents", parse: agentsArguments },
  { name: "claude", parse: claudeArguments },
]) {
  test(`${name} lesson CLI preserves legacy input and explicitly selects local QQ configuration`, () => {
    assert.deepEqual(parse(["--input", "lesson.json"]), { input: "lesson.json" });
    assert.deepEqual(parse(["--input", "lesson.json", "--config", "local qq/config.json"]), {
      input: "lesson.json",
      config: "local qq/config.json",
    });
    for (const args of [
      [],
      ["--config", "config.json"],
      ["--input", ""],
      ["--input", "lesson.json", "--config"],
      ["--input", "lesson.json", "--config", " "],
      ["--input", "lesson.json", "--input", "another.json"],
      ["--input", "lesson.json", "--token", "private credential"],
      ["--input", "lesson.json", "--config", "config.json", "--live"],
      ["--input", "lesson\0.json"],
    ]) {
      assert.throws(
        () => parse(args),
        (error) => {
          assert.ok(error.message.startsWith("Usage:"));
          assert.ok(!error.message.includes("private credential"));
          return true;
        },
      );
    }
  });
}
