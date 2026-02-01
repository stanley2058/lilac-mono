import {
  asSchema,
  type LanguageModelUsage,
  type ModelMessage,
  type ToolSet,
} from "ai";
import type { CoreConfig } from "@stanley2058/lilac-utils";
import {
  getCoreConfig,
  ModelCapability,
  resolveLogLevel,
  resolveModelSlot,
} from "@stanley2058/lilac-utils";
import {
  lilacEventTypes,
  type AdapterPlatform,
  type LilacBus,
  type RequestLifecycleState,
  type RequestQueueMode,
} from "@stanley2058/lilac-event-bus";
import {
  AiSdkPiAgent,
  attachAutoCompaction,
  type AiSdkPiAgentEvent,
} from "@stanley2058/lilac-agent";

import { Logger } from "@stanley2058/simple-module-logger";

import { applyPatchTool } from "../../tools/apply-patch";
import { bashToolWithCwd } from "../../tools/bash";
import { fsTool } from "../../tools/fs/fs";
import { formatToolArgsForDisplay } from "../../tools/tool-args-display";

function consumerId(prefix: string): string {
  return `${prefix}:${process.pid}:${Math.random().toString(16).slice(2)}`;
}

function formatInt(n: number): string {
  // Locale-independent grouping.
  return String(Math.trunc(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function formatSeconds(ms: number): string {
  const sec = ms / 1000;
  return `${sec.toFixed(1)}s`;
}

type ToolsLike = Record<
  string,
  { description?: string; inputSchema?: unknown }
>;

function safeStringify(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof URL) return value.toString();
  if (value === undefined) return "undefined";
  try {
    const s = JSON.stringify(value);
    return s ?? String(value);
  } catch {
    return String(value);
  }
}

function getToolDefsText(tools: ToolsLike | null): string {
  if (!tools) return "";
  const entries = Object.entries(tools);
  if (entries.length === 0) return "";

  const toolDesc = entries.map(([name, tool]) => {
    let jsonSchema: unknown = {};
    try {
      jsonSchema = asSchema(tool?.inputSchema as never).jsonSchema;
    } catch {
      jsonSchema = {};
    }
    return {
      name,
      description: tool?.description ?? "",
      jsonSchema,
    };
  });

  return JSON.stringify(toolDesc);
}

function isAssistantToolCallMessage(message: ModelMessage): boolean {
  if (message.role !== "assistant") return false;
  if (!Array.isArray(message.content)) return false;

  return message.content.some((part) => {
    if (!part || typeof part !== "object") return false;
    return part.type === "tool-call";
  });
}

function countCharsInMessage(
  message: ModelMessage,
): Omit<InputCompositionChars, "toolDefsChars" | "callCount"> {
  let systemChars = 0;
  let assistantChars = 0;
  let userChars = 0;
  let toolResultChars = 0;

  const role = message.role;

  if (role === "tool") {
    toolResultChars += safeStringify(message.content).length;
    return { systemChars, assistantChars, userChars, toolResultChars };
  }

  if (role === "system") {
    systemChars += safeStringify(message.content).length;
    return { systemChars, assistantChars, userChars, toolResultChars };
  }

  if (role === "user") {
    userChars += safeStringify(message.content).length;
    return { systemChars, assistantChars, userChars, toolResultChars };
  }

  if (role === "assistant") {
    if (Array.isArray(message.content)) {
      for (const part of message.content) {
        if (!part || typeof part !== "object") continue;
        const t = part.type;
        if (t === "tool-result") {
          toolResultChars += safeStringify(part).length;
          continue;
        }
        assistantChars += safeStringify(part).length;
      }
      return { systemChars, assistantChars, userChars, toolResultChars };
    }

    assistantChars += safeStringify(message.content).length;
    return { systemChars, assistantChars, userChars, toolResultChars };
  }

  // Unknown role; treat as assistant-ish overhead.
  assistantChars += safeStringify(
    (message as unknown as { content?: unknown }).content,
  ).length;
  return { systemChars, assistantChars, userChars, toolResultChars };
}

type InputCompositionChars = {
  systemChars: number;
  assistantChars: number;
  userChars: number;
  toolDefsChars: number;
  toolResultChars: number;
  callCount: number;
};

function buildPromptSnapshots(params: {
  initialMessages: ModelMessage[];
  responseMessages: ModelMessage[];
}): ModelMessage[][] {
  const snapshots: ModelMessage[][] = [];
  const state: ModelMessage[] = [...params.initialMessages];
  snapshots.push([...state]);

  for (let i = 0; i < params.responseMessages.length; i++) {
    const msg = params.responseMessages[i];
    if (!msg) continue;

    if (isAssistantToolCallMessage(msg)) {
      state.push(msg);

      // In tool mode, tool results come in as `role: "tool"` messages.
      let j = i + 1;
      while (j < params.responseMessages.length) {
        const next = params.responseMessages[j];
        if (!next || next.role !== "tool") break;
        state.push(next);
        j++;
      }

      snapshots.push([...state]);
      i = j - 1;
      continue;
    }

    state.push(msg);
  }

  return snapshots;
}

function estimateInputCompositionChars(input: {
  system: string;
  initialMessages: ModelMessage[];
  responseMessages: ModelMessage[];
  tools: unknown;
}): InputCompositionChars {
  const tools = (
    input.tools && typeof input.tools === "object"
      ? (input.tools as ToolsLike)
      : null
  ) satisfies ToolsLike | null;

  const snapshots = buildPromptSnapshots({
    initialMessages: input.initialMessages,
    responseMessages: input.responseMessages,
  });

  const toolDefsText = getToolDefsText(tools);
  const perCallToolDefsChars = toolDefsText.length;
  const perCallSystemChars = input.system.length;

  let systemChars = 0;
  let assistantChars = 0;
  let userChars = 0;
  let toolResultChars = 0;

  for (const snapshot of snapshots) {
    // AI SDK sends the system prompt per model call (separate from `messages`).
    systemChars += perCallSystemChars;

    for (const message of snapshot) {
      const counts = countCharsInMessage(message);
      systemChars += counts.systemChars;
      assistantChars += counts.assistantChars;
      userChars += counts.userChars;
      toolResultChars += counts.toolResultChars;
    }
  }

  return {
    systemChars,
    assistantChars,
    userChars,
    toolDefsChars: perCallToolDefsChars * snapshots.length,
    toolResultChars,
    callCount: snapshots.length,
  };
}

function computePercentages(chars: {
  systemChars: number;
  assistantChars: number;
  userChars: number;
  toolDefsChars: number;
  toolResultChars: number;
}): { S: number; A: number; U: number; TD: number; TR: number } | null {
  const entries = [
    ["S", chars.systemChars],
    ["A", chars.assistantChars],
    ["U", chars.userChars],
    ["TD", chars.toolDefsChars],
    ["TR", chars.toolResultChars],
  ] as const;

  const total = entries.reduce((acc, [, v]) => acc + v, 0);
  if (total <= 0) return null;

  const raw = entries.map(([k, v]) => {
    const pct = Math.round((v * 100) / total);
    return { k, v, pct };
  });

  let sum = raw.reduce((acc, e) => acc + e.pct, 0);
  const diff = 100 - sum;
  if (diff !== 0) {
    let maxIdx = 0;
    for (let i = 1; i < raw.length; i++) {
      if (raw[i]!.v > raw[maxIdx]!.v) maxIdx = i;
    }
    raw[maxIdx]!.pct += diff;
    sum += diff;
  }

  const map = Object.fromEntries(
    raw.map((e) => [e.k, Math.max(0, Math.min(100, e.pct))]),
  ) as { S: number; A: number; U: number; TD: number; TR: number };

  return map;
}

function buildInputCompositionLine(input: {
  system: string;
  initialMessages: ModelMessage[];
  responseMessages: ModelMessage[];
  tools: unknown;
}): string | null {
  const chars = estimateInputCompositionChars({
    system: input.system,
    initialMessages: input.initialMessages,
    responseMessages: input.responseMessages,
    tools: input.tools,
  });

  const pct = computePercentages(chars);
  if (!pct) return null;

  return `[IC] S: ${pct.S}%; A: ${pct.A}%; U: ${pct.U}%; TD: ${pct.TD}%; TR: ${pct.TR}%`;
}

function buildStatsLine(params: {
  modelLabel: string;
  usage: LanguageModelUsage | undefined;
  ttftMs: number | null;
  tps: number | null;
  icLine: string | null;
}): string {
  const u = params.usage;

  const inputTokens = typeof u?.inputTokens === "number" ? u.inputTokens : null;
  const outputTokens =
    typeof u?.outputTokens === "number" ? u.outputTokens : null;
  const noCache =
    typeof u?.inputTokenDetails?.noCacheTokens === "number"
      ? u.inputTokenDetails.noCacheTokens
      : null;

  const outputReasoning =
    typeof u?.outputTokenDetails?.reasoningTokens === "number"
      ? u.outputTokenDetails.reasoningTokens
      : null;

  const parts: string[] = [];
  parts.push(`[M]: ${params.modelLabel}`);

  if (inputTokens !== null || outputTokens !== null) {
    const tokenParts: string[] = [];
    if (inputTokens !== null) {
      tokenParts.push(
        `↑${formatInt(inputTokens)}${noCache !== null ? ` (NC: ${formatInt(noCache)})` : ""}`,
      );
    }
    if (outputTokens !== null) {
      tokenParts.push(
        `↓${formatInt(outputTokens)}${outputReasoning !== null ? ` (R: ${formatInt(outputReasoning)})` : ""}`,
      );
    }
    parts.push(`[T]: ${tokenParts.join(" ")}`);
  }

  if (params.ttftMs !== null) {
    parts.push(`[TTFT]: ${formatSeconds(params.ttftMs)}`);
  }

  if (params.tps !== null) {
    parts.push(`[TPS]: ${params.tps.toFixed(1)}`);
  }

  if (params.icLine) {
    parts.push(params.icLine);
  }

  return `*${parts.join("; ")}*`;
}

type Enqueued = {
  requestId: string;
  sessionId: string;
  requestClient: AdapterPlatform;
  queue: RequestQueueMode;
  messages: ModelMessage[];
  raw?: unknown;
};

type SessionQueue = {
  running: boolean;
  agent: AiSdkPiAgent<ToolSet> | null;
  queue: Enqueued[];
  activeRequestId: string | null;
};

export async function startBusAgentRunner(params: {
  bus: LilacBus;
  subscriptionId: string;
  config?: CoreConfig;
  /** Where core tools operate (fs tool root). */
  cwd?: string;
}) {
  const { bus, subscriptionId } = params;

  const logger = new Logger({
    logLevel: resolveLogLevel(),
    module: "bus-agent-runner",
  });

  let cfg = params.config ?? (await getCoreConfig());
  const cwd = params.cwd ?? process.env.LILAC_WORKSPACE_DIR ?? process.cwd();

  const bySession = new Map<string, SessionQueue>();

  const sub = await bus.subscribeTopic(
    "cmd.request",
    {
      mode: "work",
      subscriptionId,
      consumerId: consumerId(subscriptionId),
      offset: { type: "begin" },
      batch: { maxWaitMs: 250 },
    },
    async (msg, ctx) => {
      if (msg.type !== lilacEventTypes.CmdRequestMessage) return;

      const requestId = msg.headers?.request_id;
      const sessionId = msg.headers?.session_id;
      const requestClient = msg.headers?.request_client ?? "unknown";
      if (!requestId || !sessionId) {
        throw new Error(
          "cmd.request.message missing required headers.request_id/session_id",
        );
      }

      logger.info("cmd.request.message received", {
        requestId,
        sessionId,
        requestClient,
        queue: msg.data.queue,
        messageCount: msg.data.messages.length,
      });

      // reload config opportunistically (mtime cached in getCoreConfig).
      cfg = params.config ?? (await getCoreConfig());

      const entry: Enqueued = {
        requestId,
        sessionId,
        requestClient,
        queue: msg.data.queue,
        messages: msg.data.messages,
        raw: msg.data.raw,
      };

      const state = bySession.get(sessionId) ?? {
        running: false,
        agent: null,
        queue: [],
        activeRequestId: null,
      };
      bySession.set(sessionId, state);

      if (!state.running) {
        state.queue.push(entry);
        drainSessionQueue(sessionId, state).catch((e: unknown) => {
          logger.error("drainSessionQueue failed", { sessionId, requestId }, e);
        });
      } else {
        // If the message is intended for the currently active request, apply immediately.
        if (
          state.activeRequestId &&
          state.activeRequestId === requestId &&
          state.agent
        ) {
          await applyToRunningAgent(state.agent, entry);
        } else {
          // No parallel runs: queue prompt messages for later.
          state.queue.push(entry);
          await publishLifecycle({
            bus,
            headers: {
              request_id: requestId,
              session_id: sessionId,
              request_client: requestClient,
            },
            state: "queued",
            detail: "queued behind active request",
          });

          logger.info("request queued behind active run", {
            requestId,
            sessionId,
            activeRequestId: state.activeRequestId,
            queueDepth: state.queue.length,
          });
        }
      }

      await ctx.commit();
    },
  );

  async function drainSessionQueue(sessionId: string, state: SessionQueue) {
    if (state.running) return;

    const next = state.queue.shift();
    if (!next) return;

    state.running = true;
    state.activeRequestId = next.requestId;

    const runStartedAt = Date.now();

    const headers = {
      request_id: next.requestId,
      session_id: next.sessionId,
      request_client: next.requestClient,
    };

    await publishLifecycle({
      bus,
      headers,
      state: "running",
      detail:
        next.queue !== "prompt"
          ? `coerced queue=${next.queue} to prompt (no active run)`
          : undefined,
    });
    await bus.publish(lilacEventTypes.EvtRequestReply, {}, { headers });

    const resolved = resolveModelSlot(cfg, "main");

    logger.info("agent run starting", {
      requestId: next.requestId,
      sessionId: next.sessionId,
      requestClient: next.requestClient,
      model: resolved.spec,
      messageCount: next.messages.length,
      queuedForSession: state.queue.length,
    });

    const agent = new AiSdkPiAgent<ToolSet>({
      system: cfg.agent.systemPrompt,
      model: resolved.model,
      tools: {
        ...bashToolWithCwd(cwd),
        ...fsTool(cwd),
        ...applyPatchTool({ cwd }),
      },
      providerOptions: resolved.providerOptions,
    });

    agent.setContext({
      sessionId: next.sessionId,
      requestId: next.requestId,
      requestClient: next.requestClient,
    });

    const unsubscribeCompaction = await attachAutoCompaction(agent, {
      model: resolved.spec,
      modelCapability: new ModelCapability(),
    });

    state.agent = agent;

    let finalText = "";

    const toolStartMs = new Map<string, number>();

    // Stats and timings for this run (agent model only).
    let initialMessages: ModelMessage[] = [];
    const runStats: {
      totalUsage?: LanguageModelUsage;
      finalMessages?: ModelMessage[];
      firstTextDeltaAt?: number;
    } = {};

    const unsubscribe = agent.subscribe((event: AiSdkPiAgentEvent<ToolSet>) => {
      if (event.type === "agent_end") {
        runStats.totalUsage = event.totalUsage;
        runStats.finalMessages = event.messages;
      }

      if (
        event.type === "message_update" &&
        event.assistantMessageEvent.type === "text_delta"
      ) {
        runStats.firstTextDeltaAt ??= Date.now();

        const delta = event.assistantMessageEvent.delta;
        finalText += delta;

        bus
          .publish(
            lilacEventTypes.EvtAgentOutputDeltaText,
            { delta },
            { headers },
          )
          .catch((e: unknown) => {
            logger.error(
              "failed to publish output delta",
              { requestId: headers.request_id, sessionId: headers.session_id },
              e,
            );
          });
      }

      if (event.type === "tool_execution_start") {
        toolStartMs.set(event.toolCallId, Date.now());

        bus
          .publish(
            lilacEventTypes.EvtAgentOutputToolCall,
            {
              toolCallId: event.toolCallId,
              status: "start",
              display: `[${event.toolName}]${formatToolArgsForDisplay(event.toolName, event.args)}`,
            },
            { headers },
          )
          .catch((e: unknown) => {
            logger.error(
              "failed to publish tool start",
              {
                requestId: headers.request_id,
                sessionId: headers.session_id,
                toolCallId: event.toolCallId,
                toolName: event.toolName,
              },
              e,
            );
          });
      }

      if (event.type === "tool_execution_end") {
        const started = toolStartMs.get(event.toolCallId);
        const toolDurationMs = started ? Date.now() - started : undefined;

        logger.debug("tool finished", {
          requestId: headers.request_id,
          sessionId: headers.session_id,
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          ok: !event.isError,
          durationMs: toolDurationMs,
        });

        bus
          .publish(
            lilacEventTypes.EvtAgentOutputToolCall,
            {
              toolCallId: event.toolCallId,
              status: "end",
              display: `[${event.toolName}]${formatToolArgsForDisplay(event.toolName, event.args)}`,
              ok: !event.isError,
              error: event.isError ? "tool error" : undefined,
            },
            { headers },
          )
          .catch((e: unknown) => {
            logger.error(
              "failed to publish tool end",
              {
                requestId: headers.request_id,
                sessionId: headers.session_id,
                toolCallId: event.toolCallId,
                toolName: event.toolName,
              },
              e,
            );
          });
      }

      if (event.type === "agent_end") {
        // Best-effort fallback: if deltas didn't populate finalText, take last assistant string.
        if (!finalText) {
          const last = event.messages[event.messages.length - 1];
          if (
            last &&
            last.role === "assistant" &&
            typeof last.content === "string"
          ) {
            finalText = last.content;
          }
        }
      }
    });

    try {
      // First message should be a prompt.
      // If additional messages for the same request id were queued before the run started,
      // merge them into the initial prompt so they don't become separate runs.
      const mergedInitial = mergeQueuedForSameRequest(next, state.queue);
      initialMessages = [...mergedInitial];

      await agent.prompt(mergedInitial);

      await agent.waitForIdle();

      await bus.publish(
        lilacEventTypes.EvtAgentOutputResponseText,
        { finalText },
        { headers },
      );

      // Log stats in the js-llmcord-ish one-liner format.
      const endAt = Date.now();
      const ttftMs = runStats.firstTextDeltaAt
        ? runStats.firstTextDeltaAt - runStartedAt
        : null;
      const outputTokens = runStats.totalUsage?.outputTokens;
      const rawTps =
        typeof outputTokens === "number" && runStats.firstTextDeltaAt
          ? outputTokens / ((endAt - runStats.firstTextDeltaAt) / 1000)
          : null;
      const tps = rawTps !== null && Number.isFinite(rawTps) ? rawTps : null;

      const responseMessages = runStats.finalMessages
        ? runStats.finalMessages.slice(initialMessages.length)
        : [];

      const icLine = buildInputCompositionLine({
        system: agent.state.system,
        initialMessages,
        responseMessages,
        tools: agent.state.tools,
      });

      const modelLabel = resolved.modelId;
      const statsLine = buildStatsLine({
        modelLabel,
        usage: runStats.totalUsage,
        ttftMs,
        tps,
        icLine,
      });

      logger.info(statsLine, {
        requestId: headers.request_id,
        sessionId: headers.session_id,
      });

      logger.info("agent run resolved", {
        requestId: headers.request_id,
        sessionId: headers.session_id,
        durationMs: Date.now() - runStartedAt,
        finalTextChars: finalText.length,
      });

      await publishLifecycle({ bus, headers, state: "resolved" });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await publishLifecycle({ bus, headers, state: "failed", detail: msg });
      await bus.publish(
        lilacEventTypes.EvtAgentOutputResponseText,
        { finalText: `Error: ${msg}` },
        { headers },
      );

      logger.error(
        "agent run failed",
        {
          requestId: headers.request_id,
          sessionId: headers.session_id,
          durationMs: Date.now() - runStartedAt,
        },
        e,
      );
    } finally {
      unsubscribe();
      unsubscribeCompaction();
      state.agent = null;
      state.activeRequestId = null;
      state.running = false;
      drainSessionQueue(sessionId, state).catch((e: unknown) => {
        logger.error("drainSessionQueue failed", { sessionId }, e);
      });
    }
  }

  return {
    stop: async () => {
      await sub.stop();
      bySession.clear();
    },
  };
}

async function publishLifecycle(params: {
  bus: LilacBus;
  headers: {
    request_id: string;
    session_id: string;
    request_client: AdapterPlatform;
  };
  state: RequestLifecycleState;
  detail?: string;
}) {
  await params.bus.publish(
    lilacEventTypes.EvtRequestLifecycleChanged,
    { state: params.state, detail: params.detail, ts: Date.now() },
    { headers: params.headers },
  );
}

function mergeQueuedForSameRequest(
  first: Enqueued,
  queue: Enqueued[],
): ModelMessage[] {
  const merged: ModelMessage[] = [...first.messages];

  // Pull in any already-queued items for the same request id so they become
  // additional user messages in the same initial run.
  for (let i = 0; i < queue.length; ) {
    const next = queue[i]!;
    if (next.requestId !== first.requestId) {
      i += 1;
      continue;
    }

    merged.push(...next.messages);
    queue.splice(i, 1);
  }

  return merged;
}

async function applyToRunningAgent(
  agent: AiSdkPiAgent<ToolSet>,
  entry: Enqueued,
) {
  const merged = mergeToSingleUserMessage(entry.messages);

  switch (entry.queue) {
    case "steer": {
      agent.steer(merged);
      return;
    }
    case "followUp": {
      agent.followUp(merged);
      return;
    }
    case "interrupt": {
      await agent.interrupt(merged);
      return;
    }
    case "prompt": {
      // Cannot prompt while streaming; treat as followUp.
      agent.followUp(merged);
      return;
    }
    default: {
      const _exhaustive: never = entry.queue;
      return _exhaustive;
    }
  }
}

function mergeToSingleUserMessage(messages: ModelMessage[]): ModelMessage {
  // If any user message has non-string content (multipart), do not merge.
  // Preserve raw parts for downstream processing.
  for (let i = messages.length - 1; i >= 0; i--) {
    const newest = messages[i]!;
    if (newest.role !== "user") continue;
    if (typeof newest.content !== "string") {
      return newest;
    }
  }

  // Preserve existing behavior: merge batches into one user message separated by blank lines.
  const parts: string[] = [];
  for (const m of messages) {
    if (m.role !== "user") continue;
    if (typeof m.content === "string") {
      parts.push(m.content);
    }
  }

  return {
    role: "user",
    content: parts.join("\n\n").trim(),
  };
}
