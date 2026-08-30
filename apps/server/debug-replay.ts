import { getGlassboxBase } from './src/trace/store.ts';
import { loadTrace } from './src/trace/load.ts';
import { replayEntries } from './src/state/replay.ts';
import { readdirSync, statSync } from 'node:fs';

const sessionsDir = getGlassboxBase() + '/sessions';
const sessions = readdirSync(sessionsDir);
let latest = '', latestTime = 0;
for (const s of sessions) {
  const p = sessionsDir + '/' + s + '/trace.jsonl';
  try {
    const mtime = statSync(p).mtimeMs;
    if (mtime > latestTime) { latestTime = mtime; latest = s; }
  } catch {}
}
if (!latest) { console.log('No sessions found'); process.exit(1); }

const entries = loadTrace(latest);
const result = replayEntries(entries);
console.log('Session:', latest);
console.log('Artifacts:', result.artifacts.length);
for (const a of result.artifacts) {
  console.log('  -', a.itemId, 'changes:', a.changes.map((c: any) => c.path + ':' + c.kind).join(', '));
}
console.log('testResult:', result.testResult?.status, 'exitCode:', result.testResult?.exitCode);
console.log('finalResult:', result.finalResult?.status);
console.log('turns:', result.turns.length);
console.log('pendingDiffs left:', result._pendingDiffs.length);
const eventCounts = result.traceSummary.eventCounts;
console.log('turn/diff/updated:', eventCounts['turn/diff/updated']);
console.log('item/fileChange:', eventCounts['item/fileChange']);

const counted = Object.values(eventCounts).reduce((a, b) => a + b, 0);
console.log('total counted:', counted, 'entryCount:', result.entryCount);
console.log('skipped/unrecognized:', result.entryCount - counted);
