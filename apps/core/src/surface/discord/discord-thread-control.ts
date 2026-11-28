import type { CoreConfig } from "@stanley2058/lilac-utils";
import { Result } from "better-result";

import {
  SurfaceInvalidInput,
  SurfaceOperationUnsupported,
  SurfacePermissionDenied,
  SurfaceUnavailable,
  type SurfaceAdapter,
  type SurfaceOperation,
} from "../adapter";
import { formatDiscordMessageRequestId } from "../bridge/request-ids";
import { nativeThreadId } from "../native/native-protocol";
import {
  boundTimelineText,
  projectThreadTimeline,
  sliceTimelineItem,
  type SurfaceThreadControlPort,
  type ThreadReadInput,
  type ThreadInterruptResult,
  type ThreadReadResult,
  type ThreadSendResult,
  type ThreadTimelineItem,
} from "../thread-control";
import type { SurfaceToolTargetRouting } from "../protocol";
import type { SurfaceMessage } from "../types";
import {
  bestEffortAliasForDiscordChannelId,
  discordToolTargetRouting,
} from "./discord-tool-targets";
import {
  DISCORD_RELAY_MAX_MESSAGE_CHARS,
  discordRelayNonce,
  formatDiscordRelayText,
  parseDiscordMessageTarget,
  type DiscordRelayPort,
  type DiscordRouterView,
} from "./discord-relay";
import { buildDiscordUserAliasById } from "./discord-request-router/common";
import { composeDiscordThreadSegments } from "../bridge/request-composition";
import { subagentMessages } from "../native/subagents";
import type { TranscriptStore } from "../../transcript/transcript-store";

const discordTargets: SurfaceToolTargetRouting<"discord"> = discordToolTargetRouting;

function unsupported(operation: SurfaceOperation, message: string) {
  return Result.err(new SurfaceOperationUnsupported({ platform: "discord", operation, message }));
}

function invalidRead(message: string) {
  return Result.err(
    new SurfaceInvalidInput({
      platform: "discord",
      operation: "list-messages",
      field: "id",
      message,
    }),
  );
}

/** Pages a composed thread by item position; cursors are positions, oldest first. */
function pagePositions(total: number, read: Pick<ThreadReadInput, "before" | "after" | "limit">) {
  const position = (cursor: string | undefined) => {
    if (cursor === undefined) return undefined;
    const value = Number(cursor);
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  };
  const before = position(read.before);
  const after = position(read.after);
  if (before === null || after === null) return invalidRead("Cursor is not from this thread");
  let start = Math.max(0, total - read.limit);
  let end = total;
  if (after !== undefined) {
    start = Math.min(after, total);
    end = Math.min(total, start + read.limit);
  }
  if (before !== undefined) {
    end = Math.min(before, total);
    start = Math.max(0, end - read.limit);
  }
  return Result.ok({
    start,
    end,
    cursors: {
      hasMore: start > 0,
      ...(start > 0 ? { before: String(start) } : {}),
      after: String(end),
    },
  });
}

function invalidSend(field: string, message: string) {
  return Result.err(
    new SurfaceInvalidInput({ platform: "discord", operation: "send-message", field, message }),
  );
}

