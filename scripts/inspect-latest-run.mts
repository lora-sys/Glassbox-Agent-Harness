import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const dataDirectory = process.env.GLASSBOX_DATA_DIR ?? join(homedir(), ".glassbox");
const runsDirectory = join(dataDirectory, "runs");

interface TraceItem {
  seq: number;
  ts: string;
  provenance: string;
  event: {
    type: string;
    runId?: string;
    conversationId?: string;
    sessionId?: string;
    principalId?: string;
    data?: Record<string, unknown>;
  };
}

async function getLatestRunId(): Promise<string | undefined> {
  try {
    const entries = await readdir(runsDirectory, { withFileTypes: true });
    const runDirs = entries.filter((e) => e.isDirectory());
    if (runDirs.length === 0) return undefined;

    const stats = await Promise.all(
      runDirs.map(async (d) => {
        const s = await stat(join(runsDirectory, d.name));
        return { name: d.name, mtime: s.mtimeMs };
      }),
    );
    stats.sort((a, b) => b.mtime - a.mtime);
    return stats[0]?.name;
  } catch {
    return undefined;
  }
}

async function inspectRun(runId: string) {
  const tracePath = join(runsDirectory, runId, "trace.jsonl");
  let content = "";
  try {
    content = await readFile(tracePath, "utf8");
  } catch {
    console.log(`No trace found for run ${runId}`);
    return;
  }

  const lines = content.trim().split("\n").filter(Boolean);
  const events: TraceItem[] = lines.map((l) => JSON.parse(l));

  console.log(`\n======================================================`);
  console.log(`RUN INSPECTION: ${runId}`);
  console.log(`======================================================`);

  const sessionStart = events.find((e) => e.event.type === "session_start");
  if (sessionStart?.event.data) {
    const data = sessionStart.event.data;
    console.log(`\n[Session Start]`);
    console.log(
      `  Principal:           ${typeof data.principalId === "string" ? data.principalId : ""}`,
    );
    console.log(
      `  Conversation:        ${typeof data.conversationId === "string" ? data.conversationId : ""}`,
    );
    console.log(`  Skill Policy:        ${JSON.stringify(data.skillPolicy)}`);
    console.log(
      `  Authorized Skills:   ${Array.isArray(data.authorizedSkills) ? `(${data.authorizedSkills.length}) ${data.authorizedSkills.join(", ")}` : "none"}`,
    );
    console.log(
      `  Model Visible Skills:${Array.isArray(data.modelVisibleSkills) ? `(${data.modelVisibleSkills.length}) ${data.modelVisibleSkills.join(", ")}` : "none"}`,
    );
  }

  const toolCalls = events.filter((e) => e.event.type === "tool_call");
  if (toolCalls.length > 0) {
    console.log(`\n[Tool Calls (${toolCalls.length})]`);
    for (const tc of toolCalls) {
      const name = typeof tc.event.data?.name === "string" ? tc.event.data.name : "";
      console.log(`  - ${name}: ${JSON.stringify(tc.event.data?.input)}`);
    }
  } else {
    console.log(`\n[Tool Calls] None (direct execution)`);
  }

  const chunks = events.filter((e) => e.event.type === "message_chunk");
  const fullText = chunks
    .map((c) => (typeof c.event.data?.text === "string" ? c.event.data.text : ""))
    .join("");
  console.log(`\n[Assistant Response]`);
  console.log(fullText || "(no message chunks recorded yet)");

  const turnEnd = events.find((e) => e.event.type === "turn_end");
  if (turnEnd?.event.data?.usage) {
    console.log(`\n[Usage]`, JSON.stringify(turnEnd.event.data.usage));
  }

  const runFinished = events.find((e) => e.event.type === "run_finished");
  if (runFinished?.event) {
    console.log(
      `\n[Status] ${runFinished.event.type} -> status: ${(runFinished.event as any).status}`,
    );
  }
  console.log(`======================================================\n`);
}

async function main() {
  const watch = process.argv.includes("--watch");
  let lastSeenRunId: string | undefined;

  if (watch) {
    console.log("Watching for new runs in real-time... (Press Ctrl+C to stop)");
    while (true) {
      const currentRunId = await getLatestRunId();
      if (currentRunId && currentRunId !== lastSeenRunId) {
        lastSeenRunId = currentRunId;
        await inspectRun(currentRunId);
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
  } else {
    const runId =
      process.argv[2] && !process.argv[2].startsWith("--")
        ? process.argv[2]
        : await getLatestRunId();
    if (!runId) {
      console.log("No runs found in", runsDirectory);
      return;
    }
    await inspectRun(runId);
  }
}

main().catch(console.error);
