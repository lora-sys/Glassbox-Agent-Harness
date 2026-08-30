// Debug script for adapter behavior
import { spawn } from "node:child_process";

const child = spawn("codex", ["app-server"], { stdio: ["pipe", "pipe", "pipe"] });

let accum = "";
let requestId = 1;
let responseReceived = false;

child.stdout?.on("data", (raw) => {
  accum += Buffer.from(raw).toString();
  const lines = accum.split("\n");
  accum = lines.pop() ?? "";
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const msg = JSON.parse(line);
      console.log("STDOUT:", JSON.stringify(msg).slice(0, 150));

      if (msg.id && !msg.method) {
        // It's a response to our request
        if (msg.id === requestId) {
          responseReceived = true;
          console.log("GOT RESPONSE for id", msg.id);
          console.log("CONTENT:", JSON.stringify(msg.result || msg.error));
          child.kill();
          process.exit(0);
        }
      }
    } catch {
      console.log("RAW:", line.slice(0, 120));
    }
  }
});

child.stderr?.on("data", (raw) => {
  console.log("STDERR:", Buffer.from(raw).toString().trimEnd().slice(0, 100));
});

child.on("exit", (c) => {
  console.log("EXIT:", c);
  if (!responseReceived) {
    console.log("TIMEOUT: No response received");
    process.exit(1);
  }
});

console.log("Spawning codex PID:", child.pid);
console.log("Sending initialize request...");
child.stdin?.write(
  JSON.stringify({
    jsonrpc: "2.0",
    id: requestId,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: { experimentalApi: true },
      clientInfo: { name: "debug-tsx", version: "0.1.0" },
    },
  }) + "\n"
);

setTimeout(() => {
  console.log("Hard timeout after 12s");
  child.kill();
  process.exit(1);
}, 12000);
