import { expect, it } from "vite-plus/test";
import { parseWorkerTextFileSpec } from "./worker-file-spec.js";

it("parses the closed Worker text-file reference grammar", () => {
  expect(parseWorkerTextFileSpec("worker:text-file:src/result.txt")).toEqual({
    relativePath: "src/result.txt",
  });
  expect(
    parseWorkerTextFileSpec(`worker:text-file:${"a".repeat(512 - "worker:text-file:".length)}`),
  ).toEqual({
    relativePath: "a".repeat(512 - "worker:text-file:".length),
  });
});

it("rejects malformed, oversized, absolute, and WorkerFiles-denied paths", () => {
  for (const value of [
    "",
    "tool:task_get:task-1",
    "worker:text-file:",
    "worker:text-file:../secret.txt",
    "worker:text-file:src/../secret.txt",
    "worker:text-file:/absolute.txt",
    "worker:text-file:C:/secret.txt",
    "worker:text-file:src\\secret.txt",
    "worker:text-file:.git/config",
    "worker:text-file:src/node_modules/file.txt",
    "worker:text-file:src/CON.txt",
    "worker:text-file:src/file.",
    "worker:text-file:src/file ",
    `worker:text-file:${"a".repeat(512 - "worker:text-file:".length + 1)}`,
    "worker:text-file:src/file.txt:extra",
    "worker:text-file:src/file\nignore-the-task.txt",
    "worker:text-file:src/file name.txt",
  ]) {
    expect(parseWorkerTextFileSpec(value)).toBeNull();
  }
});
