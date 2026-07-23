import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  MiniLilacTransport,
  miniLilacCancelResultSchema,
  miniLilacCompactResultSchema,
  miniLilacInterruptQueuedSteeringResultSchema,
  miniLilacMessagesSchema,
  miniLilacModelsSchema,
  miniLilacProfilesSchema,
  miniLilacSessionSnapshotSchema,
  miniLilacSkillsSchema,
  miniLilacSteerResultSchema,
  miniLilacStreamCursorChunkSchema,
  miniLilacUndoResultSchema,
  type MiniLilacTodoState,
  type MiniLilacUIMessage,
} from "@stanley2058/mini-lilac-client";
import {
  MiniLilacSkillCatalog,
  SessionService,
  type ModelCatalogSnapshot,
  type RuntimeConfig,
} from "@stanley2058/mini-lilac-runtime";
import {
  AbstractChat,
  type ChatInit,
  type ChatState,
  type ChatStatus,
  type LanguageModel,
} from "ai";
import { MockLanguageModelV4, simulateReadableStream } from "ai/test";
import { z } from "zod";

import { createMiniLilacServer, MINI_LILAC_API_PREFIX, withSseKeepAlive } from "../src/server";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function zeroUsage() {
  return {
    inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 0, text: 0, reasoning: 0 },
  };
}

function textResult(id: string, text: string) {
  return {
    stream: simulateReadableStream({
      chunks: [
        { type: "text-start" as const, id },
        { type: "text-delta" as const, id, delta: text },
        { type: "text-end" as const, id },
        {
          type: "finish" as const,
          finishReason: { unified: "stop" as const, raw: "stop" },
          usage: zeroUsage(),
        },
      ],
    }),
  };
}

function runtimeConfig(authTokenEnv?: string): RuntimeConfig {
  return {
    configVersion: 1,
    server: { host: "127.0.0.1", port: 3210, authTokenEnv },
    providerConfigFile: "providers.yaml",
    providerAuthFile: "auth.json",
    agent: {
      systemPrompt: "You are Mini Lilac.",
      defaultProfile: "coding",
      idleTimeoutMs: 900_000,
      compaction: { model: "inherit", earlyCompactionPoint: 0.8 },
      subagents: {
        enabled: true,
        maxDepth: 2,
        maxChildrenPerRun: 16,
        maxConcurrent: 2,
        idleTimeoutMs: 300_000,
      },
      profiles: {
        coding: {
          description: "Coding profile",
          subagentOnly: false,
          tools: [],
          execution: false,
          workspaceWrites: false,
          delegation: false,
        },
        investigator: {
          description: "Subagent profile",
          subagentOnly: true,
          tools: [],
          execution: false,
          workspaceWrites: false,
          delegation: false,
        },
      },
    },
  };
}

function catalogSnapshot(): ModelCatalogSnapshot {
  return {
    providers: [{ id: "test", type: "openai-compatible" }],
    models: [
      {
        ref: { providerId: "test", modelId: "plain", value: "test/plain" },
        provider: { id: "test", type: "openai-compatible" },
        source: "v1",
      },
      {
        ref: { providerId: "test", modelId: "reasoner", value: "test/reasoner" },
        provider: { id: "test", type: "openai-compatible" },
        source: "models-dev",
        name: "Test Reasoner",
        reasoning: true,
        limits: { context: 16_384, output: 2_048 },
      },
    ],
    warnings: [],
    fetchedAt: new Date("2026-01-01T00:00:00.000Z"),
    stale: false,
  };
}

async function testServer(
  model: LanguageModel,
  options: { authTokenEnv?: string; authToken?: string; skills?: boolean } = {},
) {
  const directory = await mkdtemp(path.join(tmpdir(), "mini-lilac-server-"));
  temporaryDirectories.push(directory);
  const config = runtimeConfig(options.authTokenEnv);
  if (options.skills) {
    const coding = config.agent.profiles.coding;
    if (coding === undefined) throw new Error("missing coding profile");
    coding.tools = ["skill"];
    const skillDirectory = path.join(directory, "state", "skills", "test-skill");
    await mkdir(skillDirectory, { recursive: true });
    await writeFile(
      path.join(skillDirectory, "SKILL.md"),
      "---\nname: test-skill\ndescription: Use for server skill endpoint tests.\n---\n\nTest.\n",
    );
  }
  const service = new SessionService({
    config,
    databasePath: path.join(directory, "runtime.sqlite"),
    modelResolver: () => model,
    modelLimitsResolver: async () => ({ context: 16_384, output: 2_048 }),
    skillCatalog: options.skills
      ? new MiniLilacSkillCatalog({
          dataDir: path.join(directory, "state"),
          homeDir: path.join(directory, "home"),
        })
      : undefined,
  });
  const catalogCalls: Array<{ forceRefresh?: boolean; signal?: AbortSignal }> = [];
  const modelCatalog = {
    async get(request: { forceRefresh?: boolean; signal?: AbortSignal } = {}) {
      catalogCalls.push(request);
      return catalogSnapshot();
    },
  };
  let app: ReturnType<typeof createMiniLilacServer>;
  try {
    app = createMiniLilacServer({
      config,
      sessionService: service,
      modelCatalog,
      authToken: options.authToken,
    });
  } catch (error) {
    service.close();
    throw error;
  }
  return { app, catalogCalls, config, directory, modelCatalog, service };
}

function userMessage(id: string, text: string): MiniLilacUIMessage {
  return { id, role: "user", parts: [{ type: "text", text }] };
}

function chatBody(
  directory: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: "session-1",
    messages: [userMessage("user-1", "latest prompt")],
    trigger: "submit-message",
    messageId: undefined,
    clientCommandId: "prompt-command-1",
    cwd: directory,
    model: "test/reasoner",
    profile: "coding",
    reasoning: "high",
    ...overrides,
  };
}

