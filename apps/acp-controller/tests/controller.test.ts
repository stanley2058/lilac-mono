import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import { saveRunRecord } from "../run-store.ts";
import { createEmptyPermissionCounters } from "../types.ts";

const CONTROLLER_DIR = path.resolve(import.meta.dir, "..");
const SDK_PATH = path.join(
  CONTROLLER_DIR,
  "node_modules",
  "@agentclientprotocol",
  "sdk",
  "dist",
  "acp.js",
);
const CLI_ENTRY = path.join(CONTROLLER_DIR, "client.ts");

type FakeSession = {
  sessionId: string;
  cwd: string;
  title?: string;
  updatedAt: string;
  history: Array<{ role: "user" | "assistant"; text: string }>;
  plan?: Array<{
    content: string;
    priority: "high" | "medium" | "low";
    status: "pending" | "in_progress" | "completed";
  }>;
};

type FakeHarnessConfig = {
  commandName: string;
  requiresAcpArg: boolean;
  harnessId: string;
  sessions: FakeSession[];
};

type ListedSession = {
  harnessId: string;
  sessionId: string;
  sessionRef: string;
  title?: string;
  cwd: string;
  updatedAt?: string;
  capabilities: string[];
};

type PromptRunRecord = {
  history?: Array<{ role: "user" | "assistant"; text: string }>;
};

let tempRoot = "";

async function makeTempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "lilac-acp-controller-test-"));
}

