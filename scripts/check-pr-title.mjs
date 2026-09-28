import { readFileSync } from "node:fs";

const eventPath = process.env.GITHUB_EVENT_PATH;
if (!eventPath) {
  console.error("GITHUB_EVENT_PATH is required to validate a pull request title.");
  process.exit(1);
}

const event = JSON.parse(readFileSync(eventPath, "utf8"));
const title = event.pull_request?.title;
const conventionalTitle =
  /^(feat|fix|docs|refactor|test|build|ci|chore|perf|revert)(\([a-z0-9][a-z0-9._/+:-]*\))?!?: .+$/;

if (typeof title !== "string" || !conventionalTitle.test(title)) {
  console.error(
    'Pull request title must use "type(scope): summary", for example "fix(persistence): preserve migrated rows".',
  );
  process.exit(1);
}

console.log(`Pull request title accepted: ${title}`);