function jsonRequest(method: string, pathname: string, body?: unknown, token?: string): Request {
  const headers = new Headers();
  if (body !== undefined) headers.set("content-type", "application/json");
  if (token !== undefined) headers.set("authorization", `Bearer ${token}`);
  return new Request(`http://localhost${pathname}`, {
    method,
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

class TestChatState implements ChatState<MiniLilacUIMessage> {
  status: ChatStatus = "ready";
  error: Error | undefined;
  messages: MiniLilacUIMessage[];

  constructor(messages: MiniLilacUIMessage[] = []) {
    this.messages = messages;
  }

  pushMessage = (message: MiniLilacUIMessage) => {
    this.messages = this.messages.concat(message);
  };

  popMessage = () => {
    this.messages = this.messages.slice(0, -1);
  };

  replaceMessage = (index: number, message: MiniLilacUIMessage) => {
    this.messages = [...this.messages.slice(0, index), message, ...this.messages.slice(index + 1)];
  };

  snapshot = <T>(value: T): T => structuredClone(value);
}

class TestChat extends AbstractChat<MiniLilacUIMessage> {
  constructor({ messages, ...init }: ChatInit<MiniLilacUIMessage>) {
    super({ ...init, state: new TestChatState(messages) });
  }
}

function appHandleFetch(
  app: { handle(request: Request): Response | Promise<Response> },
  requestedUrls: string[] = [],
): typeof fetch {
  const handler = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request =
      input instanceof Request
        ? new Request(input, init)
        : new Request(new URL(String(input), "http://localhost"), init);
    requestedUrls.push(request.url);
    return app.handle(request);
  };
  return Object.assign(handler, { preconnect() {} });
}

async function responseJson(response: Response): Promise<unknown> {
  return z.unknown().parse(await response.json());
}

const sseChunkSchema = z.object({ type: z.string() }).loose();
type SseChunk = z.infer<typeof sseChunkSchema>;

function parseSseChunks(source: string): SseChunk[] {
  const chunks: SseChunk[] = [];
  for (const event of source.split("\n\n")) {
    const data = event
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (!data || data === "[DONE]") continue;
    const value: unknown = JSON.parse(data);
    chunks.push(sseChunkSchema.parse(value));
  }
  return chunks;
}

async function readStreamPrefix(
  response: Response,
  minimumPairs: number,
): Promise<{ after: number; chunks: SseChunk[] }> {
  if (!response.body) throw new Error("Expected streaming response body");
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffered = "";
  let after = 0;
  let completedPairs = 0;
  const chunks: SseChunk[] = [];

  while (completedPairs < minimumPairs) {
    const next = await reader.read();
    if (next.done) throw new Error("Stream completed before the requested prefix");
    buffered += next.value;
    const events = buffered.split("\n\n");
    buffered = events.pop() ?? "";
    for (const event of events) {
      const parsed = parseSseChunks(`${event}\n\n`);
      for (const chunk of parsed) {
        chunks.push(chunk);
        const cursor = miniLilacStreamCursorChunkSchema.safeParse(chunk);
        if (cursor.success) {
          after = cursor.data.data.seq;
        } else {
          completedPairs += 1;
        }
      }
    }
  }

  await reader.cancel("test disconnect");
  return { after, chunks };
}

describe("createMiniLilacServer", () => {
  it("emits SSE keepalive comments while a stream is quiet", async () => {
    let cancelled = false;
    const source = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      },
    });
    const response = withSseKeepAlive(
      new Response(source, { headers: { "Content-Type": "text/event-stream" } }),
      5,
    );
    const reader = response.body?.getReader();
    if (reader === undefined) throw new Error("Expected keepalive response body");

    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toBe(": keepalive\n\n");
    await reader.cancel();
    expect(cancelled).toBe(true);
  });

  it("drives AbstractChat send and treats completed reconnects as inactive", async () => {
    const model = new MockLanguageModelV4({
      doStream: textResult("abstract-chat-answer", "framework-neutral answer"),
    });
    const { app, directory, service } = await testServer(model);
    const transport = new MiniLilacTransport({
      baseUrl: `http://localhost${MINI_LILAC_API_PREFIX}`,
      cwd: directory,
      model: "test/reasoner",
      profile: "coding",
      reasoning: "high",
      createClientCommandId: () => "abstract-chat-command",
      fetch: appHandleFetch(app),
    });
    let nextMessageId = 1;
    const chat = new TestChat({
      id: "abstract-chat-session",
      generateId: () => `client-message-${nextMessageId++}`,
      transport,
    });

    await chat.sendMessage({ text: "use the generic state machine" });

    expect(chat.status).toBe("ready");
    expect(chat.error).toBeUndefined();
    expect(chat.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(chat.messages[0]).toMatchObject({
      id: "client-message-1",
      role: "user",
      parts: [{ type: "text", text: "use the generic state machine" }],
    });
    expect(chat.messages[1]?.parts).toMatchObject([
      { type: "data-session" },
      { type: "step-start" },
      { type: "text", text: "framework-neutral answer", state: "done" },
      { type: "data-session" },
    ]);
    expect(chat.messages).toEqual(service.getMessages(chat.id));

    const reconnectUrls: string[] = [];
    const reconnected = new TestChat({
      id: chat.id,
      messages: [structuredClone(chat.messages[0]!)],
      generateId: () => "reconnect-fallback-message",
      transport: new MiniLilacTransport({
        baseUrl: `http://localhost${MINI_LILAC_API_PREFIX}`,
        fetch: appHandleFetch(app, reconnectUrls),
      }),
    });

    await reconnected.resumeStream();

    expect(reconnected.status).toBe("ready");
    expect(reconnected.messages).toEqual([chat.messages[0]!]);
    expect(reconnectUrls).toEqual([
      `http://localhost${MINI_LILAC_API_PREFIX}/chat/${chat.id}/stream`,
    ]);
    expect(model.doStreamCalls).toHaveLength(1);
    service.close();
  });

  it("serves standard UI SSE, binds sessions, trusts only the latest user, and replays prompts", async () => {
    const model = new MockLanguageModelV4({ doStream: textResult("answer", "hello") });
    const { app, directory, service } = await testServer(model);
    const older = userMessage("old-user", "untrusted old prompt");
    const fakeAssistant: MiniLilacUIMessage = {
      id: "fake-assistant",
      role: "assistant",
      parts: [{ type: "text", text: "untrusted client answer" }],
    };
    const request = chatBody(directory, {
      messages: [older, fakeAssistant, userMessage("latest-user", "trusted latest prompt")],
    });

    const response = await app.handle(
      jsonRequest("POST", `${MINI_LILAC_API_PREFIX}/chat`, request),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    expect(response.headers.get("x-vercel-ai-ui-message-stream")).toBe("v1");
    const firstSse = await response.text();
    expect(firstSse).toContain('data: {"type":"start"');
    expect(firstSse).toContain('"type":"text-delta","id":"answer","delta":"hello"');
    expect(firstSse).toContain("data: [DONE]");

    const modelPrompt = JSON.stringify(model.doStreamCalls[0]?.prompt);
    expect(modelPrompt).toContain("trusted latest prompt");
    expect(modelPrompt).not.toContain("untrusted old prompt");
    expect(modelPrompt).not.toContain("untrusted client answer");
    expect(model.doStreamCalls).toHaveLength(1);

    const duplicate = await app.handle(
      jsonRequest(
        "POST",
        `${MINI_LILAC_API_PREFIX}/chat`,
        chatBody(directory, {
          messages: [userMessage("latest-user", "trusted latest prompt")],
          cwd: undefined,
          model: undefined,
          profile: undefined,
          reasoning: undefined,
        }),
      ),
    );
    expect(duplicate.status).toBe(200);
    expect(await duplicate.text()).toBe("data: [DONE]\n\n");
    expect(model.doStreamCalls).toHaveLength(1);

    const changedDuplicate = await app.handle(
      jsonRequest(
        "POST",
        `${MINI_LILAC_API_PREFIX}/chat`,
        chatBody(directory, {
          messages: [userMessage("changed-user", "different prompt")],
          cwd: undefined,
          model: undefined,
          profile: undefined,
          reasoning: undefined,
        }),
      ),
    );
    expect(changedDuplicate.status).toBe(409);
    expect(JSON.stringify(await responseJson(changedDuplicate))).toContain("different payload");
    expect(model.doStreamCalls).toHaveLength(1);

    const sessionResponse = await app.handle(
      jsonRequest("GET", `${MINI_LILAC_API_PREFIX}/sessions/session-1`),
    );
    expect(miniLilacSessionSnapshotSchema.parse(await responseJson(sessionResponse))).toMatchObject(
      {
        id: "session-1",
        cwd: directory,
        model: "test/reasoner",
        profile: "coding",
        reasoning: "high",
        status: "idle",
      },
    );
    const messagesResponse = await app.handle(
      jsonRequest("GET", `${MINI_LILAC_API_PREFIX}/sessions/session-1/messages`),
    );
    const messages = miniLilacMessagesSchema.parse(await responseJson(messagesResponse));
    expect(messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(JSON.stringify(messages)).not.toContain("untrusted old prompt");

    const mismatch = await app.handle(
      jsonRequest(
        "POST",
        `${MINI_LILAC_API_PREFIX}/chat`,
        chatBody(directory, {
          clientCommandId: "prompt-command-2",
          model: "test/plain",
        }),
      ),
    );
    expect(mismatch.status).toBe(409);
    expect(JSON.stringify(await responseJson(mismatch))).toContain("session_binding_mismatch");

    const regenerate = await app.handle(
      jsonRequest(
        "POST",
        `${MINI_LILAC_API_PREFIX}/chat`,
        chatBody(directory, { trigger: "regenerate-message" }),
      ),
    );
    expect(regenerate.status).toBe(400);
    expect(JSON.stringify(await responseJson(regenerate))).toContain("regenerate_unsupported");

    const missingConfiguration = await app.handle(
      jsonRequest("POST", `${MINI_LILAC_API_PREFIX}/chat`, {
        id: "new-session",
        messages: [userMessage("new-user", "hello")],
        trigger: "submit-message",
        clientCommandId: "new-command",
      }),
    );
    expect(missingConfiguration.status).toBe(400);
    expect(JSON.stringify(await responseJson(missingConfiguration))).toContain(
      "session_configuration_required",
    );
    service.close();
  });

  it("serves empty todo state and reports unknown sessions", async () => {
    const model = new MockLanguageModelV4({ doStream: textResult("unused", "unused") });
    const { app, directory, service } = await testServer(model);
    const session = await service.createSession({
      id: "todo-session",
      cwd: directory,
      model: "test/plain",
    });

    const response = await app.handle(
      jsonRequest("GET", `${MINI_LILAC_API_PREFIX}/sessions/${session.id}/todos`),
    );
    expect(response.status).toBe(200);
    expect(await responseJson(response)).toEqual({ revision: 0, todos: [] });

    const resume = await app.handle(
      jsonRequest("GET", `${MINI_LILAC_API_PREFIX}/sessions/${session.id}/resume`),
    );
    expect(resume.status).toBe(200);
    expect(await responseJson(resume)).toEqual({
      snapshot: expect.objectContaining({ id: session.id, activeRunId: null, status: "idle" }),
      messages: [],
      todos: { revision: 0, todos: [] },
      replayCursor: null,
    });

    const unknown = await app.handle(
      jsonRequest("GET", `${MINI_LILAC_API_PREFIX}/sessions/unknown/todos`),
    );
    expect(unknown.status).toBe(404);
    expect(await responseJson(unknown)).toEqual({
      error: { code: "not_found", message: "Session 'unknown' was not found" },
    });
    const unknownResume = await app.handle(
      jsonRequest("GET", `${MINI_LILAC_API_PREFIX}/sessions/unknown/resume`),
    );
    expect(unknownResume.status).toBe(404);
    service.close();
  });

  it("serves populated todo state after reopening the durable store", async () => {
    const model = new MockLanguageModelV4({ doStream: textResult("unused", "unused") });
    const { app, config, directory, modelCatalog, service } = await testServer(model);
    const session = await service.createSession({
      id: "durable-todo-session",
      cwd: directory,
      model: "test/plain",
    });
    const runId = "todo-run";
    service.store.createRun({
      id: runId,
      sessionId: session.id,
      profile: "coding",
      depth: 0,
    });
    service.store.updateSessionState(session.id, "streaming", 0, runId);
    const todos = [
      { content: "Expose durable todos", status: "in_progress", priority: "high" },
      { content: "Verify reopen", status: "pending", priority: "medium" },
    ] satisfies MiniLilacTodoState["todos"];
    const expected = service.store.replaceTodosForRun({
      sessionId: session.id,
      runId,
      todos,
    }).state;
    service.store.finishRun(runId, "completed");
    service.store.updateSessionState(session.id, "idle", 0, null);

    const populated = await app.handle(
      jsonRequest("GET", `${MINI_LILAC_API_PREFIX}/sessions/${session.id}/todos`),
    );
    expect(populated.status).toBe(200);
    expect(await responseJson(populated)).toEqual(expected);
    expect(expected).toEqual({ revision: 1, todos });
    service.close();

    const reopenedService = new SessionService({
      config,
      databasePath: path.join(directory, "runtime.sqlite"),
      modelResolver: () => model,
      modelLimitsResolver: async () => ({ context: 16_384, output: 2_048 }),
    });
    const reopenedApp = createMiniLilacServer({
      config,
      sessionService: reopenedService,
      modelCatalog,
    });
    const reopened = await reopenedApp.handle(
      jsonRequest("GET", `${MINI_LILAC_API_PREFIX}/sessions/${session.id}/todos`),
    );
    expect(reopened.status).toBe(200);
    expect(await responseJson(reopened)).toEqual(expected);
    reopenedService.close();
  });

  it("updates strict durable session bindings and rejects conflicts and invalid values", async () => {
    const model = new MockLanguageModelV4({ doStream: textResult("answer", "complete") });
    const { app, directory, service } = await testServer(model);
    const session = await service.createSession({
      id: "binding-session",
      cwd: directory,
      model: "test/reasoner",
      profile: "coding",
      reasoning: "low",
    });
    const body = {
      sessionId: session.id,
      clientCommandId: "binding-command",
      model: "test/plain",
      profile: "coding",
      reasoning: "medium" as const,
    };

    const response = await app.handle(
      jsonRequest("POST", `${MINI_LILAC_API_PREFIX}/sessions/${session.id}/bindings`, body),
    );
    const updated = miniLilacSessionSnapshotSchema.parse(await responseJson(response));
    expect(updated).toMatchObject({
      id: session.id,
      cwd: directory,
      model: "test/plain",
      profile: "coding",
      reasoning: "medium",
    });
    const duplicate = await app.handle(
      jsonRequest("POST", `${MINI_LILAC_API_PREFIX}/sessions/${session.id}/bindings`, body),
    );
    expect(miniLilacSessionSnapshotSchema.parse(await responseJson(duplicate))).toEqual(updated);

    const conflict = await app.handle(
      jsonRequest("POST", `${MINI_LILAC_API_PREFIX}/sessions/${session.id}/bindings`, {
        ...body,
        reasoning: "high",
      }),
    );
    expect(conflict.status).toBe(409);
    const mismatch = await app.handle(
      jsonRequest("POST", `${MINI_LILAC_API_PREFIX}/sessions/other/bindings`, body),
    );
    expect(mismatch.status).toBe(409);
    const empty = await app.handle(
      jsonRequest("POST", `${MINI_LILAC_API_PREFIX}/sessions/${session.id}/bindings`, {
        sessionId: session.id,
        clientCommandId: "empty-bindings",
      }),
    );
    expect(empty.status).toBe(400);
    const invalidModel = await app.handle(
      jsonRequest("POST", `${MINI_LILAC_API_PREFIX}/sessions/${session.id}/bindings`, {
        sessionId: session.id,
        clientCommandId: "invalid-model",
        model: "invalid",
      }),
    );
    expect(invalidModel.status).toBe(400);
    const invalidProfile = await app.handle(
      jsonRequest("POST", `${MINI_LILAC_API_PREFIX}/sessions/${session.id}/bindings`, {
        sessionId: session.id,
        clientCommandId: "invalid-profile",
        profile: "investigator",
      }),
    );
    expect(invalidProfile.status).toBe(400);
    service.close();
  });

  it("rejects binding updates while chat has an active session run", async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const model = new MockLanguageModelV4({
      doStream: async () => {
        await gate;
        return textResult("answer", "complete");
      },
    });
    const { app, directory, service } = await testServer(model);
    const chat = await app.handle(
      jsonRequest("POST", `${MINI_LILAC_API_PREFIX}/chat`, chatBody(directory)),
    );
    await Bun.sleep(0);
    const bindings = await app.handle(
      jsonRequest("POST", `${MINI_LILAC_API_PREFIX}/sessions/session-1/bindings`, {
        sessionId: "session-1",
        clientCommandId: "active-bindings",
        reasoning: "medium",
      }),
    );
    expect(bindings.status).toBe(409);
    release();
    await chat.text();
    service.close();
  });

  it("serves strict durable undo and does not replay the undone terminal run", async () => {
    const model = new MockLanguageModelV4({ doStream: textResult("answer", "terminal answer") });
    const { app, directory, service } = await testServer(model);
    const multipartUser = {
      id: "multipart-user",
      role: "user" as const,
      parts: [
        { type: "text" as const, text: "restore this" },
        { type: "file" as const, mediaType: "image/png", url: "data:image/png;base64,AA==" },
      ],
    };
    const chatRequest = chatBody(directory, { messages: [multipartUser] });
    const chat = await app.handle(
      jsonRequest("POST", `${MINI_LILAC_API_PREFIX}/chat`, chatRequest),
    );
    expect(chat.status).toBe(200);
    await chat.text();

    const undoBody = { sessionId: "session-1", clientCommandId: "undo-command" };
    const undo = await app.handle(
      jsonRequest("POST", `${MINI_LILAC_API_PREFIX}/sessions/session-1/undo`, undoBody),
    );
    const result = miniLilacUndoResultSchema.parse(await responseJson(undo));
    expect(result).toEqual({
      status: "undone",
      clientCommandId: "undo-command",
      message: multipartUser,
    });
    expect(service.getMessages("session-1")).toEqual([]);
    expect(service.store.getModelMessages("session-1")).toEqual([]);

    const duplicate = await app.handle(
      jsonRequest("POST", `${MINI_LILAC_API_PREFIX}/sessions/session-1/undo`, undoBody),
    );
    expect(miniLilacUndoResultSchema.parse(await responseJson(duplicate))).toEqual(result);
    const emptyBody = { sessionId: "session-1", clientCommandId: "empty-undo-command" };
    const empty = await app.handle(
      jsonRequest("POST", `${MINI_LILAC_API_PREFIX}/sessions/session-1/undo`, emptyBody),
    );
    expect(empty.status).toBe(200);
    const emptyResult = miniLilacUndoResultSchema.parse(await responseJson(empty));
    expect(emptyResult).toEqual({
      status: "empty",
      clientCommandId: "empty-undo-command",
    });
    const emptyDuplicate = await app.handle(
      jsonRequest("POST", `${MINI_LILAC_API_PREFIX}/sessions/session-1/undo`, emptyBody),
    );
    expect(miniLilacUndoResultSchema.parse(await responseJson(emptyDuplicate))).toEqual(
      emptyResult,
    );
    const reconnect = await app.handle(
      jsonRequest("GET", `${MINI_LILAC_API_PREFIX}/chat/session-1/stream`),
    );
    expect(reconnect.status).toBe(204);
    const stalePrompt = await app.handle(
      jsonRequest("POST", `${MINI_LILAC_API_PREFIX}/chat`, chatRequest),
    );
    expect(stalePrompt.status).toBe(200);
    expect(await stalePrompt.text()).not.toContain("terminal answer");
    expect(service.getMessages("session-1")).toEqual([]);

    const mismatch = await app.handle(
      jsonRequest("POST", `${MINI_LILAC_API_PREFIX}/sessions/other/undo`, undoBody),
    );
    expect(mismatch.status).toBe(409);
    const malformed = await app.handle(
      jsonRequest("POST", `${MINI_LILAC_API_PREFIX}/sessions/session-1/undo`, {
        ...undoBody,
        unexpected: true,
      }),
    );
    expect(malformed.status).toBe(400);
    service.close();
  });

  it("serves manual compaction while preserving history and appending a divider", async () => {
    const model = new MockLanguageModelV4({
      doStream: async () => textResult("summary", "Condensed server context."),
    });
    const { app, directory, service } = await testServer(model);
    const session = await service.createSession({ cwd: directory, model: "test/reasoner" });
    const visibleMessages = [
      userMessage("old-user", `old request ${"a".repeat(6_000)}`),
      {
        id: "old-assistant",
        role: "assistant" as const,
        parts: [{ type: "text" as const, text: "old answer" }],
      },
      userMessage("latest-user", "latest request"),
    ];
    service.store.replaceMessages(
      session.id,
      [
        { role: "user", content: `old request ${"a".repeat(6_000)}` },
        { role: "assistant", content: `old answer ${"b".repeat(6_000)}` },
        { role: "user", content: "latest request" },
      ],
      visibleMessages,
    );
    const body = { sessionId: session.id, clientCommandId: "compact-command" };

    const response = await app.handle(
      jsonRequest("POST", `${MINI_LILAC_API_PREFIX}/sessions/${session.id}/compact`, body),
    );
    expect(response.status).toBe(200);
    const result = miniLilacCompactResultSchema.parse(await responseJson(response));
    expect(result.status).toBe("compacted");
    expect(service.getMessages(session.id)).toEqual([
      ...visibleMessages,
      {
        id: "compaction:compact-command",
        role: "assistant",
        parts: [
          {
            type: "data-compaction",
            id: "compact-command",
            data: {
              source: "manual",
              reason: "manual",
              status: "completed",
              messageCountBefore: result.messageCountBefore,
              messageCountAfter: result.messageCountAfter,
              estimatedInputTokensBefore: result.estimatedInputTokensBefore,
              estimatedInputTokensAfter: result.estimatedInputTokensAfter,
            },
          },
        ],
      },
    ]);

    const duplicate = await app.handle(
      jsonRequest("POST", `${MINI_LILAC_API_PREFIX}/sessions/${session.id}/compact`, body),
    );
    expect(miniLilacCompactResultSchema.parse(await responseJson(duplicate))).toEqual(result);
    const mismatch = await app.handle(
      jsonRequest("POST", `${MINI_LILAC_API_PREFIX}/sessions/other/compact`, body),
    );
    expect(mismatch.status).toBe(409);
    const malformed = await app.handle(
      jsonRequest("POST", `${MINI_LILAC_API_PREFIX}/sessions/${session.id}/compact`, {
        ...body,
        unexpected: true,
      }),
    );
    expect(malformed.status).toBe(400);
    service.close();
  });

  it("lists recently updated sessions only from the requested canonical cwd", async () => {
    const model = new MockLanguageModelV4({ doStream: textResult("unused", "unused") });
    const { app, directory, service } = await testServer(model);
    const otherDirectory = await mkdtemp(path.join(tmpdir(), "mini-lilac-other-cwd-"));
    temporaryDirectories.push(otherDirectory);
    await service.createSession({ id: "older", cwd: directory, model: "test/reasoner" });
    await service.createSession({ id: "newer", cwd: directory, model: "test/reasoner" });
    await service.createSession({ id: "other", cwd: otherDirectory, model: "test/reasoner" });
    service.store.database
      .query("UPDATE sessions SET updated_at = ? WHERE id = ?")
      .run("2026-01-01T00:00:00.000Z", "older");
    service.store.database
      .query("UPDATE sessions SET updated_at = ? WHERE id = ?")
      .run("2026-01-02T00:00:00.000Z", "newer");

    const response = await app.handle(
      jsonRequest("GET", `${MINI_LILAC_API_PREFIX}/sessions?cwd=${encodeURIComponent(directory)}`),
    );
    expect(response.status).toBe(200);
    expect(
      z
        .array(miniLilacSessionSnapshotSchema)
        .parse(await responseJson(response))
        .map((entry) => entry.id),
    ).toEqual(["newer", "older"]);

    const missing = await app.handle(jsonRequest("GET", `${MINI_LILAC_API_PREFIX}/sessions`));
    expect(missing.status).toBe(400);
    const invalid = await app.handle(
      jsonRequest("GET", `${MINI_LILAC_API_PREFIX}/sessions?cwd=%2Fdoes-not-exist`),
    );
    expect(invalid.status).toBe(400);
    expect(JSON.stringify(await responseJson(invalid))).toContain("invalid_cwd");
    service.close();
  });

  it("requires exact bearer auth except for health", async () => {
    const model = new MockLanguageModelV4({ doStream: textResult("unused", "unused") });
    const { app, directory, service } = await testServer(model, {
      authTokenEnv: "MINI_LILAC_TOKEN",
      authToken: "correct-token",
    });
    await service.createSession({ id: "auth-todos", cwd: directory, model: "test/plain" });

    const health = await app.handle(jsonRequest("GET", `${MINI_LILAC_API_PREFIX}/healthz`));
    expect(health.status).toBe(200);
    expect(await responseJson(health)).toEqual({ ok: true });

    const todoPath = `${MINI_LILAC_API_PREFIX}/sessions/auth-todos/todos`;
    const missing = await app.handle(jsonRequest("GET", todoPath));
    expect(missing.status).toBe(401);
    expect(missing.headers.get("www-authenticate")).toBe("Bearer");
    const wrong = await app.handle(jsonRequest("GET", todoPath, undefined, "wrong-token"));
    expect(wrong.status).toBe(401);
    const accepted = await app.handle(jsonRequest("GET", todoPath, undefined, "correct-token"));
    expect(accepted.status).toBe(200);
    expect(await responseJson(accepted)).toEqual({ revision: 0, todos: [] });
    service.close();
  });

  it("rejects blank direct-use auth tokens", async () => {
    const model = new MockLanguageModelV4({ doStream: textResult("unused", "unused") });
    await expect(
      testServer(model, { authTokenEnv: "MINI_LILAC_TOKEN", authToken: "   " }),
    ).rejects.toThrow("cannot be blank");
    await expect(testServer(model, { authToken: "" })).rejects.toThrow("cannot be blank");
  });

  it("rejects malformed standard UI parts before creating a session", async () => {
    const model = new MockLanguageModelV4({ doStream: textResult("unused", "unused") });
    const { app, directory, service } = await testServer(model);
    const malformedParts: unknown[] = [
      { type: "text", text: 42 },
      { type: "text", text: "valid text", unexpected: true },
      {
        type: "tool-shell",
        toolCallId: 42,
        state: "input-available",
        input: { command: "pwd" },
      },
    ];

    for (const [index, part] of malformedParts.entries()) {
      const response = await app.handle(
        jsonRequest(
          "POST",
          `${MINI_LILAC_API_PREFIX}/chat`,
          chatBody(directory, {
            id: `malformed-session-${index}`,
            clientCommandId: `malformed-command-${index}`,
            messages: [{ id: `malformed-message-${index}`, role: "user", parts: [part] }],
          }),
        ),
      );
      expect(response.status).toBe(400);
      expect(JSON.stringify(await responseJson(response))).toContain("invalid_ui_messages");
    }

    expect(service.store.listSessions()).toEqual([]);
    expect(model.doStreamCalls).toHaveLength(0);
    service.close();
  });

  it("resumes active streams and drops finalized stream chunks", async () => {
    const model = new MockLanguageModelV4({
      doStream: {
        stream: simulateReadableStream({
          chunks: [
            { type: "text-start" as const, id: "cursor-answer" },
            {
              type: "text-delta" as const,
              id: "cursor-answer",
              delta: "cursor-safe response",
            },
            { type: "text-end" as const, id: "cursor-answer" },
            {
              type: "finish" as const,
              finishReason: { unified: "stop" as const, raw: "stop" },
              usage: zeroUsage(),
            },
          ],
          chunkDelayInMs: 25,
        }),
      },
    });
    const { app, directory, service } = await testServer(model);
    const initial = await app.handle(
      jsonRequest("POST", `${MINI_LILAC_API_PREFIX}/chat`, chatBody(directory)),
    );
    const prefix = await readStreamPrefix(initial, 3);
    expect(prefix.after).toBe(3);
    const runId = miniLilacStreamCursorChunkSchema.parse(prefix.chunks[0]).data.runId;
    expect(service.getSnapshot("session-1").status).toBe("streaming");
    expect(service.getSnapshot("session-1").activeRunId).toBe(runId);

    const activeReconnect = await app.handle(
      jsonRequest(
        "GET",
        `${MINI_LILAC_API_PREFIX}/chat/session-1/stream?runId=${runId}&after=${prefix.after}`,
      ),
    );
    expect(activeReconnect.status).toBe(200);
    const activeTail = parseSseChunks(await activeReconnect.text());
    expect(service.getSnapshot("session-1").status).toBe("idle");

    const completedWithoutCursor = await app.handle(
      jsonRequest("GET", `${MINI_LILAC_API_PREFIX}/chat/session-1/stream`),
    );
    expect(completedWithoutCursor.status).toBe(204);

    const completedFull = await app.handle(
      jsonRequest("GET", `${MINI_LILAC_API_PREFIX}/chat/session-1/stream?runId=${runId}&after=0`),
    );
    expect(completedFull.status).toBe(204);
    const fullChunks = [...prefix.chunks, ...activeTail];
    expect(service.store.getChunks(runId)).toEqual([]);

    const cursorChunks = fullChunks
      .map((chunk) => miniLilacStreamCursorChunkSchema.safeParse(chunk))
      .filter((result) => result.success)
      .map((result) => result.data);
    expect(cursorChunks.map((chunk) => chunk.data.seq)).toEqual(
      Array.from({ length: fullChunks.length / 2 }, (_, index) => index + 1),
    );
    expect(
      fullChunks.every(
        (chunk, index) => (index % 2 === 0) === chunk.type.startsWith("data-streamCursor"),
      ),
    ).toBe(true);

    const completedTail = await app.handle(
      jsonRequest("GET", `${MINI_LILAC_API_PREFIX}/chat/session-1/stream?runId=${runId}&after=6`),
    );
    expect(completedTail.status).toBe(204);

    const invalidCursor = await app.handle(
      jsonRequest("GET", `${MINI_LILAC_API_PREFIX}/chat/session-1/stream?runId=${runId}&after=-1`),
    );
    expect(invalidCursor.status).toBe(400);
    for (const query of ["runId=run-only", "after=0", `runId=${runId}&after=0&extra=true`]) {
      const malformed = await app.handle(
        jsonRequest("GET", `${MINI_LILAC_API_PREFIX}/chat/session-1/stream?${query}`),
      );
      expect(malformed.status).toBe(400);
    }
    service.close();
  });

  it("serves delegated sessions through normal session endpoints", async () => {
    const model = new MockLanguageModelV4({ doStream: textResult("unused", "unused") });
    const { app, directory, service } = await testServer(model);
    const session = service.store.createSession({
      id: "sub:parent:named:research",
      cwd: directory,
      model: "test/mock",
      profile: "investigator",
      reasoning: "provider-default",
    });

    const response = await app.handle(
      jsonRequest("GET", `${MINI_LILAC_API_PREFIX}/sessions/${session.id}/messages`),
    );
    expect(response.status).toBe(200);
    expect(await responseJson(response)).toEqual([]);
    const stream = await app.handle(
      jsonRequest("GET", `${MINI_LILAC_API_PREFIX}/chat/${session.id}/stream`),
    );
    expect(stream.status).toBe(204);
    const catalog = await app.handle(
      jsonRequest("GET", `${MINI_LILAC_API_PREFIX}/sessions?cwd=${encodeURIComponent(directory)}`),
    );
    expect(await responseJson(catalog)).toEqual([]);
    service.close();
  });

  it("does not replay a finalized cancelled tail", async () => {
    let modelStarted = () => {};
    const modelStart = new Promise<void>((resolve) => {
      modelStarted = resolve;
    });
    const model = new MockLanguageModelV4({
      doStream: async (options) => {
        modelStarted();
        await new Promise<void>((_resolve, reject) => {
          if (options.abortSignal?.aborted) {
            reject(new DOMException("cancelled", "AbortError"));
            return;
          }
          options.abortSignal?.addEventListener(
            "abort",
            () => reject(new DOMException("cancelled", "AbortError")),
            { once: true },
          );
        });
        return textResult("unreachable", "unreachable");
      },
    });
    const { app, directory, service } = await testServer(model);
    const initial = await app.handle(
      jsonRequest("POST", `${MINI_LILAC_API_PREFIX}/chat`, chatBody(directory)),
    );
    const initialText = initial.text();
    await modelStart;

    const runId = service.getSnapshot("session-1").activeRunId;
    if (!runId) throw new Error("Expected an active run");
    const cancel = await app.handle(
      jsonRequest("POST", `${MINI_LILAC_API_PREFIX}/sessions/session-1/cancel`, {
        sessionId: "session-1",
        runId,
        clientCommandId: "tail-cancel-command",
      }),
    );
    expect(cancel.status).toBe(200);
    expect(miniLilacCancelResultSchema.parse(await responseJson(cancel)).status).toBe("cancelled");

    const fullChunks = parseSseChunks(await initialText);
    expect(service.store.getRun(runId).status).toBe("cancelled");
    const controlIndex = fullChunks.findIndex((chunk) => chunk.type === "data-control");
    const controlCursor = miniLilacStreamCursorChunkSchema.parse(fullChunks[controlIndex - 1]);
    const expectedTail = fullChunks.slice(controlIndex - 1);
    const tailTypes = expectedTail.map((chunk) => chunk.type);
    expect(tailTypes).toContain("data-control");
    expect(tailTypes).toContain("abort");
    expect(tailTypes).toContain("data-transcriptReset");
    expect(tailTypes).toContain("finish");

    const withoutCursor = await app.handle(
      jsonRequest("GET", `${MINI_LILAC_API_PREFIX}/chat/session-1/stream`),
    );
    expect(withoutCursor.status).toBe(204);
    const replay = await app.handle(
      jsonRequest(
        "GET",
        `${MINI_LILAC_API_PREFIX}/chat/session-1/stream?runId=${runId}&after=${controlCursor.data.seq - 1}`,
      ),
    );
    expect(replay.status).toBe(204);
    service.close();
  });

  it("does not replay a finalized error tail", async () => {
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      const model = new MockLanguageModelV4({
        doStream: async () => {
          throw new Error("provider stream failed");
        },
      });
      const { app, directory, service } = await testServer(model);
      const initial = await app.handle(
        jsonRequest("POST", `${MINI_LILAC_API_PREFIX}/chat`, chatBody(directory)),
      );
      const fullChunks = parseSseChunks(await initial.text());
      const run = service.store.getLatestRun("session-1");
      if (!run) throw new Error("Expected an error run");
      expect(run.status).toBe("error");

      const errorIndex = fullChunks.findIndex((chunk) => chunk.type === "error");
      const errorCursor = miniLilacStreamCursorChunkSchema.parse(fullChunks[errorIndex - 1]);
      const expectedTail = fullChunks.slice(errorIndex - 1);
      expect(expectedTail.map((chunk) => chunk.type)).toEqual([
        "data-streamCursor",
        "error",
        "data-streamCursor",
        "finish",
      ]);

      const withoutCursor = await app.handle(
        jsonRequest("GET", `${MINI_LILAC_API_PREFIX}/chat/session-1/stream`),
      );
      expect(withoutCursor.status).toBe(204);
      const replay = await app.handle(
        jsonRequest(
          "GET",
          `${MINI_LILAC_API_PREFIX}/chat/session-1/stream?runId=${run.id}&after=${errorCursor.data.seq - 1}`,
        ),
      );
      expect(replay.status).toBe(204);
      expect(
        errorSpy.mock.calls.some((call) =>
          call.some((value) =>
            (value instanceof Error ? value.message : String(value)).includes(
              "provider stream failed",
            ),
          ),
        ),
      ).toBe(false);
      service.close();
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("does not reconnect to completed root runs when timestamps tie", async () => {
    const model = new MockLanguageModelV4({ doStream: textResult("unused", "unused") });
    const { app, directory, service } = await testServer(model);
    await service.createSession({
      id: "session-1",
      cwd: directory,
      model: "test/plain",
      profile: "coding",
      reasoning: "provider-default",
    });
    for (const [runId, text] of [
      ["older-run", "older"],
      ["newer-run", "newer"],
    ] as const) {
      service.store.createRun({
        id: runId,
        sessionId: "session-1",
        profile: "coding",
        depth: 0,
      });
      service.store.appendChunk(runId, { type: "text-start", id: runId });
      service.store.appendChunk(runId, { type: "text-delta", id: runId, delta: text });
      service.store.appendChunk(runId, { type: "text-end", id: runId });
      service.store.appendChunk(runId, { type: "finish", finishReason: "stop" });
      service.store.finishRun(runId, "completed");
    }
    service.store.database
      .query("UPDATE runs SET started_at = ? WHERE session_id = ?")
      .run("2026-07-21T12:00:00.000Z", "session-1");

    const reconnect = await app.handle(
      jsonRequest("GET", `${MINI_LILAC_API_PREFIX}/chat/session-1/stream?runId=newer-run&after=0`),
    );
    expect(reconnect.status).toBe(204);
    service.close();
  });

  it("never rolls an exact reconnect from a terminal run into the next active run", async () => {
    let releaseSecond = () => {};
    const secondGate = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });
    let modelCall = 0;
    const model = new MockLanguageModelV4({
      doStream: async () => {
        modelCall += 1;
        if (modelCall === 1) return textResult("first-answer", "first run");
        await secondGate;
        return textResult("second-answer", "second run");
      },
    });
    const { app, directory, service } = await testServer(model);
    const first = await app.handle(
      jsonRequest("POST", `${MINI_LILAC_API_PREFIX}/chat`, chatBody(directory)),
    );
    const firstChunks = parseSseChunks(await first.text());
    const firstCursor = firstChunks
      .map((chunk) => miniLilacStreamCursorChunkSchema.safeParse(chunk))
      .find((result) => result.success);
    if (!firstCursor) throw new Error("Expected a first-run cursor");
    const firstRunId = firstCursor.data.data.runId;

    const second = await app.handle(
      jsonRequest(
        "POST",
        `${MINI_LILAC_API_PREFIX}/chat`,
        chatBody(directory, {
          messages: [userMessage("user-2", "second prompt")],
          clientCommandId: "prompt-command-2",
          cwd: undefined,
          model: undefined,
          profile: undefined,
          reasoning: undefined,
        }),
      ),
    );
    await Bun.sleep(0);
    const secondRunId = service.getSnapshot("session-1").activeRunId;
    if (!secondRunId) throw new Error("Expected a second active run");
    expect(secondRunId).not.toBe(firstRunId);
    await second.body?.cancel("disconnect second run");

    const staleReconnect = await app.handle(
      jsonRequest(
        "GET",
        `${MINI_LILAC_API_PREFIX}/chat/session-1/stream?runId=${firstRunId}&after=${firstCursor.data.data.seq}`,
      ),
    );
    expect(staleReconnect.status).toBe(204);

    await service.createSession({
      id: "other-session",
      cwd: directory,
      model: "test/plain",
    });
    const mismatch = await app.handle(
      jsonRequest(
        "GET",
        `${MINI_LILAC_API_PREFIX}/chat/other-session/stream?runId=${secondRunId}&after=0`,
      ),
    );
    expect(mismatch.status).toBe(409);
    expect(await responseJson(mismatch)).toEqual({
      error: {
        code: "run_session_mismatch",
        message: `Run '${secondRunId}' does not belong to session 'other-session'`,
      },
    });

    const exactSecond = await app.handle(
      jsonRequest(
        "GET",
        `${MINI_LILAC_API_PREFIX}/chat/session-1/stream?runId=${secondRunId}&after=0`,
      ),
    );
    expect(exactSecond.status).toBe(200);
    releaseSecond();
    expect(await exactSecond.text()).toContain("second run");
    expect(model.doStreamCalls).toHaveLength(2);
    service.close();
  });

  it("keeps runs alive after disconnect and exposes reconnect and control endpoints", async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const model = new MockLanguageModelV4({
      doStream: async () => {
        await gate;
        return textResult("delayed", "finished after reconnect");
      },
    });
    const { app, directory, service } = await testServer(model);

    const initial = await app.handle(
      jsonRequest("POST", `${MINI_LILAC_API_PREFIX}/chat`, chatBody(directory)),
    );
    expect(initial.status).toBe(200);
    await Bun.sleep(0);
    await initial.body?.cancel("client disconnected");
    expect(service.getSnapshot("session-1").status).toBe("streaming");

    const duplicate = await app.handle(
      jsonRequest(
        "POST",
        `${MINI_LILAC_API_PREFIX}/chat`,
        chatBody(directory, {
          cwd: undefined,
          model: undefined,
          profile: undefined,
          reasoning: undefined,
        }),
      ),
    );
    expect(duplicate.status).toBe(200);
    await duplicate.body?.cancel();
    expect(model.doStreamCalls).toHaveLength(1);

    const activeConflict = await app.handle(
      jsonRequest(
        "POST",
        `${MINI_LILAC_API_PREFIX}/chat`,
        chatBody(directory, { clientCommandId: "different-prompt-command" }),
      ),
    );
    expect(activeConflict.status).toBe(409);
    expect(JSON.stringify(await responseJson(activeConflict))).toContain("session_active");

    const reconnect = await app.handle(
      jsonRequest("GET", `${MINI_LILAC_API_PREFIX}/chat/session-1/stream`),
    );
    expect(reconnect.status).toBe(200);
    expect(reconnect.headers.get("x-vercel-ai-ui-message-stream")).toBe("v1");

    const malformedSteer = await app.handle(
      jsonRequest("POST", `${MINI_LILAC_API_PREFIX}/sessions/session-1/steer`, {
        sessionId: "session-1",
        runId: service.getSnapshot("session-1").activeRunId,
        clientCommandId: "malformed-steer-command",
        message: "change direction",
      }),
    );
    expect(malformedSteer.status).toBe(400);
    expect(JSON.stringify(await responseJson(malformedSteer))).toContain("invalid_request");

    const steer = await app.handle(
      jsonRequest("POST", `${MINI_LILAC_API_PREFIX}/sessions/session-1/steer`, {
        sessionId: "session-1",
        runId: service.getSnapshot("session-1").activeRunId,
        clientCommandId: "steer-command",
        message: userMessage("steer-user", "change direction"),
      }),
    );
    expect(miniLilacSteerResultSchema.parse(await responseJson(steer))).toMatchObject({
      status: "queued",
      clientCommandId: "steer-command",
    });

    const stale = await app.handle(
      jsonRequest("POST", `${MINI_LILAC_API_PREFIX}/sessions/session-1/cancel`, {
        sessionId: "session-1",
        runId: "stale-run",
        clientCommandId: "stale-cancel",
      }),
    );
    expect(stale.status).toBe(409);
    expect(service.getSnapshot("session-1").activeRunId).not.toBe("stale-run");

    const interrupt = await app.handle(
      jsonRequest("POST", `${MINI_LILAC_API_PREFIX}/sessions/session-1/interrupt-queued-steering`, {
        sessionId: "session-1",
        runId: service.getSnapshot("session-1").activeRunId,
        clientCommandId: "interrupt-command",
      }),
    );
    expect(
      miniLilacInterruptQueuedSteeringResultSchema.parse(await responseJson(interrupt)),
    ).toMatchObject({ status: "interrupted", clientCommandId: "interrupt-command" });

    const cancel = await app.handle(
      jsonRequest("POST", `${MINI_LILAC_API_PREFIX}/sessions/session-1/cancel`, {
        sessionId: "session-1",
        runId: service.getSnapshot("session-1").activeRunId,
        clientCommandId: "cancel-command",
      }),
    );
    expect(miniLilacCancelResultSchema.parse(await responseJson(cancel))).toEqual({
      status: "cancelled",
      clientCommandId: "cancel-command",
    });

    release();
    const replayed = await reconnect.text();
    expect(replayed).toContain('"type":"data-control"');
    expect(replayed).toContain("data: [DONE]");
    expect(model.doStreamCalls).toHaveLength(1);

    const inactiveReconnect = await app.handle(
      jsonRequest("GET", `${MINI_LILAC_API_PREFIX}/chat/session-1/stream`),
    );
    expect(inactiveReconnect.status).toBe(204);
    service.close();
  });

  it("normalizes model and profile catalogs and force-refreshes models", async () => {
    const model = new MockLanguageModelV4({ doStream: textResult("unused", "unused") });
    const { app, catalogCalls, service } = await testServer(model);

    const modelsResponse = await app.handle(jsonRequest("GET", `${MINI_LILAC_API_PREFIX}/models`));
    const models = miniLilacModelsSchema.parse(await responseJson(modelsResponse));
    expect(models).toEqual([
      {
        id: "test/plain",
        label: "test/plain",
        provider: "test",
        supportsReasoning: false,
      },
      {
        id: "test/reasoner",
        label: "Test Reasoner",
        provider: "test",
        supportsReasoning: true,
        reasoningLevels: ["provider-default", "none", "minimal", "low", "medium", "high", "xhigh"],
        contextWindow: 16_384,
      },
    ]);

    const refreshResponse = await app.handle(
      jsonRequest("POST", `${MINI_LILAC_API_PREFIX}/models/refresh`),
    );
    expect(miniLilacModelsSchema.parse(await responseJson(refreshResponse))).toEqual(models);
    const emptyRefreshResponse = await app.handle(
      jsonRequest("POST", `${MINI_LILAC_API_PREFIX}/models/refresh`, {}),
    );
    expect(miniLilacModelsSchema.parse(await responseJson(emptyRefreshResponse))).toEqual(models);
    expect(catalogCalls).toEqual([{}, { forceRefresh: true }, { forceRefresh: true }]);

    const profilesResponse = await app.handle(
      jsonRequest("GET", `${MINI_LILAC_API_PREFIX}/profiles`),
    );
    expect(miniLilacProfilesSchema.parse(await responseJson(profilesResponse))).toEqual([
      {
        id: "coding",
        label: "coding",
        description: "Coding profile",
        isDefault: true,
        subagentOnly: false,
      },
      {
        id: "investigator",
        label: "investigator",
        description: "Subagent profile",
        subagentOnly: true,
      },
    ]);
    service.close();
  });

  it("lists pre-session skills by cwd and active profile without exposing paths", async () => {
    const model = new MockLanguageModelV4({ doStream: textResult("unused", "unused") });
    const { app, directory, service } = await testServer(model, { skills: true });

    const response = await app.handle(
      jsonRequest(
        "GET",
        `${MINI_LILAC_API_PREFIX}/skills?cwd=${encodeURIComponent(directory)}&profile=coding`,
      ),
    );
    expect(response.status).toBe(200);
    const skills = miniLilacSkillsSchema.parse(await responseJson(response));
    expect(skills).toContainEqual({
      name: "test-skill",
      description: "Use for server skill endpoint tests.",
    });
    expect(JSON.stringify(skills)).not.toContain(directory);

    const unavailable = await app.handle(
      jsonRequest(
        "GET",
        `${MINI_LILAC_API_PREFIX}/skills?cwd=${encodeURIComponent(directory)}&profile=investigator`,
      ),
    );
    expect(await responseJson(unavailable)).toEqual([]);

    const fileCwd = path.join(directory, "not-a-directory.txt");
    await writeFile(fileCwd, "file");
    const invalidCwd = await app.handle(
      jsonRequest("GET", `${MINI_LILAC_API_PREFIX}/skills?cwd=${encodeURIComponent(fileCwd)}`),
    );
    expect(invalidCwd.status).toBe(400);
    expect(await responseJson(invalidCwd)).toEqual({
      error: { code: "invalid_cwd", message: `Skill cwd '${fileCwd}' is not a directory` },
    });
    service.close();
  });
});