async function createFakeHarness(root: string, config: FakeHarnessConfig): Promise<void> {
  const binDir = path.join(root, "bin");
  await fs.mkdir(binDir, { recursive: true });

  const statePath = path.join(root, `${config.commandName}.json`);
  await fs.writeFile(
    statePath,
    JSON.stringify(
      { nextSessionId: config.sessions.length + 1, sessions: config.sessions },
      null,
      2,
    ),
    "utf8",
  );

  const scriptPath = path.join(binDir, config.commandName);
  const script = [
    "#!/usr/bin/env bun",
    'import fs from "node:fs/promises";',
    'import { Readable, Writable } from "node:stream";',
    `const acp = await import(${JSON.stringify(SDK_PATH)});`,
    `const statePath = ${JSON.stringify(statePath)};`,
    `const harnessId = ${JSON.stringify(config.harnessId)};`,
    `const requiresAcpArg = ${JSON.stringify(config.requiresAcpArg)};`,
    "",
    'if (requiresAcpArg && process.argv[2] !== "acp") {',
    '  process.stderr.write("expected acp subcommand\\n");',
    "  process.exit(1);",
    "}",
    "",
    "function nowIso() {",
    "  return new Date().toISOString();",
    "}",
    "",
    "async function readState() {",
    '  return JSON.parse(await fs.readFile(statePath, "utf8"));',
    "}",
    "",
    "async function writeState(state) {",
    '  await fs.writeFile(statePath, JSON.stringify(state, null, 2), "utf8");',
    "}",
    "",
    "function delay(signal, ms) {",
    "  return new Promise((resolve, reject) => {",
    "    const timer = setTimeout(resolve, ms);",
    "    signal.addEventListener(",
    '      "abort",',
    "      () => {",
    "        clearTimeout(timer);",
    '        reject(new Error("aborted"));',
    "      },",
    "      { once: true },",
    "    );",
    "  });",
    "}",
    "",
    "class FakeAgent {",
    "  constructor(connection) {",
    "    this.connection = connection;",
    "    this.pending = new Map();",
    "  }",
    "",
    "  async initialize() {",
    "    return {",
    "      protocolVersion: acp.PROTOCOL_VERSION,",
    "      agentCapabilities: {",
    "        loadSession: true,",
    "        sessionCapabilities: { list: {}, resume: {} },",
    "      },",
    "      authMethods: [],",
    "    };",
    "  }",
    "",
    "  async authenticate() {",
    "    return {};",
    "  }",
    "",
    "  async listSessions(params) {",
    "    const state = await readState();",
    "    return {",
    "      sessions: state.sessions",
    "        .filter((session) => !params.cwd || session.cwd === params.cwd)",
    "        .map((session) => ({",
    "          sessionId: session.sessionId,",
    "          cwd: session.cwd,",
    "          title: session.title,",
    "          updatedAt: session.updatedAt,",
    "        })),",
    "    };",
    "  }",
    "",
    "  async newSession(params) {",
    "    const state = await readState();",
    '    const sessionId = "sess_" + harnessId + "_" + state.nextSessionId;',
    "    state.nextSessionId += 1;",
    "    state.sessions.push({",
    "      sessionId,",
    "      cwd: params.cwd,",
    "      title: undefined,",
    "      updatedAt: nowIso(),",
    "      history: [],",
    "      plan: [],",
    "    });",
    "    await writeState(state);",
    "    return { sessionId };",
    "  }",
    "",
    "  async loadSession(params) {",
    "    const state = await readState();",
    "    const session = state.sessions.find((candidate) => candidate.sessionId === params.sessionId);",
    "    if (!session) throw new Error(`missing session ${params.sessionId}`);",
    "    await this.replaySession(session);",
    "    return {};",
    "  }",
    "",
    "  async unstable_resumeSession(params) {",
    "    return this.loadSession(params);",
    "  }",
    "",
    "  async setSessionMode() {",
    "    return {};",
    "  }",
    "",
    "  async unstable_setSessionModel() {",
    "    return {};",
    "  }",
    "",
    "  async prompt(params) {",
    "    const state = await readState();",
    "    const session = state.sessions.find((candidate) => candidate.sessionId === params.sessionId);",
    "    if (!session) throw new Error(`missing session ${params.sessionId}`);",
    '    const promptText = params.prompt.filter((part) => part.type === "text").map((part) => part.text).join("");',
    '    session.history.push({ role: "user", text: promptText });',
    "    session.updatedAt = nowIso();",
    '    session.plan = [{ content: `Inspect ${promptText}`, priority: "high", status: "completed" }];',
    "    await writeState(state);",
    "",
    "    await this.connection.sessionUpdate({",
    "      sessionId: params.sessionId,",
    "      update: {",
    '        sessionUpdate: "plan",',
    "        entries: session.plan,",
    "      },",
    "    });",
    "",
    "    const controller = new AbortController();",
    "    this.pending.set(params.sessionId, controller);",
    "    try {",
    '      await delay(controller.signal, promptText.includes("sleep") ? 1200 : 50);',
    "    } catch {",
    "      this.pending.delete(params.sessionId);",
    '      return { stopReason: "cancelled", userMessageId: params.messageId };',
    "    }",
    "",
    "    const reply = `Completed ${promptText} via ${harnessId}`;",
    '    session.history.push({ role: "assistant", text: reply });',
    "    session.updatedAt = nowIso();",
    "    await writeState(state);",
    "",
    "    await this.connection.sessionUpdate({",
    "      sessionId: params.sessionId,",
    "      update: {",
    '        sessionUpdate: "agent_message_chunk",',
    '        content: { type: "text", text: reply },',
    "      },",
    "    });",
    "",
    "    this.pending.delete(params.sessionId);",
    '    return { stopReason: "end_turn", userMessageId: params.messageId };',
    "  }",
    "",
    "  async cancel(params) {",
    "    this.pending.get(params.sessionId)?.abort();",
    "  }",
    "",
    "  async replaySession(session) {",
    "    if (session.title) {",
    "      await this.connection.sessionUpdate({",
    "        sessionId: session.sessionId,",
    "        update: {",
    '          sessionUpdate: "session_info_update",',
    "          title: session.title,",
    "          updatedAt: session.updatedAt,",
    "        },",
    "      });",
    "    }",
    "    if (session.plan && session.plan.length > 0) {",
    "      await this.connection.sessionUpdate({",
    "        sessionId: session.sessionId,",
    "        update: {",
    '          sessionUpdate: "plan",',
    "          entries: session.plan,",
    "        },",
    "      });",
    "    }",
    "    for (const message of session.history) {",
    "      await this.connection.sessionUpdate({",
    "        sessionId: session.sessionId,",
    "        update: {",
    '          sessionUpdate: message.role === "user" ? "user_message_chunk" : "agent_message_chunk",',
    '          content: { type: "text", text: message.text },',
    "        },",
    "      });",
    "    }",
    "  }",
    "}",
    "",
    "const stream = acp.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin));",
    "new acp.AgentSideConnection((connection) => new FakeAgent(connection), stream);",
    "",
  ].join("\n");

  await fs.writeFile(scriptPath, script, "utf8");
  await fs.chmod(scriptPath, 0o755);
}

