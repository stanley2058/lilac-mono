import {
  lilacEventTypes,
  outReqTopic,
  type LilacBus,
} from "@stanley2058/lilac-event-bus";

import { env, resolveLogLevel } from "@stanley2058/lilac-utils";
import { Logger } from "@stanley2058/simple-module-logger";

import type {
  SurfaceAdapter,
  SurfaceOutputPart,
  StartOutputOpts,
  SurfaceToolStatusUpdate,
  TypingIndicatorProvider,
  TypingIndicatorSubscription,
} from "../adapter";
import type { MsgRef, SessionRef, SurfaceAttachment } from "../types";

import {
  deleteIssueCommentReactionById,
  deleteIssueReactionById,
} from "../../github/github-api";
import {
  parseGithubRequestId,
  parseGithubSessionId,
} from "../../github/github-ids";
import {
  clearGithubAck,
  getGithubAck,
  getGithubLatestRequestForSession,
  getGithubRequestMeta,
} from "../../github/github-state";

import type { TranscriptStore } from "../../transcript/transcript-store";

function getConsumerId(prefix: string): string {
  return `${prefix}:${process.pid}:${Math.random().toString(16).slice(2)}`;
}

function isTypingIndicatorProvider(
  adapter: SurfaceAdapter,
): adapter is SurfaceAdapter & TypingIndicatorProvider {
  return "startTyping" in adapter && typeof adapter.startTyping === "function";
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

function parseGithubReplyTo(params: {
  requestId: string;
  sessionId: string;
}): MsgRef | null {
  const parsed = parseGithubRequestId({ requestId: params.requestId });
  if (!parsed) return null;
  if (parsed.sessionId !== params.sessionId) return null;
  return {
    platform: "github",
    channelId: params.sessionId,
    messageId: parsed.triggerId,
  };
}

function parseRouterSessionMode(
  raw: string | undefined,
): "mention" | "active" | undefined {
  if (raw === "mention" || raw === "active") return raw;
  return undefined;
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

async function cleanupGithubAck(input: {
  logger: Logger;
  requestId: string;
  sessionId: string;
}) {
  const ack = getGithubAck(input.requestId);
  if (!ack) return;

  const meta = getGithubRequestMeta(input.requestId);
  const thread = (() => {
    if (meta?.repoFullName) {
      const [owner, repo] = meta.repoFullName.split("/");
      if (owner && repo) {
        return { owner, repo, issueNumber: meta.issueNumber };
      }
    }
    const parsed = parseGithubSessionId(input.sessionId);
    return {
      owner: parsed.owner,
      repo: parsed.repo,
      issueNumber: parsed.number,
    };
  })();

  try {
    if (ack.target.kind === "issue") {
      await deleteIssueReactionById({
        owner: thread.owner,
        repo: thread.repo,
        issueNumber: ack.target.issueNumber,
        reactionId: ack.reactionId,
      });
    } else {
      await deleteIssueCommentReactionById({
        owner: thread.owner,
        repo: thread.repo,
        commentId: ack.target.commentId,
        reactionId: ack.reactionId,
      });
    }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    // Best-effort: ignore if already removed.
    if (!msg.includes("404")) {
      input.logger.warn(
        "failed to delete github ack reaction",
        { requestId: input.requestId },
        e,
      );
    }
  } finally {
    clearGithubAck(input.requestId);
  }
}

type ActiveRelay = {
  stop(): Promise<void>;
  startedAt: number;
  firstOutLogged: boolean;
  reanchor(input: { inheritReplyTo: boolean; replyTo?: MsgRef }): Promise<void>;
};

function toMsgRefFromSurfaceMsgRef(raw: unknown): MsgRef | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const platform = o["platform"];
  const channelId = o["channelId"];
  const messageId = o["messageId"];
  if (platform !== "discord" && platform !== "github") return null;
  if (typeof channelId !== "string" || typeof messageId !== "string")
    return null;
  return {
    platform,
    channelId,
    messageId,
  };
}

export async function bridgeBusToAdapter(params: {
  adapter: SurfaceAdapter;
  bus: LilacBus;
  platform: "discord" | "github";
  subscriptionId: string;
  idleTimeoutMs?: number;
  transcriptStore?: TranscriptStore;
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

  const cmdSurfaceSub = await bus.subscribeTopic(
    "cmd.surface",
    {
      mode: "fanout",
      subscriptionId: `${subscriptionId}:cmd_surface`,
      consumerId: getConsumerId(`${subscriptionId}:cmd_surface`),
      offset: { type: "now" },
      batch: { maxWaitMs: 1000 },
    },
    async (msg, ctx) => {
      if (msg.type !== lilacEventTypes.CmdSurfaceOutputReanchor) return;

      const requestId = msg.headers?.request_id;
      const sessionId = msg.headers?.session_id;
      const requestClient = msg.headers?.request_client;
      if (!requestId || !sessionId) {
        throw new Error(
          "cmd.surface.output.reanchor missing required headers.request_id/session_id",
        );
      }

      if (requestClient && requestClient !== platform) {
        await ctx.commit();
        return;
      }

      const relay = activeRelays.get(requestId);
      if (!relay) {
        await ctx.commit();
        return;
      }

      const replyTo = msg.data.replyTo
        ? toMsgRefFromSurfaceMsgRef(msg.data.replyTo)
        : null;

      await relay
        .reanchor({
          inheritReplyTo: msg.data.inheritReplyTo,
          replyTo: replyTo ?? undefined,
        })
        .catch((e: unknown) => {
          logger.error("reanchor failed", { requestId, sessionId }, e);
        });

      await ctx.commit();
    },
  );

  const sub = await bus.subscribeTopic(
    "evt.request",
    {
      mode: "fanout",
      subscriptionId,
      consumerId: getConsumerId(subscriptionId),
      offset: { type: "now" },
      batch: { maxWaitMs: 1000 },
    },
    async (msg, ctx) => {
      if (msg.type !== lilacEventTypes.EvtRequestReply) return;

      const requestId = msg.headers?.request_id;
      const sessionId = msg.headers?.session_id;
      const requestClient = msg.headers?.request_client;
      const routerSessionMode = parseRouterSessionMode(
        msg.headers?.router_session_mode,
      );

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

      if (env.perf.log) {
        const lagMs = Date.now() - msg.ts;
        const shouldWarn = lagMs >= env.perf.lagWarnMs;
        const shouldSample =
          env.perf.sampleRate > 0 && Math.random() < env.perf.sampleRate;
        if (shouldWarn || shouldSample) {
          (shouldWarn ? logger.warn : logger.info)("perf.bus_lag", {
            stage: "evt.request.reply->bus_to_adapter",
            lagMs,
            requestId,
            sessionId,
            requestClient,
          });
        }
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
        routerSessionMode,
        idleTimeoutMs,
      });

      activeRelays.set(requestId, relay);

      await ctx.commit();
    },
  );

  async function startRelay(input: {
    adapter: SurfaceAdapter;
    bus: LilacBus;
    platform: "discord" | "github";
    requestId: string;
    sessionId: string;
    routerSessionMode?: "mention" | "active";
    idleTimeoutMs: number;
  }): Promise<ActiveRelay> {
    const { requestId, sessionId, idleTimeoutMs } = input;

    const relayStartedAt = Date.now();

    const sessionRef: SessionRef =
      platform === "discord"
        ? { platform, channelId: sessionId }
        : { platform: "github", channelId: sessionId };

    const replyTo =
      platform === "discord"
        ? parseDiscordReplyTo({ requestId, sessionId })
        : parseGithubReplyTo({ requestId, sessionId });

    const baseReplyTo = replyTo ?? undefined;
    let currentReplyTo: MsgRef | undefined = baseReplyTo;

    let outTextAcc = "";
    const toolStatusById = new Map<string, SurfaceToolStatusUpdate>();

    // Serialize all mutations to the active output stream so reanchor doesn't race.
    let op = Promise.resolve();
    const enqueue = async (fn: () => Promise<void>) => {
      op = op.then(fn);
      await op;
    };

    let streamToken = 0;

    const publishCreatedForToken = (token: number) => (msgRef: MsgRef) => {
      // Only publish created messages for the currently active output stream.
      // This prevents a reanchor from temporarily treating "frozen" follow-up messages
      // (e.g. attachment flushes) as the active streaming target.
      if (token !== streamToken) return;

      bus
        .publish(
          lilacEventTypes.EvtSurfaceOutputMessageCreated,
          {
            msgRef: {
              platform: msgRef.platform,
              channelId: msgRef.channelId,
              messageId: msgRef.messageId,
            },
          },
          {
            headers: {
              request_id: requestId,
              session_id: sessionId,
              request_client: input.platform,
            },
          },
        )
        .catch((e: unknown) => {
          logger.debug(
            "failed to publish output message created",
            { requestId },
            e,
          );
        });
    };

    const buildStartOpts = (
      overrideReplyTo: MsgRef | undefined,
      token: number,
    ): StartOutputOpts => {
      const startOpts: StartOutputOpts = {
        replyTo: overrideReplyTo,
        requestId,
        onMessageCreated: publishCreatedForToken(token),
      };
      if (input.routerSessionMode) {
        startOpts.sessionMode = input.routerSessionMode;
      }
      return startOpts;
    };

    streamToken += 1;
    let out = await adapter.startOutput(
      sessionRef,
      buildStartOpts(baseReplyTo, streamToken),
    );

    let typing: TypingIndicatorSubscription | null = null;

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
    let firstOutLogged = false;

    const relayStop = async () => {
      if (stopped) return;
      stopped = true;
      if (timeout) {
        clearTimeout(timeout);
        timeout = null;
      }
      try {
        await typing?.stop();
      } catch {
        // ignore
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

    const subStart = Date.now();
    outputSub = await bus.subscribeTopic(
      outReqTopic(requestId),
      {
        mode: "tail",
        offset: { type: "begin" },
        batch: { maxWaitMs: 250 },
      },
      async (outMsg) => {
        if (env.perf.log && !firstOutLogged) {
          firstOutLogged = true;
          const now = Date.now();
          const sinceRelayStartMs = now - relayStartedAt;
          const outBusLagMs = now - outMsg.ts;
          const shouldWarn =
            sinceRelayStartMs >= env.perf.lagWarnMs ||
            outBusLagMs >= env.perf.lagWarnMs;
          const shouldSample =
            env.perf.sampleRate > 0 && Math.random() < env.perf.sampleRate;
          if (shouldWarn || shouldSample) {
            (shouldWarn ? logger.warn : logger.info)(
              "perf.output_first_event",
              {
                requestId,
                sessionId,
                sinceRelayStartMs,
                outBusLagMs,
                outType: outMsg.type,
              },
            );
          }
        }

        bumpTimeout();

        await enqueue(async () => {
          let part: SurfaceOutputPart | null = null;

          switch (outMsg.type) {
            case lilacEventTypes.EvtAgentOutputDeltaReasoning: {
              // ignored for now
              break;
            }

            case lilacEventTypes.EvtAgentOutputDeltaText: {
              outTextAcc += outMsg.data.delta;
              part = { type: "text.delta", delta: outMsg.data.delta };
              break;
            }

            case lilacEventTypes.EvtAgentOutputToolCall: {
              const update = {
                toolCallId: outMsg.data.toolCallId,
                display: outMsg.data.display,
                status: outMsg.data.status,
                ok: outMsg.data.ok,
                error: outMsg.data.error,
              } satisfies SurfaceToolStatusUpdate;

              toolStatusById.set(update.toolCallId, update);

              part = {
                type: "tool.status",
                update,
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
              if (platform === "github") {
                const latest = getGithubLatestRequestForSession(sessionId);
                if (latest && latest !== requestId) {
                  logger.info("github reply suppressed (superseded)", {
                    requestId,
                    sessionId,
                    latest,
                  });
                  await out.abort("superseded").catch(() => undefined);
                  await relayStop();
                  return;
                }
              }

              outTextAcc = outMsg.data.finalText;
              await out.push({ type: "text.set", text: outTextAcc });
              const res = await out.finish();

              if (params.transcriptStore) {
                try {
                  params.transcriptStore.linkSurfaceMessagesToRequest({
                    requestId,
                    created: res.created,
                    last: res.last,
                  });
                } catch (e: unknown) {
                  logger.error(
                    "failed to link transcript to surface messages",
                    { requestId, sessionId },
                    e,
                  );
                }
              }
              await relayStop();

              if (platform === "github") {
                await cleanupGithubAck({ logger, requestId, sessionId }).catch(
                  (e: unknown) => {
                    logger.warn(
                      "github ack cleanup failed",
                      { requestId, sessionId },
                      e,
                    );
                  },
                );
              }

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
        });
      },
    );

    if (isTypingIndicatorProvider(adapter)) {
      typing = await adapter.startTyping(sessionRef).catch(() => null);
    }

    if (env.perf.log) {
      const setupMs = Date.now() - subStart;
      const shouldWarn = setupMs >= env.perf.lagWarnMs;
      const shouldSample =
        env.perf.sampleRate > 0 && Math.random() < env.perf.sampleRate;
      if (shouldWarn || shouldSample) {
        (shouldWarn ? logger.warn : logger.info)("perf.subscription_setup", {
          stage: "bus_to_adapter.output_subscribe",
          requestId,
          sessionId,
          setupMs,
        });
      }
    }

    return {
      stop: relayStop,
      startedAt: relayStartedAt,
      firstOutLogged,
      reanchor: async (reanchorInput) => {
        await enqueue(async () => {
          const nextReplyTo = reanchorInput.inheritReplyTo
            ? currentReplyTo
            : reanchorInput.replyTo;

          // Make the new stream active immediately so any messages created during abort
          // do not get published as "active output".
          streamToken += 1;

          // Freeze the current output chain in-place.
          await out.abort("reanchor").catch(() => undefined);

          currentReplyTo = nextReplyTo;

          // Start a new output stream and prime it with current state.
          out = await adapter.startOutput(
            sessionRef,
            buildStartOpts(nextReplyTo, streamToken),
          );

          if (outTextAcc.trim().length > 0) {
            await out.push({ type: "text.set", text: outTextAcc });
          }

          // Replay tool status lines so the new stream shows current Actions.
          for (const u of toolStatusById.values()) {
            await out.push({ type: "tool.status", update: u });
          }
        });
      },
    };
  }

  return {
    stop: async () => {
      await sub.stop();
      await cmdSurfaceSub.stop();
      await Promise.all([...activeRelays.values()].map((r) => r.stop()));
    },
  };
}
