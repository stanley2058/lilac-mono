import type { LanguageModel, ModelMessage, ToolSet } from "ai";
import type { CoreConfig } from "@stanley2058/lilac-utils";
import {
  getCoreConfig,
  ModelCapability,
  providers,
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

import { bashTool } from "../../tools/bash";
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

  let cfg = params.config ?? (await getCoreConfig());
  const cwd = params.cwd ?? process.cwd();

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
        drainSessionQueue(sessionId, state).catch(console.error);
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

    const headers = {
      request_id: next.requestId,
      session_id: next.sessionId,
      request_client: next.requestClient,
    };

    await publishLifecycle({ bus, headers, state: "running" });
    await bus.publish(lilacEventTypes.EvtRequestReply, {}, { headers });

    const { model, provider } = resolveModel(cfg);

    const agent = new AiSdkPiAgent<ToolSet>({
      system: cfg.agent.systemPrompt,
      model,
      tools: {
        ...bashTool(),
        ...fsTool(cwd),
      },
      providerOptions: cfg.models.main.options
        ? { [provider]: cfg.models.main.options }
        : undefined,
    });

    agent.setContext({
      sessionId: next.sessionId,
      requestId: next.requestId,
      requestClient: next.requestClient,
    });

    const unsubscribeCompaction = await attachAutoCompaction(agent, {
      model: cfg.models.main.model,
      modelCapability: new ModelCapability(),
    });

    state.agent = agent;

    let finalText = "";

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
          .catch(console.error);
      }

      if (event.type === "tool_execution_start") {
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
          .catch(console.error);
      }

      if (event.type === "tool_execution_end") {
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
          .catch(console.error);
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
      await applyToIdleAgent(agent, next);

      await agent.waitForIdle();

      await bus.publish(
        lilacEventTypes.EvtAgentOutputResponseText,
        { finalText },
        { headers },
      );

      await publishLifecycle({ bus, headers, state: "resolved" });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await publishLifecycle({ bus, headers, state: "failed", detail: msg });
      await bus.publish(
        lilacEventTypes.EvtAgentOutputResponseText,
        { finalText: `Error: ${msg}` },
        { headers },
      );
    } finally {
      unsubscribe();
      unsubscribeCompaction();
      state.agent = null;
      state.activeRequestId = null;
      state.running = false;
      drainSessionQueue(sessionId, state).catch(console.error);
    }
  }

  return {
    stop: async () => {
      await sub.stop();
      bySession.clear();
    },
  };
}

function resolveModel(cfg: CoreConfig): { model: LanguageModel; provider: string } {
  const spec = cfg.models.main.model;
  const slash = spec.indexOf("/");
  if (slash <= 0) throw new Error(`Invalid model spec '${spec}'`);

  const provider = spec.slice(0, slash);
  const modelId = spec.slice(slash + 1);

  const p = (providers as Record<string, unknown>)[provider];
  if (!p) {
    throw new Error(
      `Unknown provider '${provider}' (models.main.model='${spec}')`,
    );
  }

  if (typeof p !== "function") {
    throw new Error(
      `Provider '${provider}' is not configured (models.main.model='${spec}')`,
    );
  }

  const model = (p as (id: string) => LanguageModel)(modelId);
  return { model, provider };
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

async function applyToIdleAgent(agent: AiSdkPiAgent<ToolSet>, entry: Enqueued) {
  if (entry.queue !== "prompt") {
    // v1: if we got a steer/followUp before first prompt, treat it as prompt.
  }
  await agent.prompt(entry.messages);
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
