#!/usr/bin/env node
import { createServer, request } from "node:http";
import {
  readFileSync,
  mkdirSync,
  chmodSync,
  openSync,
  closeSync,
  lstatSync,
  unlinkSync,
} from "node:fs";
import { resolve, join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { ChatSession, chatConfig, defaultChatConfig } from "./lib/chat-session.mjs";

const help = `qq-chat: real QQ messages and Glassbox execution evidence
  up                              Start the local message observer
  status                          QQ account and Glassbox status
  send --chat private|A|B --text 'natural language' [--wait 60]
  send --chat B --message-file /absolute/request.txt [--no-at]
  read [--after CURSOR] [--chat private|A|B] [--wait 30]
  trace --request REQUEST_ID [--after TRACE_CURSOR] [--limit 200]
  trace --run RUN_ID [--after TRACE_CURSOR] [--limit 200]
  down                            Stop only this observer
Options: --config /absolute/qq-chat.json; send also accepts --request UUID.
Messages are ordinary QQ messages under the Owner's existing Glassbox authority.
There is no feature registry, expected tool, automatic retry, automatic PASS or merge.
The observer keeps receiving after send returns, including later image/video replies.
`;
export function rpc(socketPath, operation, body = {}) {
  return new Promise((done, reject) => {
    const req = request(
      {
        socketPath,
        path: "/" + operation,
        method: "POST",
        headers: { "content-type": "application/json" },
      },
      (res) => {
        let data = "";
        res.on("data", (part) => {
          data += part;
          if (Buffer.byteLength(data) > 16 * 1024 * 1024)
            req.destroy(new Error("Response too large; use trace pagination."));
        });
        res.on("end", () => {
          try {
            const result = JSON.parse(data);
            result.error ? reject(new Error(result.error)) : done(result);
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    req.setTimeout(75000, () =>
      req.destroy(
        new Error(
          "Observer request timed out. Inspect the same request ID; do not automatically resend.",
        ),
      ),
    );
    req.on("error", reject);
    req.end(JSON.stringify(body));
  });
}
export async function serve(config, dependencies) {
  const session = new ChatSession(config, dependencies);
  const server = createServer(async (req, res) => {
    res.setHeader("content-type", "application/json; charset=utf-8");
    try {
      if (req.method !== "POST") throw new Error("POST required.");
      const parts = [];
      let bytes = 0;
      for await (const part of req) {
        bytes += part.length;
        if (bytes > 32000) throw new Error("Request too large.");
        parts.push(part);
      }
      const input = JSON.parse(Buffer.concat(parts).toString() || "{}");
      const command = req.url.slice(1);
      let result;
      if (command === "status") result = await session.status();
      else if (command === "send") result = await session.send(input);
      else if (command === "read") result = await session.read(input);
      else if (command === "trace") result = await session.trace(input);
      else if (command === "down") {
        result = { stopped: true, pid: process.pid };
        setImmediate(() => {
          session.close();
          server.close();
        });
      } else throw new Error("Unknown chat operation.");
      res.end(JSON.stringify(result));
    } catch (error) {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: error.message }));
    }
  });
  // Bind before connecting. A second observer cannot become another journal writer.
  await new Promise((done, reject) => {
    server.once("error", reject);
    server.listen(config.socketPath, done);
  });
  chmodSync(config.socketPath, 0o600);
  try {
    await session.start();
  } catch (error) {
    session.close();
    server.close();
    throw error;
  }
  return {
    session,
    server,
    close: () => {
      session.close();
      server.close();
    },
  };
}
function args(argv) {
  const command = argv.shift() ?? "help";
  const options = {};
  const keys = new Set([
    "config",
    "chat",
    "text",
    "message-file",
    "request",
    "run",
    "after",
    "limit",
    "wait",
  ]);
  while (argv.length) {
    const flag = argv.shift();
    if (flag === "--no-at") {
      options.noAt = true;
      continue;
    }
    const key = flag.replace(/^--/, "");
    if (!flag.startsWith("--") || !keys.has(key) || !argv.length || options[key] !== undefined)
      throw new Error("Unknown or duplicate option: " + flag);
    options[key] = argv.shift();
  }
  return { command, options };
}
export async function main(argv = process.argv.slice(2)) {
  const { command, options: o } = args([...argv]);
  if (["help", "--help", "-h"].includes(command)) {
    console.log(help);
    return;
  }
  const configPath = resolve(o.config ?? defaultChatConfig());
  const config = chatConfig(JSON.parse(readFileSync(configPath, "utf8")));
  const call = (op, body) => rpc(config.socketPath, op, body);
  if (command === "serve") {
    const app = await serve(config);
    process.once("SIGTERM", app.close);
    process.once("SIGINT", app.close);
    return;
  }
  let result;
  if (command === "up") {
    try {
      result = await call("status");
    } catch (error) {
      if (!["ENOENT", "ECONNREFUSED"].includes(error.code)) throw error;
      mkdirSync(config.stateDirectory, { recursive: true, mode: 0o700 });
      chmodSync(config.stateDirectory, 0o700);
      try {
        const file = lstatSync(config.socketPath);
        if (!file.isSocket()) throw new Error("Unexpected object at chat socket path.");
        unlinkSync(config.socketPath);
      } catch (e) {
        if (e.code !== "ENOENT") throw e;
      }
      const log = openSync(join(config.stateDirectory, "observer.log"), "a", 0o600);
      const child = spawn(
        process.execPath,
        [fileURLToPath(import.meta.url), "serve", "--config", configPath],
        { detached: true, stdio: ["ignore", log, log] },
      );
      child.unref();
      closeSync(log);
      for (let attempt = 0; attempt < 30; attempt++) {
        await new Promise((done) => setTimeout(done, 300));
        try {
          result = await call("status");
          break;
        } catch (e) {
          if (!["ENOENT", "ECONNREFUSED"].includes(e.code)) throw e;
        }
      }
      if (!result) throw new Error("Observer did not start; inspect its local observer.log.");
    }
  } else if (command === "send") {
    if (Boolean(o.text !== undefined) === Boolean(o["message-file"] !== undefined))
      throw new Error("Provide --text or --message-file.");
    const seconds = Number(o.wait ?? 0);
    if (!Number.isFinite(seconds) || seconds < 0 || seconds > 600)
      throw new Error("wait must be 0 to 600 seconds.");
    const requestId = o.request ?? randomUUID();
    // Print the receipt ID before the network call, including when the client is interrupted.
    console.error(JSON.stringify({ requestId }));
    result = await call("send", {
      requestId,
      chat: o.chat ?? "private",
      text: o.text ?? readFileSync(resolve(o["message-file"]), "utf8"),
      atBot: !o.noAt,
    });
    if (seconds) {
      const deadline = Date.now() + seconds * 1000;
      while (Date.now() < deadline) {
        const observed = await call("trace", { requestId });
        result = observed;
        if (
          observed.runs.some((run) => ["succeeded", "failed", "cancelled"].includes(run.status)) &&
          observed.runs.some((run) => run.deliveries.some((delivery) => delivery.receivedByOwner))
        )
          break;
        await new Promise((done) => setTimeout(done, 1000));
      }
      result.observationOnly = true;
    }
  } else if (command === "read")
    result = await call("read", {
      after: Number(o.after ?? 0),
      limit: Number(o.limit ?? 100),
      ...(o.chat ? { chat: o.chat } : {}),
      waitMs: Number(o.wait ?? 0) * 1000,
    });
  else if (command === "trace")
    result = await call("trace", {
      ...(o.request ? { requestId: o.request } : {}),
      ...(o.run ? { runId: o.run } : {}),
      after: Number(o.after ?? 0),
      limit: Number(o.limit ?? 200),
    });
  else if (["status", "down"].includes(command)) result = await call(command);
  else throw new Error("Unknown command. Use help.");
  console.log(JSON.stringify(result, null, 2));
}
if (import.meta.url === pathToFileURL(resolve(process.argv[1] ?? "")).href)
  main().catch((error) => {
    console.error(JSON.stringify({ error: error.message }));
    process.exitCode = 1;
  });
