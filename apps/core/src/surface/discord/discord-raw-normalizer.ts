import { z } from "zod";

import type { DiscordAttachmentMeta } from "./discord-attachment";
import type { DiscordRelayRaw } from "./discord-relay";

import { normalizeDiscordEmbeds, type DiscordEmbedTextMeta } from "./discord-embed-text";

export const DISCORD_REFERENCE_TYPE_DEFAULT = 0;
export const DISCORD_REFERENCE_TYPE_FORWARD = 1;

export type NormalizedDiscordReference = {
  messageId?: string;
  channelId?: string;
  guildId?: string;
  type?: number;
};

export type NormalizedDiscordForwardSnapshot = {
  content: string;
  embeds: DiscordEmbedTextMeta[];
  attachments: DiscordAttachmentMeta[];
  raw: Record<string, unknown>;
};

export type NormalizedDiscordRaw = {
  content?: string;
  isChat?: boolean;
  embeds: DiscordEmbedTextMeta[];
  attachments: DiscordAttachmentMeta[];
  reference?: NormalizedDiscordReference;
  referenceType: number;
  replyReference?: {
    messageId: string;
    channelId?: string;
    guildId?: string;
  };
  forwardSnapshot?: NormalizedDiscordForwardSnapshot;
  /** Set by the adapter only for a bot message that has a Core relay record. */
  relay?: DiscordRelayRaw;
};

const recordSchema = z.record(z.string(), z.unknown());
const maybeStringSchema = z.union([z.string().min(1), z.unknown().transform(() => undefined)]);
const maybeFiniteNumberSchema = z.union([z.number(), z.unknown().transform(() => undefined)]);
const discordReferenceSchema = z
  .object({
    messageId: maybeStringSchema,
    channelId: maybeStringSchema,
    guildId: maybeStringSchema,
    type: maybeFiniteNumberSchema,
  })
  .loose();
const discordAttachmentSchema = z
  .object({
    id: maybeStringSchema,
    url: z.string().min(1),
    filename: maybeStringSchema,
    name: maybeStringSchema,
    mimeType: maybeStringSchema,
    contentType: maybeStringSchema,
    size: maybeFiniteNumberSchema,
  })
  .loose();
const discordEnvelopeSchema = z
  .object({
    content: maybeStringSchema,
    isChat: z.boolean().optional(),
    embeds: z.unknown().optional(),
    attachments: z.unknown().optional(),
    referenceType: maybeFiniteNumberSchema,
    replyToMessageId: maybeStringSchema,
    replyToChannelId: maybeStringSchema,
    guildId: maybeStringSchema,
    messageSnapshots: z.unknown().optional(),
    relay: z.unknown().optional(),
  })
  .loose();
const discordRelaySchema = z.object({
  nonce: z.string().min(1),
  platform: z.literal("native"),
  threadId: z.string().min(1),
  userId: z.string().min(1),
  discordUserId: z.string().min(1),
  mode: z.enum(["steer", "auto"]),
  botUserId: z.string().min(1),
  botName: z.string(),
});
const discordRawSchema = z
  .object({
    content: maybeStringSchema,
    embeds: z.unknown().optional(),
    attachments: z.unknown().optional(),
    reference: z.unknown().optional(),
    messageSnapshots: z.unknown().optional(),
    discord: z.unknown().optional(),
  })
  .loose();

function normalizeReference(
  reference: z.infer<typeof discordReferenceSchema> | undefined,
): NormalizedDiscordReference | undefined {
  if (!reference) return undefined;

  const out: NormalizedDiscordReference = {};
  if (reference.messageId) out.messageId = reference.messageId;
  if (reference.channelId) out.channelId = reference.channelId;
  if (reference.guildId) out.guildId = reference.guildId;
  if (reference.type !== undefined) out.type = reference.type;

  return Object.keys(out).length > 0 ? out : undefined;
}

