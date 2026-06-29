import { z } from "zod";

import type { DiscordAttachmentMeta } from "../bridge/request-composition/types";

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
};

const recordSchema = z.record(z.string(), z.unknown());
const maybeStringSchema = z.preprocess(
  (value) => (typeof value === "string" && value.length > 0 ? value : undefined),
  z.string().optional(),
);
const maybeFiniteNumberSchema = z.preprocess(
  (value) => (typeof value === "number" && Number.isFinite(value) ? value : undefined),
  z.number().optional(),
);
const discordReferenceSchema = z
  .object({
    messageId: maybeStringSchema,
    channelId: maybeStringSchema,
    guildId: maybeStringSchema,
    type: maybeFiniteNumberSchema,
  })
  .passthrough();
const discordAttachmentSchema = z
  .object({
    url: z.string().min(1),
    filename: maybeStringSchema,
    name: maybeStringSchema,
    mimeType: maybeStringSchema,
    contentType: maybeStringSchema,
    size: maybeFiniteNumberSchema,
  })
  .passthrough();
const discordEnvelopeSchema = z
  .object({
    content: maybeStringSchema,
    embeds: z.unknown().optional(),
    attachments: z.unknown().optional(),
    referenceType: maybeFiniteNumberSchema,
    replyToMessageId: maybeStringSchema,
    replyToChannelId: maybeStringSchema,
    guildId: maybeStringSchema,
    messageSnapshots: z.unknown().optional(),
  })
  .passthrough();
const discordRawSchema = z
  .object({
    content: maybeStringSchema,
    embeds: z.unknown().optional(),
    attachments: z.unknown().optional(),
    reference: discordReferenceSchema.optional(),
    messageSnapshots: z.unknown().optional(),
    discord: discordEnvelopeSchema.optional(),
  })
  .passthrough();

function parseRecord(value: unknown): Record<string, unknown> | null {
  const parsed = recordSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function normalizeDiscordAttachment(input: unknown): DiscordAttachmentMeta | null {
  const parsed = discordAttachmentSchema.safeParse(input);
  if (!parsed.success) return null;

  const attachment = parsed.data;
  const filename = attachment.filename ?? attachment.name;
  const mimeType = attachment.mimeType ?? attachment.contentType;

  return {
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
  const parsed = discordRawSchema.safeParse(raw);
  if (!parsed.success) return null;

  const top = parsed.data;
  const discord = top.discord;
  const reference = normalizeReference(top.reference);
  const referenceType = reference?.type ?? discord?.referenceType ?? DISCORD_REFERENCE_TYPE_DEFAULT;
  const topAttachments = normalizeDiscordAttachments(top.attachments);
  const discordAttachments = normalizeDiscordAttachments(discord?.attachments);
  const topEmbeds = normalizeDiscordEmbeds(top.embeds);
  const discordEmbeds = normalizeDiscordEmbeds(discord?.embeds);
  const content = top.content ?? discord?.content;

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
  };
}
