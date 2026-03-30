import type { ModelMessage } from "ai";

export const SURFACE_METADATA_VERSION = 1;
export const SURFACE_METADATA_OPEN_TAG = `<LILAC_META:v${SURFACE_METADATA_VERSION}>`;
export const SURFACE_METADATA_CLOSE_TAG = `</LILAC_META:v${SURFACE_METADATA_VERSION}>`;

const SURFACE_METADATA_TAG_RE = /<\/?LILAC_META:v\d+>/gu;
const SURFACE_METADATA_LINE_RE = /^<LILAC_META:v\d+>.*<\/LILAC_META:v\d+>$/u;
const SURFACE_METADATA_LINE_GLOBAL_RE = /(^|\n)<LILAC_META:v\d+>.*<\/LILAC_META:v\d+>\n?/gu;

type SurfaceMetadataValue =
  | string
  | number
  | boolean
  | null
  | readonly SurfaceMetadataValue[]
  | { readonly [key: string]: SurfaceMetadataValue | undefined };

function sanitizeSurfaceMetadataValue(value: SurfaceMetadataValue): SurfaceMetadataValue {
  if (typeof value === "string") {
    return escapeSurfaceMetadataTags(value);
  }

  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeSurfaceMetadataValue(entry));
  }

  if (value && typeof value === "object") {
    const out: Record<string, SurfaceMetadataValue> = {};
    for (const [key, entry] of Object.entries(value)) {
      if (entry === undefined) continue;
      out[key] = sanitizeSurfaceMetadataValue(entry);
    }
    return out;
  }

  return value;
}

function getFirstLine(text: string): string {
  const newlineIndex = text.indexOf("\n");
  return newlineIndex >= 0 ? text.slice(0, newlineIndex) : text;
}

function extractLeadingTextContent(content: ModelMessage["content"]): string | null {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;

  for (const part of content) {
    if (!part || typeof part !== "object") continue;

    const candidate = part as Record<string, unknown>;
    if (typeof candidate.text === "string") {
      return candidate.text;
    }

    if (candidate.type === "text" && typeof candidate.value === "string") {
      return candidate.value;
    }
  }

  return null;
}

export function escapeSurfaceMetadataTags(text: string): string {
  return text.replace(SURFACE_METADATA_TAG_RE, (match) => `&lt;${match.slice(1)}`);
}

export function formatSurfaceMetadataLine(meta: {
  readonly [key: string]: SurfaceMetadataValue | undefined;
}): string {
  const safeMeta = sanitizeSurfaceMetadataValue(meta);
  return `${SURFACE_METADATA_OPEN_TAG}${JSON.stringify(safeMeta)}${SURFACE_METADATA_CLOSE_TAG}`;
}

export function hasLeadingSurfaceMetadataLine(text: string): boolean {
  return SURFACE_METADATA_LINE_RE.test(getFirstLine(text));
}

export function stripLeadingSurfaceMetadataLine(text: string): string {
  if (!hasLeadingSurfaceMetadataLine(text)) return text;

  const newlineIndex = text.indexOf("\n");
  if (newlineIndex < 0) return "";
  return text.slice(newlineIndex + 1);
}

export function stripSurfaceMetadataLines(text: string): string {
  return text.replace(SURFACE_METADATA_LINE_GLOBAL_RE, "$1");
}

export function messagesContainSurfaceMetadata(messages: readonly ModelMessage[]): boolean {
  return messages.some((message) => {
    if (message.role !== "user") return false;
    const text = extractLeadingTextContent(message.content);
    return typeof text === "string" && hasLeadingSurfaceMetadataLine(text);
  });
}