async function runCli(
  root: string,
  args: string[],
): Promise<{ parsed: unknown; exitCode: number }> {
  const env = {
    ...process.env,
    PATH: `${path.join(root, "bin")}${path.delimiter}${process.env.PATH ?? ""}`,
    XDG_STATE_HOME: path.join(root, "state"),
  };
  const proc = Bun.spawn(["bun", CLI_ENTRY, ...args], {
    cwd: CONTROLLER_DIR,
    env,
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (stderr.trim().length > 0) {
    throw new Error(`Unexpected stderr: ${stderr}`);
  }
  return { parsed: JSON.parse(stdout), exitCode };
}

beforeEach(async () => {
  tempRoot = await makeTempDir();
});

afterEach(async () => {
  if (tempRoot) {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

describe("lilac-acp controller", () => {
  it("merges sessions across discovered harnesses", async () => {
    await createFakeHarness(tempRoot, {
      commandName: "opencode",
      requiresAcpArg: true,
      harnessId: "opencode",
      sessions: [
        {
          sessionId: "sess_opencode_1",
          cwd: "/repo",
          title: "shared exact title",
          updatedAt: "2026-03-11T00:00:00.000Z",
          history: [],
        },
      ],
    });
    await createFakeHarness(tempRoot, {
      commandName: "codex-acp",
      requiresAcpArg: false,
      harnessId: "codex-acp",
      sessions: [
        {
          sessionId: "sess_codex_1",
          cwd: "/repo",
          title: "shared exact title",
          updatedAt: "2026-03-10T00:00:00.000Z",
          history: [],
        },
      ],
    });

    const result = (await runCli(tempRoot, [
      "sessions",
      "list",
      "--directory",
      "/repo",
      "--search",
      "shared",
    ])) as { parsed: { ok: boolean; sessions: ListedSession[] }; exitCode: number };

    expect(result.exitCode).toBe(0);
    expect(result.parsed.ok).toBe(true);
    expect(result.parsed.sessions).toHaveLength(2);
    expect(result.parsed.sessions.map((session) => session.harnessId).sort()).toEqual([
      "codex-acp",
      "opencode",
    ]);
  });

  it("errors on ambiguous exact title matches without --harness", async () => {
    await createFakeHarness(tempRoot, {
      commandName: "opencode",
      requiresAcpArg: true,
      harnessId: "opencode",
      sessions: [
        {
          sessionId: "sess_opencode_1",
          cwd: "/repo",
          title: "shared exact title",
          updatedAt: "2026-03-11T00:00:00.000Z",
          history: [],
        },
      ],
    });
    await createFakeHarness(tempRoot, {
      commandName: "codex-acp",
      requiresAcpArg: false,
      harnessId: "codex-acp",
      sessions: [
        {
          sessionId: "sess_codex_1",
          cwd: "/repo",
          title: "shared exact title",
          updatedAt: "2026-03-10T00:00:00.000Z",
          history: [],
        },
      ],
    });

    const result = (await runCli(tempRoot, [
      "prompt",
      "submit",
      "--directory",
      "/repo",
      "--title",
      "shared exact title",
      "--text",
      "continue",
    ])) as {
      parsed: { ok: boolean; candidates?: ListedSession[]; error: string };
      exitCode: number;
    };

    expect(result.exitCode).toBe(1);
    expect(result.parsed.ok).toBe(false);
    expect(result.parsed.candidates).toHaveLength(2);
    expect(result.parsed.error).toContain("exact title match");
  });

  it("refreshes remote session titles instead of pinning the first synced title", async () => {
    const statePath = path.join(tempRoot, "opencode.json");
    await createFakeHarness(tempRoot, {
      commandName: "opencode",
      requiresAcpArg: true,
      harnessId: "opencode",
      sessions: [
        {
          sessionId: "sess_opencode_1",
          cwd: "/repo",
          title: "initial title",
          updatedAt: "2026-03-11T00:00:00.000Z",
          history: [],
        },
      ],
    });

    const first = (await runCli(tempRoot, [
      "sessions",
      "list",
      "--directory",
      "/repo",
      "--harness",
      "opencode",
    ])) as { parsed: { sessions: ListedSession[] }; exitCode: number };
    expect(first.exitCode).toBe(0);
    expect(first.parsed.sessions[0]?.title).toBe("initial title");

    const state = JSON.parse(await fs.readFile(statePath, "utf8")) as {
      nextSessionId: number;
      sessions: FakeSession[];
    };
    state.sessions[0] = {
      ...state.sessions[0]!,
      title: "renamed title",
      updatedAt: "2026-03-12T00:00:00.000Z",
    };
    await fs.writeFile(statePath, JSON.stringify(state, null, 2), "utf8");

    const second = (await runCli(tempRoot, [
      "sessions",
      "list",
      "--directory",
      "/repo",
      "--harness",
      "opencode",
    ])) as { parsed: { sessions: ListedSession[] }; exitCode: number };
    expect(second.exitCode).toBe(0);
    expect(second.parsed.sessions[0]?.title).toBe("renamed title");
  });

  it("persists detached worker results for wait and result", async () => {
    await createFakeHarness(tempRoot, {
      commandName: "opencode",
      requiresAcpArg: true,
      harnessId: "opencode",
      sessions: [],
    });

    const submit = (await runCli(tempRoot, [
      "prompt",
      "submit",
      "--directory",
      "/repo",
      "--harness",
      "opencode",
      "--text",
      "build feature",
    ])) as { parsed: { ok: boolean; runId: string }; exitCode: number };

    expect(submit.exitCode).toBe(0);

    const wait = (await runCli(tempRoot, ["prompt", "wait", "--run-id", submit.parsed.runId])) as {
      parsed: { ok: boolean; status: string; resultText?: string };
      exitCode: number;
    };
    expect(wait.exitCode).toBe(0);
    expect(wait.parsed.ok).toBe(true);
    expect(wait.parsed.status).toBe("completed");
    expect(wait.parsed.resultText).toContain("Completed build feature via opencode");

    const result = (await runCli(tempRoot, [
      "prompt",
      "result",
      "--run-id",
      submit.parsed.runId,
    ])) as {
      parsed: { ok: boolean; run: PromptRunRecord };
      exitCode: number;
    };
    expect(result.exitCode).toBe(0);
    expect(result.parsed.run.history?.at(-1)?.text).toContain(
      "Completed build feature via opencode",
    );
  });

  it("restarts submitted runs whose background worker disappeared", async () => {
    await createFakeHarness(tempRoot, {
      commandName: "opencode",
      requiresAcpArg: true,
      harnessId: "opencode",
      sessions: [],
    });

    const previousStateHome = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = path.join(tempRoot, "state");
    try {
      await saveRunRecord({
        id: "run_11111111-1111-4111-8111-111111111111",
        status: "submitted",
        createdAt: Date.now(),
        updatedAt: Date.now(),
        directory: "/repo",
        harnessId: "opencode",
        targetKind: "new",
        promptText: "build feature",
        textPreview: "build feature",
        compatibilityBin: "lilac-acp",
        permissions: createEmptyPermissionCounters(),
        workerPid: 999_999,
      });
    } finally {
      if (previousStateHome === undefined) {
        delete process.env.XDG_STATE_HOME;
      } else {
        process.env.XDG_STATE_HOME = previousStateHome;
      }
    }

    const wait = (await runCli(tempRoot, [
      "prompt",
      "wait",
      "--run-id",
      "run_11111111-1111-4111-8111-111111111111",
    ])) as {
      parsed: { ok: boolean; status: string; resultText?: string };
      exitCode: number;
    };

    expect(wait.exitCode).toBe(0);
    expect(wait.parsed.ok).toBe(true);
    expect(wait.parsed.status).toBe("completed");
    expect(wait.parsed.resultText).toContain("Completed build feature via opencode");
  });

  it("cancels running prompts through the worker", async () => {
    await createFakeHarness(tempRoot, {
      commandName: "opencode",
      requiresAcpArg: true,
      harnessId: "opencode",
      sessions: [],
    });

    const submit = (await runCli(tempRoot, [
      "prompt",
      "submit",
      "--directory",
      "/repo",
      "--harness",
      "opencode",
      "--text",
      "sleep please",
    ])) as { parsed: { ok: boolean; runId: string }; exitCode: number };

    expect(submit.exitCode).toBe(0);

    const cancel = (await runCli(tempRoot, [
      "prompt",
      "cancel",
      "--run-id",
      submit.parsed.runId,
    ])) as {
      parsed: { ok: boolean };
      exitCode: number;
    };
    expect(cancel.exitCode).toBe(0);
    expect(cancel.parsed.ok).toBe(true);

    const wait = (await runCli(tempRoot, ["prompt", "wait", "--run-id", submit.parsed.runId])) as {
      parsed: { ok: boolean; status: string };
      exitCode: number;
    };
    expect(wait.exitCode).toBe(1);
    expect(wait.parsed.ok).toBe(false);
    expect(wait.parsed.status).toBe("cancelled");
  });
});
