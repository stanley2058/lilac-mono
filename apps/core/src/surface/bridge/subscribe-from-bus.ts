import {
  lilacEventTypes,
  outReqTopic,
  type LilacBus,
} from "@stanley2058/lilac-event-bus";

import { resolveLogLevel } from "@stanley2058/lilac-utils";
import { Logger } from "@stanley2058/simple-module-logger";

import type { SurfaceAdapter, SurfaceOutputPart } from "../adapter";
import type { MsgRef, SessionRef, SurfaceAttachment } from "../types";

function getConsumerId(prefix: string): string {
  return `${prefix}:${process.pid}:${Math.random().toString(16).slice(2)}`;
}

function parseDiscordReplyTo(params: {
  requestId: string;
  sessionId: string;
}): MsgRef | null {
  const parts = params.requestId.split(":");
  if (parts.length !== 3) return null;
  const [surface, sessionId] = parts;
  const surfaceSpecificId = parts[2];
  if (!surfaceSpecificId) return null;
  if (surface !== "discord") return null;
  if (sessionId !== params.sessionId) return null;

  return {
    platform: "discord",
    channelId: params.sessionId,
    messageId: surfaceSpecificId,
  };
}

function decodeBase64ToBytes(base64: string): Uint8Array {
  // Bun provides Buffer.
  const buf = Buffer.from(base64, "base64");
  return new Uint8Array(buf);
}

function toAttachment(params: {
  mimeType: string;
  dataBase64: string;
  filename?: string;
}): SurfaceAttachment {
  const kind: SurfaceAttachment["kind"] = params.mimeType.startsWith("image/")
    ? "image"
    : "file";

  const filename = params.filename ?? (kind === "image" ? "image" : "file");

  return {
    kind,
    mimeType: params.mimeType,
    filename,
    bytes: decodeBase64ToBytes(params.dataBase64),
  };
}

type ActiveRelay = {
  stop(): Promise<void>;
};

export async function bridgeBusToAdapter(params: {
  adapter: SurfaceAdapter;
  bus: LilacBus;
  platform: "discord";
  subscriptionId: string;
  idleTimeoutMs?: number;
}) {
  const logger = new Logger({
    logLevel: resolveLogLevel(),
    module: "bridge:bus-to-adapter",
  });

  const {
    adapter,
    bus,
    platform,
    subscriptionId,
    idleTimeoutMs = 60 * 60 * 1000,
  } = params;

  const activeRelays = new Map<string, ActiveRelay>();

  const sub = await bus.subscribeTopic(
    "evt.request",
    {
      mode: "fanout",
      subscriptionId,
      consumerId: getConsumerId(subscriptionId),
      offset: { type: "now" },
      batch: { maxWaitMs: 250 },
    },
    async (msg, ctx) => {
      if (msg.type !== lilacEventTypes.EvtRequestReply) return;

      const requestId = msg.headers?.request_id;
      const sessionId = msg.headers?.session_id;
      const requestClient = msg.headers?.request_client;

      if (!requestId || !sessionId) {
        // Do not ack malformed messages: they need investigation.
        throw new Error(
          "evt.request.reply missing required headers.request_id/session_id",
        );
      }

      if (requestClient && requestClient !== platform) {
        await ctx.commit();
        return;
      }

      if (activeRelays.has(requestId)) {
        await ctx.commit();
        return;
      }

      logger.info("starting reply relay", {
        requestId,
        sessionId,
        requestClient,
      });

      const relay = await startRelay({
        adapter,
        bus,
        platform,
        requestId,
        sessionId,
        idleTimeoutMs,
      });

      activeRelays.set(requestId, relay);

      await ctx.commit();
    },
  );

  async function startRelay(input: {
    adapter: SurfaceAdapter;
    bus: LilacBus;
    platform: "discord";
    requestId: string;
    sessionId: string;
    idleTimeoutMs: number;
  }): Promise<ActiveRelay> {
    const { requestId, sessionId, idleTimeoutMs } = input;

    const sessionRef: SessionRef = {
      platform,
      channelId: sessionId,
    };

    const replyTo = parseDiscordReplyTo({ requestId, sessionId });

    const out = await adapter.startOutput(sessionRef, {
      replyTo: replyTo ?? undefined,
    });

    let timeout: ReturnType<typeof setTimeout> | null = null;
    const bumpTimeout = () => {
      if (timeout) clearTimeout(timeout);
      timeout = setTimeout(() => {
        logger.warn("reply relay idle timeout", {
          requestId,
          sessionId,
          idleTimeoutMs,
        });

        out.abort("timeout").catch((e: unknown) => {
          logger.error("failed to abort output stream", { requestId }, e);
        });
        relayStop().catch((e: unknown) => {
          logger.error("failed to stop relay", { requestId }, e);
        });
      }, idleTimeoutMs);
    };

    let stopped = false;
    let outputSub: { stop(): Promise<void> } | null = null;

    const relayStop = async () => {
      if (stopped) return;
      stopped = true;
      if (timeout) {
        clearTimeout(timeout);
        timeout = null;
      }
      try {
        await outputSub?.stop();
      } catch {
        // ignore
      }
      activeRelays.delete(requestId);

      logger.info("reply relay stopped", {
        requestId,
        sessionId,
      });
    };

    bumpTimeout();

    outputSub = await bus.subscribeTopic(
      outReqTopic(requestId),
      {
        mode: "tail",
        offset: { type: "begin" },
        batch: { maxWaitMs: 250 },
      },
      async (outMsg) => {
        bumpTimeout();

        let part: SurfaceOutputPart | null = null;

        switch (outMsg.type) {
          case lilacEventTypes.EvtAgentOutputDeltaReasoning: {
            // ignored for now
            break;
          }

          case lilacEventTypes.EvtAgentOutputDeltaText: {
            part = { type: "text.delta", delta: outMsg.data.delta };
            break;
          }

          case lilacEventTypes.EvtAgentOutputToolCall: {
            part = {
              type: "tool.status",
              update: {
                toolCallId: outMsg.data.toolCallId,
                display: outMsg.data.display,
                status: outMsg.data.status,
                ok: outMsg.data.ok,
                error: outMsg.data.error,
              },
            };
            break;
          }

          case lilacEventTypes.EvtAgentOutputResponseBinary: {
            part = {
              type: "attachment.add",
              attachment: toAttachment(outMsg.data),
            };
            break;
          }

          case lilacEventTypes.EvtAgentOutputResponseText: {
            await out.push({ type: "text.set", text: outMsg.data.finalText });
            await out.finish();
            await relayStop();

            logger.info("reply relay finished", {
              requestId,
              sessionId,
              finalTextChars: outMsg.data.finalText.length,
            });
            return;
          }

          default:
            return;
        }

        if (part) {
          await out.push(part);
        }
      },
    );

    return { stop: relayStop };
  }

  return {
    stop: async () => {
      await sub.stop();
      await Promise.all([...activeRelays.values()].map((r) => r.stop()));
    },
  };
}
