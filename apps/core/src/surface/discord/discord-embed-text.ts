export type DiscordEmbedTextMode = "inbound" | "surface";

export type DiscordEmbedTextField = {
  name?: string;
  value?: string;
};

export type DiscordEmbedTextMeta = {
  title?: string;
  description?: string;
  fields?: DiscordEmbedTextField[];
  imageUrl?: string;
  footer?: string;
};

function asNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  return value.trim().length > 0 ? value : undefined;
}

function normalizeDiscordEmbedFields(input: unknown): DiscordEmbedTextField[] {
  if (!Array.isArray(input)) return [];

  const out: DiscordEmbedTextField[] = [];

  for (const item of input) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const name = asNonEmptyString(o.name);
    const value = asNonEmptyString(o.value);
    if (!name && !value) continue;
    out.push({ ...(name ? { name } : {}), ...(value ? { value } : {}) });
  }

  return out;
}

function normalizeDiscordEmbed(input: unknown): DiscordEmbedTextMeta | null {
  if (typeof input === "string") {
    const description = asNonEmptyString(input);
    return description ? { description } : null;
  }

  if (!input || typeof input !== "object") return null;
  const o = input as Record<string, unknown>;

  const title = asNonEmptyString(o.title);
  const description = asNonEmptyString(o.description);
  const fields = normalizeDiscordEmbedFields(o.fields);

  const imageObj =
    o.image && typeof o.image === "object" ? (o.image as Record<string, unknown>) : undefined;
  const imageUrl = asNonEmptyString(imageObj?.url);

  const footerObj =
    o.footer && typeof o.footer === "object" ? (o.footer as Record<string, unknown>) : undefined;
  const footer = asNonEmptyString(footerObj?.text);

  if (!title && !description && fields.length === 0 && !imageUrl && !footer) {
    return null;
  }

  return {
    ...(title ? { title } : {}),
    ...(description ? { description } : {}),
    ...(fields.length > 0 ? { fields } : {}),
    ...(imageUrl ? { imageUrl } : {}),
    ...(footer ? { footer } : {}),
  };
}

export function normalizeDiscordEmbeds(input: unknown): DiscordEmbedTextMeta[] {
  if (!Array.isArray(input)) return [];

  const out: DiscordEmbedTextMeta[] = [];

  for (const item of input) {
    const normalized = normalizeDiscordEmbed(item);
    if (normalized) out.push(normalized);
  }

  return out;
}

function formatEmbedFields(fields: readonly DiscordEmbedTextField[]): string | undefined {
  const lines = fields
    .map((field) => {
      const name = field.name ?? "";
      const value = field.value ?? "";
      const hasName = name.trim().length > 0;
      const hasValue = value.trim().length > 0;

      if (hasName && hasValue) return `${name}: ${value}`;
      if (hasValue) return value;
      if (hasName) return name;
      return "";
    })
    .filter((line) => line.length > 0);

  if (lines.length === 0) return undefined;
  return lines.join("\n");
}

export function buildDiscordRichTextFromContentAndEmbeds(params: {
  content?: string;
  embeds?: readonly DiscordEmbedTextMeta[];
  mode: DiscordEmbedTextMode;
}): string {
  const blocks: string[] = [];

  const content = asNonEmptyString(params.content);
  if (content) blocks.push(content);

  for (const embed of params.embeds ?? []) {
    const title = asNonEmptyString(embed.title);
    const description = asNonEmptyString(embed.description);
    const imageUrl = asNonEmptyString(embed.imageUrl);
    const footer = asNonEmptyString(embed.footer);

    if (title) blocks.push(title);
    if (description) blocks.push(description);

    if (params.mode === "surface") {
      const fields = formatEmbedFields(embed.fields ?? []);
      if (fields) blocks.push(fields);
    }

    if (imageUrl) blocks.push(imageUrl);

    if (params.mode === "surface" && footer) {
      blocks.push(footer);
    }
  }

  return blocks.join("\n\n");
}

export function buildDiscordModelContextTextFromContentAndEmbeds(params: {
  content?: string;
  embeds?: readonly DiscordEmbedTextMeta[];
}): string {
  const blocks: string[] = [];

  const content = asNonEmptyString(params.content);
  if (content) blocks.push(content);

  for (const embed of params.embeds ?? []) {
    const embedBlocks = ["[discord_embed]"];

    const title = asNonEmptyString(embed.title);
    const description = asNonEmptyString(embed.description);
    const imageUrl = asNonEmptyString(embed.imageUrl);

    if (title) embedBlocks.push(title);
    if (description) embedBlocks.push(description);
    if (imageUrl) embedBlocks.push(imageUrl);

    blocks.push(embedBlocks.join("\n\n"));
  }

  return blocks.join("\n\n");
}
