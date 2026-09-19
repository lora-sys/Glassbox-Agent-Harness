import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { CodexAdapter } from "../../codex/adapter.js";
import { createCodexHarnessAdapter } from "./codex.js";
import { createCodexEnvironment } from "./codex-config.js";
import { executionInput, harnessFixture } from "./test-fixtures.js";
import type { CodexHarnessOptions } from "./codex-types.js";
import type { HarnessEvent } from "./types.js";

const fixtures: Array<Awaited<ReturnType<typeof harnessFixture>>> = [];
const transports: CodexAdapter[] = [];
afterEach(async () => {
  await Promise.all(transports.splice(0).map((transport) => transport.shutdownAndWait(100)));
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.dispose()));
});

async function fixture(scenario = "success") {
  const item = await harnessFixture();
  fixtures.push(item);
  const proof = path.join(item.directory, "codex-proof.json");
  const code = `
    const fs = require('node:fs'), path = require('node:path'), rl = require('node:readline');
    const scenario = ${JSON.stringify(scenario)}, proofPath = ${JSON.stringify(proof)};
    const messages = [], responses = [];
    const proof = () => fs.writeFileSync(proofPath, JSON.stringify({pid:process.pid,cwd:process.cwd(),env:process.env,messages,responses}));
    const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
    const config = {};
    for(let i=0; i<process.argv.length; i++) if(process.argv[i]==='--config') {
      const entry=process.argv[++i], split=entry.indexOf('='), keys=entry.slice(0,split).split('.');
      let target=config; for(const key of keys.slice(0,-1)) target=target[key]??=( {} ); target[keys.at(-1)]=JSON.parse(entry.slice(split+1));
    }
    const complete = status => {
      send({method:'item/agentMessage/delta',params:{threadId:'native-thread',turnId:'native-turn',delta:scenario==='secret'?'fixture-api-secret-canary':'Hello from Codex.'}});
      send({method:'turn/completed',params:{threadId:'native-thread',turn:{id:'native-turn',status}}});
    };
    const reader = rl.createInterface({input:process.stdin});
    reader.on('line', line => {
      const m=JSON.parse(line);
      if(!m.method){responses.push(m);proof();if(m.id===901)complete('completed');return;}
      messages.push({method:m.method,params:m.method==='account/login/start'?{type:m.params.type}:m.params});proof();
      const reply=result=>send({id:m.id,result});
      if(m.method==='initialize') reply({userAgent:'codex_cli_rs/0.154.0',codexHome:process.env.CODEX_HOME});
      else if(m.method==='config/read') reply({config,layers:[{name:{type:'user',file:path.join(process.env.CODEX_HOME,'config.toml')},config:{}},...(scenario==='global'?[{name:{type:'system'},config:{instructions:'owner-private'}}]:[])],origins:{}});
      else if(m.method==='account/login/start') reply({type:'apiKey'});
      else if(m.method==='thread/start') reply({thread:{id:'native-thread'},cwd:process.cwd(),approvalPolicy:'never',approvalsReviewer:'user',sandbox:{type:'readOnly',networkAccess:false},instructionSources:scenario==='instructions'?['/private/AGENTS.md']:[],runtimeWorkspaceRoots:[]});
      else if(m.method==='fixture/emit'){reply({});for(const event of m.params)send(event);}
      else if(m.method==='turn/start') {
        reply({turn:{id:'native-turn',status:'inProgress'}});
        setImmediate(()=>{
          send({method:'turn/started',params:{threadId:'native-thread',turn:{id:'native-turn'}}});
          if(scenario==='tool') send({id:901,method:'item/tool/call',params:{threadId:'native-thread',turnId:'native-turn',callId:'call',tool:'write_note',arguments:{text:'authorized note'}}});
          else if(scenario==='approval') {send({id:902,method:'item/commandExecution/requestApproval',params:{threadId:'native-thread',turnId:'native-turn'}});send({id:901,method:'item/permissions/requestApproval',params:{threadId:'native-thread',turnId:'native-turn'}});}
          else if(scenario==='builtin') send({method:'item/started',params:{threadId:'native-thread',turnId:'native-turn',item:{type:'commandExecution'}}});
          else if(scenario==='crash')process.exit(3);
          else if(scenario!=='hang')complete(scenario==='failure'?'failed':'completed');
        });
      }
    });
    reader.on('close',()=>{proof();process.exit(0)});
  `;
  await writeFile(item.executablePath, code);
  const config: CodexHarnessOptions = {
    dataDirectory: item.config.dataDirectory,
    executablePath: item.executablePath,
    executionRef: item.config.executionRef,
    credentials: async () => ({ apiKey: "fixture-api-secret-canary" }),
    hostEnvironment: {
      SystemRoot: process.env.SystemRoot,
      OWNER_PRIVATE_CANARY: "private",
      NODE_OPTIONS: "--require owner.js",
      OPENAI_API_KEY: "ambient-secret",
    },
    executionTimeoutMs: 1500,
    exitTimeoutMs: 100,
  };
  return {
    ...item,
    config,
    readProof: async () =>
      JSON.parse(await readFile(proof, "utf8")) as {
        pid: number;
        cwd: string;
        env: Record<string, string>;
        messages: Array<{ method: string; params: Record<string, unknown> }>;
        responses: Array<{ id: number; result: unknown }>;
      },
  };
}

