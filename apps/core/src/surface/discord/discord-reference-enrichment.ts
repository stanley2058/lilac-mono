import { Result, type Result as ResultType } from "better-result";

import type { SurfaceAdapter } from "../adapter";
import type { SurfaceMessage } from "../types";
import { projectDiscordMessage } from "./discord-message-projection";
import {
  DISCORD_REFERENCE_TYPE_DEFAULT,
  DISCORD_REFERENCE_TYPE_FORWARD,
} from "./discord-raw-normalizer";

export function surfaceMessageKey(msg: SurfaceMessage): string {
  return `${msg.ref.channelId}:${msg.ref.messageId}`;
}

function isDiscordThreadStarterMessage(
  meta: { typeId?: number; typeName?: string } | null,
): boolean {
  return meta?.typeId === 21 || meta?.typeName === "ThreadStarterMessage";
}

export async function resolveDiscordReferencedMessage<E>(input: {
  adapter: SurfaceAdapter;
  allowChannel: (input: { channelId: string; guildId?: string }) => ResultType<boolean, E>;
  message: SurfaceMessage;
  alreadyFetchedByKey?: Map<string, SurfaceMessage>;
  fetchedReferenceByKey?: Map<string, Promise<SurfaceMessage | null>>;
}): Promise<ResultType<SurfaceMessage | null, E>> {
  return Result.gen(async function* () {
    const msg = input.message;
    if (msg.session.platform !== "discord") return Result.ok(null);

    const projection = projectDiscordMessage(msg);
    const ref = projection.reference;
    if (!ref?.messageId) return Result.ok(null);

    const referenceType = ref.type ?? DISCORD_REFERENCE_TYPE_DEFAULT;
    if (referenceType === DISCORD_REFERENCE_TYPE_FORWARD) return Result.ok(null);

    const meta = projection.typeMeta;
    const refChannelId = ref.channelId ?? msg.session.channelId;
    const isSameSession = refChannelId === msg.session.channelId;
    const isThreadStarterParentReference =
      isDiscordThreadStarterMessage(meta) &&
      typeof msg.session.parentChannelId === "string" &&
      refChannelId === msg.session.parentChannelId;

    if (!isSameSession && !isThreadStarterParentReference) return Result.ok(null);

    const targetAllowed = yield* input.allowChannel({
      channelId: refChannelId,
      guildId: ref.guildId ?? msg.session.guildId,
    });
    if (!targetAllowed) return Result.ok(null);

    const targetKey = `${refChannelId}:${ref.messageId}`;
    const alreadyFetched = input.alreadyFetchedByKey?.get(targetKey);
    if (alreadyFetched) return Result.ok(alreadyFetched);

    let referencedPromise = input.fetchedReferenceByKey?.get(targetKey);
    if (!referencedPromise) {
      referencedPromise = input.adapter
        .readMsg({
          platform: "discord",
          channelId: refChannelId,
          messageId: ref.messageId,
        })
        .then((result) => result.match({ ok: (value) => value, err: () => null }));
      input.fetchedReferenceByKey?.set(targetKey, referencedPromise);
    }

    const referenced = await referencedPromise;
    if (!referenced || referenced.session.platform !== "discord") return Result.ok(null);

    const referencedAllowed = yield* input.allowChannel({
      channelId: referenced.session.channelId,
      guildId: referenced.session.guildId,
    });
    return Result.ok(referencedAllowed ? referenced : null);
  });
}

async function mapWithConcurrency<T, R>(input: {
  items: readonly T[];
  concurrency: number;
  run: (item: T, index: number) => Promise<R>;
}): Promise<R[]> {
  const concurrency = Math.max(1, Math.floor(input.concurrency));
  const out = Array.from({ length: input.items.length }) as R[];
  let nextIndex = 0;

  const workers = Array.from({ length: Math.min(concurrency, input.items.length) }, async () => {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= input.items.length) return;
      out[index] = await input.run(input.items[index]!, index);
    }
  });

  await Promise.all(workers);
  return out;
}

export async function resolveDiscordReferencedMessages<E>(input: {
  adapter: SurfaceAdapter;
  allowChannel: (input: { channelId: string; guildId?: string }) => ResultType<boolean, E>;
  messages: readonly SurfaceMessage[];
}): Promise<ResultType<Map<string, SurfaceMessage>, E>> {
  const out = new Map<string, SurfaceMessage>();
  const alreadyFetchedByKey = new Map<string, SurfaceMessage>();
  const fetchedReferenceByKey = new Map<string, Promise<SurfaceMessage | null>>();

  for (const message of input.messages) {
    alreadyFetchedByKey.set(surfaceMessageKey(message), message);
  }

  const resolved = await mapWithConcurrency({
    items: input.messages,
    concurrency: 8,
    run: async (message) => {
      return (
        await resolveDiscordReferencedMessage({
          adapter: input.adapter,
          allowChannel: input.allowChannel,
          message,
          alreadyFetchedByKey,
          fetchedReferenceByKey,
        })
      ).map((referenced) => {
        if (referenced) out.set(surfaceMessageKey(message), referenced);
      });
    },
  });

  return Result.all(resolved).map(() => out);
}
