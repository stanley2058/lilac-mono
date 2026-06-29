import { buildDiscordRichTextFromContentAndEmbeds } from "./discord-embed-text";
import { normalizeDiscordRaw } from "./discord-raw-normalizer";

function joinTextBlocks(blocks: readonly string[]): string | undefined {
  const nonEmpty = blocks.map((block) => block.trim()).filter((block) => block.length > 0);
  if (nonEmpty.length === 0) return undefined;
  return nonEmpty.join("\n\n");
}

export function getDiscordSurfaceTextFromRaw(raw: unknown): string | undefined {
  const discordRaw = normalizeDiscordRaw(raw);
  if (!discordRaw) return undefined;

  if (discordRaw.forwardSnapshot) {
    const topRichText = buildDiscordRichTextFromContentAndEmbeds({
      content: discordRaw.content,
      embeds: discordRaw.embeds,
      mode: "surface",
    });

    const snapshotRichText = buildDiscordRichTextFromContentAndEmbeds({
      content: discordRaw.forwardSnapshot.content,
      embeds: discordRaw.forwardSnapshot.embeds,
      mode: "surface",
    });

    return joinTextBlocks([topRichText, snapshotRichText]);
  }

  const richText = buildDiscordRichTextFromContentAndEmbeds({
    content: discordRaw.content,
    embeds: discordRaw.embeds,
    mode: "surface",
  });

  return richText.length > 0 ? richText : undefined;
}

export function getDiscordSurfaceDisplayText(input: {
  raw?: unknown;
  fallbackText?: string;
}): string {
  if (typeof input.fallbackText === "string" && input.fallbackText.length > 0) {
    return input.fallbackText;
  }

  return getDiscordSurfaceTextFromRaw(input.raw) ?? input.fallbackText ?? "";
}