describe("installed Codex Owner Run boundary", () => {
  it("uses the installed protocol transport, isolated homes and only supplied history", async () => {
    const item = await fixture();
    const events: HarnessEvent[] = [];
    const adapter = createCodexHarnessAdapter({
      ...item.config,
      onEvent: (event) => {
        events.push(event);
      },
    });
    expect(adapter.supportsGroup).toBe(false);
    expect(await adapter.execute(executionInput())).toEqual({
      status: "succeeded",
      text: "Hello from Codex.",
      usage: null,
    });
    const proof = await item.readProof();
    expect(proof.env).not.toHaveProperty("OWNER_PRIVATE_CANARY");
    expect(proof.env).not.toHaveProperty("OPENAI_API_KEY");
    expect(proof.env).not.toHaveProperty("NODE_OPTIONS");
    expect(proof.env.CODEX_HOME).toContain(item.config.dataDirectory);
    expect(proof.env.HOME).toBe(proof.env.CODEX_HOME);
    expect(proof.cwd).toContain("workspace");
    const start = proof.messages.find((message) => message.method === "thread/start")!.params;
    expect(start).toMatchObject({
      environments: [],
      dynamicTools: [],
      ephemeral: true,
      approvalPolicy: "never",
    });
    const turn = proof.messages.find((message) => message.method === "turn/start")!.params;
    expect(JSON.parse((turn.input as Array<{ text: string }>)[0]!.text)).toEqual({
      history: executionInput().history,
      input: executionInput().text,
    });
    expect(JSON.stringify(proof.messages)).not.toContain("untrusted-old-session");
    expect(JSON.stringify(events)).not.toContain("fixture-api-secret-canary");
    expect(() => process.kill(proof.pid, 0)).toThrow();
  });

  it.each(["failure", "crash", "builtin", "instructions", "global", "secret"])(
    "fails closed for %s without success or raw data",
    async (scenario) => {
      const item = await fixture(scenario);
      const result = await createCodexHarnessAdapter(item.config).execute(executionInput());
      expect(result.status).toBe("failed");
      expect(result).not.toHaveProperty("text");
      expect(JSON.stringify(result)).not.toMatch(/owner-private|fixture-api-secret-canary|AGENTS/);
      if (scenario === "global")
        expect(
          (await item.readProof()).messages.some(
            (message) => message.method === "account/login/start",
          ),
        ).toBe(false);
    },
  );

  it("refuses group execution and a missing executable before credentials", async () => {
    const item = await fixture();
    const credentials = vi.fn(async () => item.config.credentials(executionInput()));
    const input = executionInput();
    input.caller.scope.chatType = "group";
    input.conversation.scope.chatType = "group";
    expect(
      (await createCodexHarnessAdapter({ ...item.config, credentials }).execute(input)).code,
    ).toBe("GROUP_ISOLATION_UNVERIFIED");
    expect(
      (
        await createCodexHarnessAdapter({
          ...item.config,
          credentials,
          executablePath: path.join(item.directory, "missing.exe"),
        }).execute(executionInput())
      ).code,
    ).toBe("EXECUTABLE_MISSING");
    expect(credentials).not.toHaveBeenCalled();
  });

  it("denies native execution and permission grants with the actual protocol shapes", async () => {
    const item = await fixture("approval");
    expect((await createCodexHarnessAdapter(item.config).execute(executionInput())).status).toBe(
      "succeeded",
    );
    expect((await item.readProof()).responses).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 902, result: { decision: "decline" } }),
        expect.objectContaining({ id: 901, result: { permissions: {}, scope: "turn" } }),
      ]),
    );
  });

  it.each([false, true])(
    "executes protected tools with both authorization checks, revoked=%s",
    async (revoked) => {
      const item = await fixture("tool");
      const execute = vi.fn(async (_args: unknown, context: { workspace: string }) => {
        await writeFile(path.join(context.workspace, "note.txt"), "authorized note");
        return "private tool result";
      });
      const authorize = vi.fn(
        async (_input: unknown, phase: string) => phase === "execute" || !revoked,
      );
      const result = await createCodexHarnessAdapter({
        ...item.config,
        protectedTools: [
          {
            name: "write_note",
            description: "Write an authorized note.",
            inputSchema: {
              type: "object",
              properties: { text: { type: "string" } },
              required: ["text"],
              additionalProperties: false,
            },
            parseArguments: (value) => value,
            authorize,
            execute,
          },
        ],
      }).execute(executionInput());
      expect(result.status).toBe("succeeded");
      expect(execute).toHaveBeenCalledOnce();
      expect(authorize.mock.calls.map((call) => call[1])).toEqual(["execute", "publish-result"]);
      const response = (await item.readProof()).responses.find((value) => value.id === 901)!;
      expect(response.result).toMatchObject({ success: !revoked });
      if (revoked) expect(JSON.stringify(response)).not.toContain("private tool result");
    },
  );

  it("returns cancelled only after the actual child exits", async () => {
    const item = await fixture("hang");
    const controller = new AbortController();
    const result = await createCodexHarnessAdapter({
      ...item.config,
      onEvent(event) {
        if (event.type === "started") controller.abort();
      },
    }).execute(executionInput({ signal: controller.signal }));
    expect(result).toEqual({ status: "cancelled", usage: null });
    const proof = await item.readProof();
    expect(() => process.kill(proof.pid, 0)).toThrow();
  });

  it("keeps an unfinished protected tool unknown and prevents another run in that conversation", async () => {
    const item = await fixture("tool");
    const controller = new AbortController();
    let release: (value: string) => void = () => {};
    const adapter = createCodexHarnessAdapter({
      ...item.config,
      protectedTools: [
        {
          name: "write_note",
          description: "Write a note.",
          inputSchema: { type: "object" },
          parseArguments: (value) => value,
          authorize: async () => true,
          execute: async () => {
            controller.abort();
            return new Promise<string>((resolve) => {
              release = resolve;
            });
          },
        },
      ],
    });
    const result = await adapter.execute(executionInput({ signal: controller.signal }));
    expect(result).toEqual({ status: "unknown", usage: null, code: "EXIT_UNCONFIRMED" });
    expect((await adapter.execute(executionInput())).code).toBe("INVALID_INPUT");
    release("late private result");
  });

  it("does not report a hanging provider as successful", async () => {
    const item = await fixture("hang");
    expect(
      await createCodexHarnessAdapter({ ...item.config, executionTimeoutMs: 300 }).execute(
        executionInput(),
      ),
    ).toEqual({ status: "failed", usage: null, code: "TIMED_OUT" });
  });

  it("starts a fresh native thread home on reopening, never resumes saved sessions", async () => {
    const item = await fixture();
    await createCodexHarnessAdapter(item.config).execute(executionInput());
    const before = (await item.readProof()).env.CODEX_HOME;
    await createCodexHarnessAdapter(item.config).execute(executionInput());
    expect((await item.readProof()).env.CODEX_HOME).not.toBe(before);
    expect((await item.readProof()).messages.map((message) => message.method)).not.toContain(
      "thread/resume",
    );
  });

  it("constructs Windows paths without inheriting arbitrary host fields", () => {
    const env = createCodexEnvironment({
      home: "C:\\data\\home",
      workspace: "C:\\data\\work",
      temp: "C:\\data\\temp",
      executablePath: "C:\\Apps\\Codex\\codex.exe",
      platform: "win32",
      hostEnvironment: { SystemRoot: "C:\\Windows", PATH: "C:\\owner", SECRET: "canary" },
    });
    expect(env.APPDATA).toBe("C:\\data\\home\\AppData\\Roaming");
    expect(env.PATH).not.toContain("owner");
    expect(env).not.toHaveProperty("SECRET");
  });
});