export function normalizeDiscordRaw(raw: unknown): NormalizedDiscordRaw | null {
  function parseRecord(value: unknown): Record<string, unknown> | null {
    const parsedRecord = recordSchema.safeParse(value);
    return parsedRecord.success ? parsedRecord.data : null;
  }

  function normalizeDiscordAttachment(input: unknown): DiscordAttachmentMeta | null {
    const parsedAttachment = discordAttachmentSchema.safeParse(input);
    if (!parsedAttachment.success) return null;

    const attachment = parsedAttachment.data;
    const filename = attachment.filename ?? attachment.name;
    const mimeType = attachment.mimeType ?? attachment.contentType;

    return {
      ...(attachment.id ? { id: attachment.id } : {}),
      url: attachment.url,
      ...(filename ? { filename } : {}),
      ...(mimeType ? { mimeType } : {}),
      ...(attachment.size !== undefined ? { size: attachment.size } : {}),
    };
  }

  function normalizeDiscordAttachments(input: unknown): DiscordAttachmentMeta[] {
    if (!Array.isArray(input)) return [];

    const out: DiscordAttachmentMeta[] = [];
    for (const item of input) {
      const attachment = normalizeDiscordAttachment(item);
      if (attachment) out.push(attachment);
    }
    return out;
  }

  function firstForwardSnapshotMessage(input: unknown): Record<string, unknown> | null {
    if (!Array.isArray(input) || input.length === 0) return null;

    const first = parseRecord(input[0]);
    if (!first) return null;

    const nestedMessage = parseRecord(first.message);
    return nestedMessage ?? first;
  }

  const parsed = discordRawSchema.safeParse(raw);
  if (!parsed.success) return null;

  const top = parsed.data;
  const parsedDiscord = discordEnvelopeSchema.safeParse(top.discord);
  const discord = parsedDiscord.success ? parsedDiscord.data : undefined;
  const parsedReference = discordReferenceSchema.safeParse(top.reference);
  const reference = parsedReference.success ? normalizeReference(parsedReference.data) : undefined;
  const referenceType = reference?.type ?? discord?.referenceType ?? DISCORD_REFERENCE_TYPE_DEFAULT;
  const topAttachments = normalizeDiscordAttachments(top.attachments);
  const discordAttachments = normalizeDiscordAttachments(discord?.attachments);
  const topEmbeds = normalizeDiscordEmbeds(top.embeds);
  const discordEmbeds = normalizeDiscordEmbeds(discord?.embeds);
  const content = top.content ?? discord?.content;
  const parsedRelay = discordRelaySchema.safeParse(discord?.relay);
  const relay = parsedRelay.success ? parsedRelay.data : undefined;

  const snapshotRaw =
    referenceType === DISCORD_REFERENCE_TYPE_FORWARD
      ? (firstForwardSnapshotMessage(top.messageSnapshots) ??
        firstForwardSnapshotMessage(discord?.messageSnapshots))
      : null;
  const snapshot =
    snapshotRaw !== null
      ? {
          content: typeof snapshotRaw.content === "string" ? snapshotRaw.content : "",
          embeds: normalizeDiscordEmbeds(snapshotRaw.embeds),
          attachments: normalizeDiscordAttachments(snapshotRaw.attachments),
          raw: snapshotRaw,
        }
      : undefined;

  const replyToMessageId =
    referenceType !== DISCORD_REFERENCE_TYPE_FORWARD
      ? (reference?.messageId ?? discord?.replyToMessageId)
      : undefined;
  const replyToChannelId = reference?.channelId ?? discord?.replyToChannelId;
  const replyToGuildId = reference?.guildId ?? discord?.guildId;

  return {
    ...(content !== undefined ? { content } : {}),
    ...(discord?.isChat !== undefined ? { isChat: discord.isChat } : {}),
    embeds: topEmbeds.length > 0 ? topEmbeds : discordEmbeds,
    attachments: discordAttachments.length > 0 ? discordAttachments : topAttachments,
    ...(reference ? { reference } : {}),
    referenceType,
    ...(replyToMessageId
      ? {
          replyReference: {
            messageId: replyToMessageId,
            ...(replyToChannelId ? { channelId: replyToChannelId } : {}),
            ...(replyToGuildId ? { guildId: replyToGuildId } : {}),
          },
        }
      : {}),
    ...(snapshot ? { forwardSnapshot: snapshot } : {}),
    ...(relay ? { relay } : {}),
  };
}
