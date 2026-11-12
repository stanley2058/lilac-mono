/**
 * A deterministic stand-in for model providers. Core talks to it over the real provider wire
 * protocols, and each scenario decides the next model action from the conversation Core sent.
 */

export type ModelToolCall = { id: string; name: string; args: unknown };
export type ModelMessage =
  | { role: "system"; text: string }
  | { role: "user"; text: string; files: string[] }
  | { role: "assistant"; text: string; toolCalls: ModelToolCall[] }
  | { role: "tool"; callId: string; output: string };

export type ModelRequest = {
  protocol: "chat-completions";
  model: string;
  instructions: string;
  messages: ModelMessage[];
  tools: string[];
  /** JSON Schema of each offered tool's input, keyed by tool name. */
  toolSchemas: Record<string, unknown>;
  stream: boolean;
  raw: unknown;
};

export type ModelReply = {
  text?: string;
  toolCalls?: { name: string; args: unknown; id?: string }[];
};

export type ScenarioScript = (
  request: ModelRequest,
  model: ModelView,
) => ModelReply | Promise<ModelReply>;

/** What a script can read about the conversation it is answering. */
export class ModelView {
  constructor(readonly request: ModelRequest) {}
  /** Assistant steps taken since the newest user message. */
  get step(): number {
    let step = 0;
    for (let index = this.request.messages.length - 1; index >= 0; index--) {
      const message = this.request.messages[index]!;
      if (message.role === "user") return step;
      if (message.role === "assistant") step++;
    }
    return step;
  }
  get lastUserText(): string {
    for (let index = this.request.messages.length - 1; index >= 0; index--) {
      const message = this.request.messages[index]!;
      if (message.role === "user") return message.text;
    }
    return "";
  }
  get userTexts(): string[] {
    return this.request.messages.flatMap((message) =>
      message.role === "user" ? [message.text] : [],
    );
  }
  /** Tool outputs answering the newest assistant step, keyed by tool name. */
  get lastToolResults(): { name: string; args: unknown; output: string }[] {
    const calls = new Map<string, ModelToolCall>();
    for (const message of this.request.messages)
      if (message.role === "assistant")
        for (const call of message.toolCalls) calls.set(call.id, call);
    const results: { name: string; args: unknown; output: string }[] = [];
    for (let index = this.request.messages.length - 1; index >= 0; index--) {
      const message = this.request.messages[index]!;
      if (message.role !== "tool") break;
      const call = calls.get(message.callId);
      results.unshift({ name: call?.name ?? "unknown", args: call?.args, output: message.output });
    }
    return results;
  }
  result(name: string): string {
    const found = this.lastToolResults.find((result) => result.name === name);
    if (!found)
      throw new Error(
        `Model expected a ${name} result, got ${JSON.stringify(this.lastToolResults)}`,
      );
    return found.output;
  }
  /** The newest result of a tool whose output is JSON, such as bash's {stdout, stderr, exitCode}. */
  json<T = Record<string, unknown>>(name: string): T {
    return JSON.parse(this.result(name)) as T;
  }
}

const SCENARIO_TAG = /\[scenario:([a-z0-9-]+)\]/u;
const TITLE_INSTRUCTION = "Name this conversation";

function textOf(content: unknown): { text: string; files: string[] } {
  if (typeof content === "string") return { text: content, files: [] };
  if (!Array.isArray(content)) return { text: "", files: [] };
  const texts: string[] = [];
  const files: string[] = [];
  for (const part of content as { type?: string; text?: string; image_url?: { url?: string } }[]) {
    if (typeof part.text === "string") texts.push(part.text);
    else if (part.type === "image_url" && part.image_url?.url) files.push(part.image_url.url);
    else if (part.type) files.push(part.type);
  }
  return { text: texts.join("\n"), files };
}

