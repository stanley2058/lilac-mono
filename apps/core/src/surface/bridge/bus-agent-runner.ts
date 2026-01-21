import type { ModelMessage, ToolSet } from "ai";
import type { CoreConfig } from "@stanley2058/lilac-utils";
import {
  getCoreConfig,
  ModelCapability,
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

import { Logger, type LogLevel } from "@stanley2058/simple-module-logger";

import { bashToolWithCwd } from "../../tools/bash";
import { fsTool } from "../../tools/fs/fs";

function consumerId(prefix: string): string {
  return `${prefix}:${process.pid}:${Math.random().toString(16).slice(2)}`;
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
    logLevel: (process.env.LOG_LEVEL as LogLevel) ?? "info",
    module: "bus-agent-runner",
  });

  let cfg = params.config ?? (await getCoreConfig());
  const cwd =
    params.cwd ?? process.env.LILAC_WORKSPACE_DIR ?? process.cwd();

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

    const unsubscribe = agent.subscribe((event: AiSdkPiAgentEvent<ToolSet>) => {
      if (
        event.type === "message_update" &&
        event.assistantMessageEvent.type === "text_delta"
      ) {
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
              display: `[${event.toolName}]${typeof event.args === "string" ? ` ${event.args}` : ""}`,
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
              display: `[${event.toolName}]${typeof event.args === "string" ? ` ${event.args}` : ""}`,
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

      await agent.prompt(mergedInitial);

      await agent.waitForIdle();

      await bus.publish(
        lilacEventTypes.EvtAgentOutputResponseText,
        { finalText },
        { headers },
      );

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