describe("shared Codex transport collectors", () => {
  it("filters concurrent thread/turn events and never manufactures terminal evidence on timeout", async () => {
    const item = await fixture();
    const transport = new CodexAdapter(item.executablePath, { quiet: true });
    transports.push(transport);
    transport.start();
    await transport.initialize();
    const first = vi.fn(),
      second = vi.fn(),
      ended = vi.fn();
    transport.registerOnTurnEnd(ended);
    const a = transport.collectTurnEvents("a", "turn-a", 200, first);
    const b = transport.collectTurnEvents("b", "turn-b", 80, second);
    await transport.requestProtocol("fixture/emit", [
      {
        method: "item/agentMessage/delta",
        params: { threadId: "a", turnId: "turn-a", delta: "A" },
      },
      {
        method: "item/agentMessage/delta",
        params: { threadId: "a", turnId: "unrelated", delta: "wrong" },
      },
      {
        method: "turn/completed",
        params: { threadId: "a", turn: { id: "turn-a", status: "completed" } },
      },
    ]);
    expect(await a).toMatchObject({ turnStatus: "completed", agentMessageDeltas: 1 });
    expect(await b).toMatchObject({ turnStatus: "inProgress", error: "OBSERVATION_TIMED_OUT" });
    expect(first).toHaveBeenCalledTimes(2);
    expect(second).not.toHaveBeenCalled();
    expect(ended).toHaveBeenCalledOnce();
  });
});