function normalizeChat(body: Record<string, unknown>): ModelRequest {
  const messages: ModelMessage[] = [];
  const instructions: string[] = [];
  for (const message of (body.messages ?? []) as Record<string, unknown>[]) {
    const { text, files } = textOf(message.content);
    switch (message.role) {
      case "system":
      case "developer":
        instructions.push(text);
        messages.push({ role: "system", text });
        break;
      case "user":
        messages.push({ role: "user", text, files });
        break;
      case "assistant":
        messages.push({
          role: "assistant",
          text,
          toolCalls: (
            (message.tool_calls ?? []) as {
              id: string;
              function: { name: string; arguments: string };
            }[]
          ).map((call) => ({
            id: call.id,
            name: call.function.name,
            args: JSON.parse(call.function.arguments || "{}"),
          })),
        });
        break;
      case "tool":
        messages.push({ role: "tool", callId: String(message.tool_call_id), output: text });
        break;
    }
  }
  return {
    protocol: "chat-completions",
    model: String(body.model),
    instructions: instructions.join("\n\n"),
    messages,
    tools: ((body.tools ?? []) as { function?: { name?: string } }[]).flatMap((tool) =>
      tool.function?.name ? [tool.function.name] : [],
    ),
    toolSchemas: Object.fromEntries(
      ((body.tools ?? []) as { function?: { name?: string; parameters?: unknown } }[]).flatMap(
        (tool) => (tool.function?.name ? [[tool.function.name, tool.function.parameters]] : []),
      ),
    ),
    stream: body.stream === true,
    raw: body,
  };
}