/** Snowflake ids order messages exactly, even when two share a millisecond timestamp. */
function bySnowflake(a: SurfaceMessage, b: SurfaceMessage): number {
  const left = BigInt(a.ref.messageId);
  const right = BigInt(b.ref.messageId);
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function timelineItem(
  message: SurfaceMessage,
  selfUserId: string,
  maxCharsPerItem: number,
  textOffset = 0,
): ThreadTimelineItem | null {
  if (message.deleted || !message.text.trim()) return null;
  const fromSelf = message.userId === selfUserId;
  return {
    id: message.ref.messageId,
    role: fromSelf ? "assistant" : "user",
    kind: "text",
    ...boundTimelineText(message.text, maxCharsPerItem, textOffset),
    ...(!fromSelf && message.userName ? { author: message.userName } : {}),
  };
}

/**
 * Thread control for Discord. Reads use the same channel allowlist as the surface message tools,
 * because Lilac has no per-user Discord read access to check. A send from a native run posts a
 * relay message that mentions the bot, so the channel's router steers its running request or
 * starts one, as it would for that user's own mention.
 */
export function createDiscordThreadControl(input: {
  readonly adapter: SurfaceAdapter;
  readonly getConfig: () => Promise<CoreConfig>;
  readonly relay?: DiscordRelayPort;
  readonly router?: DiscordRouterView;
  readonly transcriptStore?: () => TranscriptStore | undefined;
}): SurfaceThreadControlPort {
  const { adapter, getConfig, relay } = input;

  async function resolveChannel(threadId: string) {
    const resolved = await discordTargets.resolveSession({
      selector: threadId,
      adapter,
      getConfig,
    });
    return resolved.mapError(
      (error) =>
        new SurfaceInvalidInput({
          platform: "discord",
          operation: "list-messages",
          field: "id",
          message: error.message,
        }),
    );
  }

  /** One message from its text offset, for continuing a truncated item. */
  async function readItem(
    channelId: string,
    header: Pick<ThreadReadResult, "threadId" | "title">,
    item: NonNullable<ThreadReadInput["item"]>,
    maxChars: number,
  ) {
    return Result.gen(async function* () {
      const message = yield* Result.await(
        adapter.readMsg({ platform: "discord", channelId, messageId: item.id }),
      );
      const self = yield* Result.await(selfUserId());
      const read = message && timelineItem(message, self, maxChars, item.textOffset);
      return Result.ok({ ...header, activeRunId: null, items: read ? [read] : [], hasMore: false });
    });
  }

  async function selfUserId() {
    const self = await Result.tryPromise({
      try: () => adapter.getSelf(),
      catch: (cause) =>
        new SurfaceUnavailable({
          platform: "discord",
          operation: "list-messages",
          message: `Discord identity is unavailable: ${String(cause)}`,
        }),
    });
    return self.map((value) => value.userId);
  }

  /**
   * The Lilac thread that a reply to this message continues, as that reply's agent would see it:
   * user messages with their metadata line, then each request's transcript with its tool calls.
   * Items are named `<discord message id>.<part>` after the Discord message they came from.
   */
  async function readThread(
    target: { readonly channelId: string; readonly messageId: string; readonly title: string },
    read: ThreadReadInput,
  ) {
    return Result.gen(async function* () {
      const config = await getConfig();
      const self = yield* Result.await(selfUserId());
      const segments = yield* Result.await(
        composeDiscordThreadSegments(adapter, {
          target: { platform: "discord", channelId: target.channelId, messageId: target.messageId },
          botUserId: self,
          botName: config.surface.discord.botName,
          transcriptStore: input.transcriptStore?.(),
          discordUserAliasById: buildDiscordUserAliasById(config),
        }),
      );
      if (segments.length === 0)
        return invalidRead(`No Discord message ${target.messageId} in ${target.channelId}`);
      const display = segments.flatMap((segment) =>
        subagentMessages(segment.messages).map((message) => ({
          ...message,
          id: `${segment.anchorMessageId}.${message.id}`,
        })),
      );
      const active = input.router?.activeRequest(target.channelId);
      const header = {
        threadId: `discord:${target.channelId}:${target.messageId}`,
        title: target.title,
        activeRunId:
          active && active.outputMessageIds.includes(target.messageId) ? active.requestId : null,
      };
      if (read.item) {
        const full = projectThreadTimeline(display, "activity", Number.MAX_SAFE_INTEGER);
        const items = sliceTimelineItem(full, read.item, read.maxCharsPerItem);
        return Result.ok({ ...header, items, hasMore: false });
      }
      const items = projectThreadTimeline(display, read.view, read.maxCharsPerItem);
      const page = yield* pagePositions(items.length, read);
      return Result.ok({ ...header, items: items.slice(page.start, page.end), ...page.cursors });
    });
  }

  return {
    async read(_caller, threadId, read) {
      return Result.gen(async function* () {
        const messageTarget = parseDiscordMessageTarget(threadId);
        const target = yield* Result.await(resolveChannel(messageTarget?.channelId ?? threadId));
        const { channelId } = target.sessionRef;
        const alias = target.config
          ? bestEffortAliasForDiscordChannelId({ channelId, cfg: target.config })
          : undefined;
        const header = { threadId: channelId, title: alias ? `#${alias}` : channelId };
        if (messageTarget)
          return await readThread({ ...messageTarget, channelId, title: header.title }, read);
        if (read.item) return await readItem(channelId, header, read.item, read.maxCharsPerItem);
        const messages = yield* Result.await(
          adapter.listMsg(target.sessionRef, {
            limit: read.limit,
            ...(read.before ? { beforeMessageId: read.before } : {}),
            ...(read.after ? { afterMessageId: read.after } : {}),
          }),
        );
        const self = yield* Result.await(selfUserId());
        // Discord returns pages newest first; agents read oldest first, as on native.
        const ordered = [...messages].sort(bySnowflake);
        const first = ordered[0]?.ref.messageId;
        const last = ordered.at(-1)?.ref.messageId ?? read.after;
        return Result.ok({
          ...header,
          activeRunId: input.router?.activeRequest(channelId)?.requestId ?? null,
          // Discord keeps only posted messages, so both views return the same text items.
          items: ordered.flatMap(
            (message) => timelineItem(message, self, read.maxCharsPerItem) ?? [],
          ),
          hasMore: Boolean(first && messages.length >= read.limit),
          ...(first && messages.length >= read.limit ? { before: first } : {}),
          ...(last ? { after: last } : {}),
        });
      });
    },
    async send(caller, threadId, send) {
      return Result.gen(async function* () {
        if (!relay) return unsupported("send-message", "Discord relay is not available");
        if (send.mode === "queue")
          return invalidSend(
            "mode",
            "Discord threads take steer or auto; a message cannot wait behind a Discord run",
          );
        const source = caller.source;
        if (!source)
          return Result.err(
            new SurfacePermissionDenied({
              platform: "discord",
              operation: "send-message",
              message: "Only a native run with a linked Discord account can message Discord",
            }),
          );
        const messageTarget = parseDiscordMessageTarget(threadId);
        const target = yield* Result.await(resolveChannel(messageTarget?.channelId ?? threadId));
        const { channelId } = target.sessionRef;
        const nonce = discordRelayNonce(send.commandId, {
          userId: source.userId,
          threadId: nativeThreadId(caller.sourceThreadId),
          channelId,
        });
        // A keyed retry returns what the first attempt reported, before anything below can change.
        const replayed = send.commandId ? relay.findRelayResult(nonce) : null;
        if (replayed) return Result.ok(replayed);
        const self = yield* Result.await(selfUserId());
        // A session runs one request at a time, so a steer goes to that run whichever message the
        // caller named. The router steers any steer relay into it; the relay replies to the run's
        // latest output when there is one, so Discord shows where it landed.
        const steering = send.mode === "steer" ? input.router?.activeRequest(channelId) : undefined;
        const steerOutput = steering?.outputMessageIds.at(-1);
        // Otherwise a message target continues the thread through that message, and a channel
        // target starts one.
        const replyTo =
          messageTarget && !steering
            ? yield* Result.await(
                adapter.readMsg({
                  platform: "discord",
                  channelId,
                  messageId: messageTarget.messageId,
                }),
              )
            : null;
        if (messageTarget && !steering && !replyTo)
          return invalidSend("id", `No Discord message ${messageTarget.messageId} in ${channelId}`);
        const text = formatDiscordRelayText({
          botUserId: self,
          senderMention: `<@${caller.userId}>`,
          text: send.text,
        });
        if (text.length > DISCORD_RELAY_MAX_MESSAGE_CHARS)
          return invalidSend(
            "message",
            `Discord messages hold ${DISCORD_RELAY_MAX_MESSAGE_CHARS} characters; this relay needs ${text.length}`,
          );
        const replyToMessageId = steerOutput ?? replyTo?.ref.messageId;
        const admission = input.router?.relayAdmission({
          sessionId: channelId,
          ...(replyToMessageId ? { replyToMessageId } : {}),
          replyToBot: steerOutput !== undefined || replyTo?.userId === self,
          steer: send.mode === "steer",
        }) ?? { kind: "starts", queued: false };
        const sent = yield* Result.await(
          relay.sendRelayMessage({
            channelId,
            text,
            ...(replyToMessageId ? { replyToMessageId } : {}),
            origin: {
              nonce,
              platform: source.platform,
              threadId: nativeThreadId(caller.sourceThreadId),
              userId: source.userId,
              discordUserId: caller.userId,
              mode: send.mode,
            },
          }),
        );
        const result: ThreadSendResult =
          admission.kind === "joins"
            ? { disposition: "steered", messageId: sent.messageId, runId: admission.requestId }
            : {
                disposition: admission.queued ? "queued" : "started",
                messageId: sent.messageId,
                runId: formatDiscordMessageRequestId({ channelId, messageId: sent.messageId }),
              };
        return Result.ok(relay.recordRelayResult(nonce, result));
      });
    },
    async interrupt(caller, threadId, stop) {
      return Result.gen(async function* () {
        if (!relay) return unsupported("send-message", "Discord relay is not available");
        if (!caller.source)
          return Result.err(
            new SurfacePermissionDenied({
              platform: "discord",
              operation: "send-message",
              message: "Only a native run with a linked Discord account can stop a Discord run",
            }),
          );
        const messageTarget = parseDiscordMessageTarget(threadId);
        const target = yield* Result.await(resolveChannel(messageTarget?.channelId ?? threadId));
        const { channelId } = target.sessionRef;
        // A session runs one request at a time; stopping it is the channel's Cancel button.
        const active = input.router?.activeRequest(channelId);
        if (stop.runId && stop.runId !== active?.requestId) {
          const ended: ThreadInterruptResult = { status: "ended", runId: stop.runId };
          return Result.ok(ended);
        }
        if (!active) {
          const idle: ThreadInterruptResult = { status: "idle" };
          return Result.ok(idle);
        }
        await relay.cancelRequest({
          channelId,
          requestId: active.requestId,
          discordUserId: caller.userId,
        });
        const cancelled: ThreadInterruptResult = { status: "cancelled", runId: active.requestId };
        return Result.ok(cancelled);
      });
    },
    relaySources(threadId) {
      return relay?.relaySourcesForChannel(threadId) ?? [];
    },
  };
}
