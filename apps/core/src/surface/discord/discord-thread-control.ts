import type { CoreConfig } from "@stanley2058/lilac-utils";
import { Result } from "better-result";

import {
  SurfaceInvalidInput,
  SurfaceOperationUnsupported,
  SurfaceUnavailable,
  type SurfaceAdapter,
  type SurfaceOperation,
} from "../adapter";
import {
  boundTimelineText,
  type SurfaceThreadControlPort,
  type ThreadTimelineItem,
} from "../thread-control";
import type { SurfaceToolTargetRouting } from "../protocol";
import type { SurfaceMessage } from "../types";
import {
  bestEffortAliasForDiscordChannelId,
  discordToolTargetRouting,
} from "./discord-tool-targets";

const discordTargets: SurfaceToolTargetRouting<"discord"> = discordToolTargetRouting;

function unsupported(operation: SurfaceOperation) {
  return Result.err(
    new SurfaceOperationUnsupported({
      platform: "discord",
      operation,
      message: "Agents can read Discord channels but cannot message or stop them",
    }),
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
): ThreadTimelineItem | null {
  if (message.deleted || !message.text.trim()) return null;
  const fromSelf = message.userId === selfUserId;
  return {
    id: message.ref.messageId,
    role: fromSelf ? "assistant" : "user",
    kind: "text",
    ...boundTimelineText(message.text, maxCharsPerItem),
    ...(!fromSelf && message.userName ? { author: message.userName } : {}),
  };
}

/**
 * Read-only thread control for Discord. Reads use the same channel allowlist as the surface
 * message tools, because Lilac has no per-user Discord read access to check.
 */
export function createDiscordThreadControl(input: {
  readonly adapter: SurfaceAdapter;
  readonly getConfig: () => Promise<CoreConfig>;
}): SurfaceThreadControlPort {
  const { adapter, getConfig } = input;

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

  return {
    async read(_caller, threadId, read) {
      return Result.gen(async function* () {
        const target = yield* Result.await(resolveChannel(threadId));
        const { channelId } = target.sessionRef;
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
        const alias = target.config
          ? bestEffortAliasForDiscordChannelId({ channelId, cfg: target.config })
          : undefined;
        return Result.ok({
          threadId: channelId,
          title: alias ? `#${alias}` : channelId,
          activeRunId: null,
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
    async send() {
      return unsupported("send-message");
    },
    async interrupt() {
      return unsupported("send-message");
    },
  };
}