function chatChunks(reply: ModelReply, callIds: string[]): unknown[] {
  const base = {
    id: `chatcmpl-${crypto.randomUUID()}`,
    object: "chat.completion.chunk",
    created: 1,
    model: "scripted",
  };
  const chunks: unknown[] = [];
  if (reply.text)
    for (const piece of reply.text.match(/[\s\S]{1,24}/gu) ?? [])
      chunks.push({
        ...base,
        choices: [{ index: 0, delta: { role: "assistant", content: piece }, finish_reason: null }],
      });
  for (const [index, call] of (reply.toolCalls ?? []).entries()) {
    chunks.push({
      ...base,
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index,
                id: callIds[index],
                type: "function",
                function: { name: call.name, arguments: JSON.stringify(call.args) },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    });
  }
  chunks.push({
    ...base,
    choices: [
      { index: 0, delta: {}, finish_reason: reply.toolCalls?.length ? "tool_calls" : "stop" },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  });
  return chunks;
}

function chatResponse(reply: ModelReply, stream: boolean): Response {
  const callIds = (reply.toolCalls ?? []).map(
    (call) => call.id ?? `call_${crypto.randomUUID().replaceAll("-", "")}`,
  );
  if (stream)
    return new Response(
      `${chatChunks(reply, callIds)
        .map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`)
        .join("")}data: [DONE]\n\n`,
      { headers: { "content-type": "text/event-stream" } },
    );
  return Response.json({
    id: `chatcmpl-${crypto.randomUUID()}`,
    object: "chat.completion",
    created: 1,
    model: "scripted",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: reply.text ?? "",
          ...(reply.toolCalls?.length
            ? {
                tool_calls: reply.toolCalls.map((call, index) => ({
                  id: callIds[index],
                  type: "function",
                  function: { name: call.name, arguments: JSON.stringify(call.args) },
                })),
              }
            : {}),
        },
        finish_reason: reply.toolCalls?.length ? "tool_calls" : "stop",
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  });
}

export type RecordedRequest = {
  scenario: string | undefined;
  request: ModelRequest;
  reply?: ModelReply;
};

/** Requests that block until the test releases them, so a test can act while a model call is open. */
class Gate {
  private readonly arrived = Promise.withResolvers<void>();
  private readonly released = Promise.withResolvers<void>();
  entered = false;
  get reached(): Promise<void> {
    return this.arrived.promise;
  }
  release(): void {
    this.released.resolve();
  }
  async pass(signal: AbortSignal): Promise<void> {
    this.entered = true;
    this.arrived.resolve();
    await Promise.race([
      this.released.promise,
      new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true }),
      ),
    ]);
  }
}

export class ScriptedModel {
  private readonly scripts = new Map<string, ScenarioScript>();
  private readonly gates = new Map<string, Gate[]>();
  readonly requests: RecordedRequest[] = [];
  readonly unhandled: string[] = [];
  private readonly listeners = new Set<() => void>();
  private server: ReturnType<typeof Bun.serve> | undefined;

  get url(): string {
    if (!this.server) throw new Error("Scripted model is not started");
    return this.server.url.href.replace(/\/$/u, "");
  }

  start(): this {
    this.server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      idleTimeout: 0,
      fetch: (request) => this.handle(request),
    });
    return this;
  }

  async stop(): Promise<void> {
    for (const gates of this.gates.values()) for (const gate of gates) gate.release();
    await this.server?.stop(true);
  }

  /** Routes requests whose user messages carry `[scenario:<name>]` to the script. */
  script(name: string, script: ScenarioScript): string {
    this.scripts.set(name, script);
    return `[scenario:${name}]`;
  }

  /** The next main-model request for the scenario waits until `release()` is called. */
  hold(name: string): Gate {
    const gate = new Gate();
    const queue = this.gates.get(name) ?? [];
    queue.push(gate);
    this.gates.set(name, queue);
    return gate;
  }

  forScenario(name: string): RecordedRequest[] {
    return this.requests.filter((entry) => entry.scenario === name);
  }

  /** Resolves once a recorded request satisfies the predicate. */
  async waitFor(predicate: (entry: RecordedRequest) => boolean): Promise<RecordedRequest> {
    for (;;) {
      const found = this.requests.find(predicate);
      if (found) return found;
      const changed = Promise.withResolvers<void>();
      this.listeners.add(changed.resolve);
      await changed.promise;
      this.listeners.delete(changed.resolve);
    }
  }

  private record(entry: RecordedRequest): void {
    this.requests.push(entry);
    for (const listener of this.listeners) listener();
  }

  private async handle(request: Request): Promise<Response> {
    if (request.method !== "POST") return new Response("Not found", { status: 404 });
    const body = (await request.json()) as Record<string, unknown>;
    const normalized = normalizeChat(body);
    const reply = await this.reply(normalized, request.signal);
    if (reply instanceof Response) return reply;
    return chatResponse(reply, normalized.stream);
  }

  private scenarioOf(request: ModelRequest): string | undefined {
    for (const message of request.messages) {
      if (message.role !== "user" && message.role !== "system") continue;
      const match = SCENARIO_TAG.exec(message.text);
      if (match) return match[1];
    }
    return SCENARIO_TAG.exec(request.instructions)?.[1];
  }

  private async reply(request: ModelRequest, signal: AbortSignal): Promise<ModelReply | Response> {
    const scenario = this.scenarioOf(request);
    if (
      request.instructions.includes(TITLE_INSTRUCTION) ||
      request.messages.some((m) => m.role === "user" && m.text.includes(TITLE_INSTRUCTION))
    ) {
      const reply = {
        text: JSON.stringify({ title: `Scenario ${scenario ?? "thread"}`, needsRefinement: false }),
      };
      this.record({ scenario: undefined, request, reply });
      return reply;
    }
    const script = scenario ? this.scripts.get(scenario) : undefined;
    if (!scenario || !script) {
      const summary = `${request.model}: ${JSON.stringify(request.messages.at(-1)).slice(0, 400)}`;
      this.unhandled.push(summary);
      this.record({ scenario, request });
      return new Response(
        JSON.stringify({ error: { message: `No scenario for request ${summary}` } }),
        {
          status: 400,
          headers: { "content-type": "application/json" },
        },
      );
    }
    const gate = this.gates.get(scenario)?.shift();
    if (gate) await gate.pass(signal);
    const entry: RecordedRequest = { scenario, request };
    this.record(entry);
    try {
      entry.reply = await script(request, new ModelView(request));
    } catch (error) {
      this.unhandled.push(`${scenario}: ${error instanceof Error ? error.message : String(error)}`);
      return new Response(JSON.stringify({ error: { message: String(error) } }), { status: 400 });
    }
    return entry.reply;
  }
}
