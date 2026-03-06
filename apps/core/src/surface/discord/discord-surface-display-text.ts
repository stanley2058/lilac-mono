import {
  buildDiscordRichTextFromContentAndEmbeds,
  normalizeDiscordEmbeds,
} from "./discord-embed-text";

const DISCORD_REFERENCE_TYPE_DEFAULT = 0;
const DISCORD_REFERENCE_TYPE_FORWARD = 1;

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object") return null;
  return value as Record<string, unknown>;
}

function joinTextBlocks(blocks: readonly string[]): string | undefined {
  const nonEmpty = blocks.map((block) => block.trim()).filter((block) => block.length > 0);
  if (nonEmpty.length === 0) return undefined;
  return nonEmpty.join("\n\n");
}

function getDiscordReferenceTypeFromRaw(raw: unknown): number | undefined {
  const o = asRecord(raw);
  if (!o) return undefined;

  const reference = asRecord(o.reference);
  if (typeof reference?.type === "number") {
    return reference.type;
  }

  const discord = asRecord(o.discord);
  return typeof discord?.referenceType === "number" ? discord.referenceType : undefined;
}

function getForwardSnapshotMessageFromRaw(raw: unknown): Record<string, unknown> | null {
  const o = asRecord(raw);
  if (!o) return null;

  const referenceType = getDiscordReferenceTypeFromRaw(raw) ?? DISCORD_REFERENCE_TYPE_DEFAULT;
  if (referenceType !== DISCORD_REFERENCE_TYPE_FORWARD) return null;

  const discord = asRecord(o.discord);

  const resolveSnapshotMessage = (value: unknown): Record<string, unknown> | null => {
    if (!Array.isArray(value) || value.length === 0) return null;
    const first = value[0];
    if (!first || typeof first !== "object") return null;

    const firstObj = first as Record<string, unknown>;
    const nestedMessage = firstObj.message;
    if (nestedMessage && typeof nestedMessage === "object") {
      return nestedMessage as Record<string, unknown>;
    }

    return firstObj;
  };

  return (
    resolveSnapshotMessage(o.messageSnapshots) ?? resolveSnapshotMessage(discord?.messageSnapshots)
  );
}

export function getDiscordSurfaceTextFromRaw(raw: unknown): string | undefined {
  const top = asRecord(raw);
  if (!top) return undefined;

  const forwardSnapshot = getForwardSnapshotMessageFromRaw(raw);
  const topContent = typeof top.content === "string" ? top.content : undefined;
  const topEmbeds = normalizeDiscordEmbeds(top.embeds);

  const snapshotContent =
    forwardSnapshot && typeof forwardSnapshot.content === "string"
      ? forwardSnapshot.content
      : undefined;
  const snapshotEmbeds = normalizeDiscordEmbeds(forwardSnapshot?.embeds);

  const topDiscord = asRecord(top.discord);
  const fallbackContent = typeof topDiscord?.content === "string" ? topDiscord.content : undefined;
  const fallbackEmbeds = normalizeDiscordEmbeds(topDiscord?.embeds);

  if (forwardSnapshot) {
    const topRichText = buildDiscordRichTextFromContentAndEmbeds({
      content: topContent ?? fallbackContent,
      embeds: topEmbeds.length > 0 ? topEmbeds : fallbackEmbeds,
      mode: "surface",
    });

    const snapshotRichText = buildDiscordRichTextFromContentAndEmbeds({
      content: snapshotContent,
      embeds: snapshotEmbeds,
      mode: "surface",
    });

    return joinTextBlocks([topRichText, snapshotRichText]);
  }

  const richText = buildDiscordRichTextFromContentAndEmbeds({
    content: topContent ?? fallbackContent,
    embeds: topEmbeds.length > 0 ? topEmbeds : fallbackEmbeds,
    mode: "surface",
  });

  return richText.length > 0 ? richText : undefined;
}

export function getDiscordSurfaceDisplayText(input: {
  raw?: unknown;
  fallbackText?: string;
}): string {
  return getDiscordSurfaceTextFromRaw(input.raw) ?? input.fallbackText ?? "";
}
