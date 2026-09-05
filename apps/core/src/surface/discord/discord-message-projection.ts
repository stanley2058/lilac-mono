import { z } from "zod";

import type { SurfaceMessage } from "../types";
import { selectVisibleDiscordAttachments } from "./discord-attachment";
import { buildDiscordRichTextFromContentAndEmbeds } from "./discord-embed-text";
import { normalizeDiscordRaw } from "./discord-raw-normalizer";
import { getDiscordSurfaceText } from "./discord-surface-display-text";

const discordMessageTypeMetaSchema = z.object({
  discord: z.object({
    type: z.number().finite().optional(),
    typeName: z.string().optional(),
    system: z.boolean().optional(),
    isChat: z.boolean().optional(),
  }),
});

function getDiscordMessageTypeMetaFromRaw(raw: unknown): {
  typeId?: number;
  typeName?: string;
  isSystem?: boolean;
  isChat?: boolean;
} | null {
  const decoded = discordMessageTypeMetaSchema.safeParse(raw);
  if (!decoded.success) return null;
  const discord = decoded.data.discord;
  const typeId = discord.type;
  const typeName = discord.typeName;
  const isSystem = discord.system;
  const isChat = discord.isChat;

  if (
    typeId === undefined &&
    typeName === undefined &&
    isSystem === undefined &&
    isChat === undefined
  ) {
    return null;
  }

  return { typeId, typeName, isSystem, isChat };
}

export function getDiscordMessageKind(meta: {
  isSystem?: boolean;
  isChat?: boolean;
}): "chat" | "system" | "unknown" {
  if (meta.isChat === true) return "chat";
  if (meta.isSystem === true) return "system";
  return "unknown";
}

export function getForwardSnapshotTextFromRaw(raw: unknown): string | undefined {
  return projectDiscordMessage({ raw, text: "" }).forwardSnapshotText;
}

export function projectDiscordMessage(message: Pick<SurfaceMessage, "raw" | "text">) {
  const normalized = normalizeDiscordRaw(message.raw);
  const snapshot = normalized?.forwardSnapshot;
  const snapshotText = snapshot
    ? buildDiscordRichTextFromContentAndEmbeds({
        content: snapshot.content,
        embeds: snapshot.embeds,
        mode: "inbound",
      })
    : "";
  const reference = normalized?.replyReference ?? normalized?.reference;
  return {
    attachments: selectVisibleDiscordAttachments(normalized),
    replyReference: normalized?.replyReference,
    reference:
      reference && normalized ? { ...reference, type: normalized.referenceType } : undefined,
    isChat: normalized?.isChat,
    typeMeta: getDiscordMessageTypeMetaFromRaw(message.raw),
    forwardSnapshotText: snapshotText.length > 0 ? snapshotText : undefined,
    displayText:
      message.text.length > 0 ? message.text : (getDiscordSurfaceText(normalized) ?? message.text),
  };
}
