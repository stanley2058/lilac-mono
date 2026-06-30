import {
  generateText,
  isStepCount,
  type ModelMessage,
  type ToolSet,
  type UserContent,
  type UserModelMessage,
} from "ai";
import { z } from "zod";
import { fileTypeFromBlob, fileTypeFromBuffer } from "file-type";
import { google, type GoogleLanguageModelOptions } from "@ai-sdk/google";
import { createLogger, providers, type CoreConfig } from "@stanley2058/lilac-utils";
import { extname } from "node:path";

import type { ServerTool } from "../types";
import { zodObjectToCliLines } from "./zod-cli";

const V2_CONTENT_INSPECT_DEFAULT_MODEL = "google/gemini-3.5-flash";

type ContentInspectOptions = {
  getConfig?: () => Promise<CoreConfig>;
};

const logger = createLogger({
  module: "tool-server:content.inspect",
});

const CONTENT_INSPECT_INSTRUCTIONS = [
  "You are a forensic content summarizer. Your job is fidelity, not helpfulness.",
  "",
  "RULES (non-negotiable):",
  "1) Do NOT add information not directly present in the provided source.",
  "2) Separate OBSERVATIONS from SUMMARY. OBSERVATIONS must be literal and verifiable.",
  "3) If something is unclear, say so. Never guess. Use: UNREADABLE / PARTIALLY READABLE / NOT PRESENT.",
  "4) For images: transcribe all visible text verbatim (preserve line breaks when possible).",
  "5) Do not infer app/platform/filetype unless explicitly shown in the source.",
  "",
  "OUTPUT FORMAT (use exactly):",
  "OBSERVATIONS:",
  "- Modality: (text/image/mixed)",
  "- Verbatim text: (if any; else NOT PRESENT)",
  "- Visible UI/scene elements: (only what is clearly visible)",
  "- Uncertainty notes: (what you cannot read/confirm)",
  "",
  "SUMMARY:",
  "(2-5 sentences; must be fully supported by OBSERVATIONS; no new entities)",
].join("\n");

const TEXT_EXTENSION_MEDIA_TYPES: Readonly<Record<string, string>> = {
  ".cjs": "text/javascript",
  ".conf": "text/plain",
  ".css": "text/css",
  ".csv": "text/csv",
  ".cts": "text/typescript",
  ".env": "text/plain",
  ".htm": "text/html",
  ".html": "text/html",
  ".js": "text/javascript",
  ".json": "application/json",
  ".jsonc": "application/json",
  ".jsx": "text/javascript",
  ".log": "text/plain",
  ".md": "text/markdown",
  ".mdx": "text/markdown",
  ".mjs": "text/javascript",
  ".mts": "text/typescript",
  ".sql": "application/sql",
  ".svg": "image/svg+xml",
  ".toml": "application/toml",
  ".ts": "text/typescript",
  ".tsx": "text/typescript",
  ".txt": "text/plain",
  ".xml": "application/xml",
  ".yaml": "application/yaml",
  ".yml": "application/yaml",
};

export type LoadedInspectSource =
  | {
      kind: "text";
      text: string;
      mediaType: string;
      charset?: string;
      source: string;
    }
  | {
      kind: "file";
      data: Uint8Array | URL;
      mediaType: string;
      source: string;
    };

export class ContentInspect implements ServerTool {
  id = "content.inspect";

  constructor(private readonly options: ContentInspectOptions = {}) {}

  init(): Promise<void> {
    return Promise.resolve();
  }

  destroy(): Promise<void> {
    return Promise.resolve();
  }

  async list() {
    return [
      {
        callableId: "content.inspect",
        name: "Inspect Content",
        description:
          "Inspect, transcribe, and summarize text, URLs, files, images, and videos using Gemini AI. Use --help to see all options.",
        shortInput: ["--text=<string> OR --url=<string> OR --path=<string> OR --base64=<base64>"],
        primaryPositional: {
          field: "text",
        },
        input: zodObjectToCliLines(contentInspectInputSchema),
      },
    ];
  }

  async call(
    callableId: string,
    input: Record<string, unknown>,
    opts?: {
      signal?: AbortSignal;
      context?: unknown;
      messages?: readonly unknown[];
    },
  ): Promise<unknown> {
    if (callableId !== "content.inspect") throw new Error("Invalid callable ID");

    const payload = contentInspectInputSchema.parse(input);
    try {
      const model = await resolveContentInspectModel(this.options.getConfig);
      const text = await inspectContent(payload, { abortSignal: opts?.signal, model });
      return {
        isError: false,
        text,
      } as const;
    } catch (e) {
      return {
        isError: true,
        error: e instanceof Error ? e.message : String(e),
      } as const;
    }
  }
}

// Hard limit for output token is 64k
const DEFAULT_MAX_OUTPUT_TOKENS = 16384;

function inferContentInspectType(input: {
  readonly type?: unknown;
  readonly text?: unknown;
  readonly url?: unknown;
  readonly path?: unknown;
  readonly base64?: unknown;
}): "text" | "binary" | undefined {
  if (input.type === "text" || input.type === "binary") return input.type;

  if (typeof input.text === "string" && input.text.length > 0) return "text";

  if (
    typeof input.url === "string" ||
    typeof input.path === "string" ||
    typeof input.base64 === "string"
  ) {
    return "binary";
  }

  return undefined;
}

export const contentInspectInputSchema = z
  .object({
    type: z
      .enum(["text", "binary"])
      .optional()
      .describe("Input type. Optional; inferred from provided fields when omitted."),

    text: z.string().optional().describe("Plain text to summarize (can also be a website URL)."),

    url: z
      .string()
      .min(1)
      .optional()
      .describe("Remote URL for binary content (files/images) or a YouTube URL for video."),

    path: z.string().min(1).optional().describe("Local file path for binary content."),

    base64: z.base64().optional().describe("Base64-encoded binary content."),

    additionalInstructions: z
      .string()
      .optional()
      .describe("Additional instructions you want to give to the model."),

    maxOutputTokens: z.coerce
      .number()
      .optional()
      .describe(`Max output token, defaults to ${DEFAULT_MAX_OUTPUT_TOKENS}, max is 64k.`),
  })
  .superRefine((input, ctx) => {
    const type = inferContentInspectType(input);
    if (!type) {
      ctx.addIssue({
        code: "custom",
        message: "Missing input. Provide `text` or one of `url`, `path`, or `base64`.",
      });
      return;
    }

    if (type === "text") {
      if (typeof input.text !== "string" || input.text.length === 0) {
        ctx.addIssue({
          code: "custom",
          path: ["text"],
          message: "`text` is required when type is text.",
        });
      }

      if (
        typeof input.url === "string" ||
        typeof input.path === "string" ||
        typeof input.base64 === "string"
      ) {
        ctx.addIssue({
          code: "custom",
          message: "When using text input, do not also provide url/path/base64.",
        });
      }

      return;
    }

    if (typeof input.text === "string") {
      ctx.addIssue({
        code: "custom",
        message: "When using binary input, do not provide `text`.",
      });
    }

    const sources = [input.url, input.path, input.base64].filter((v) => typeof v === "string");
    if (sources.length !== 1) {
      ctx.addIssue({
        code: "custom",
        message: "Binary input requires exactly one of `url`, `path`, or `base64`.",
      });
    }
  })
  .transform((input) => {
    const type = inferContentInspectType(input);
    if (type === "text") {
      return {
        type: "text",
        text: input.text as string,
        additionalInstructions: input.additionalInstructions,
        maxOutputTokens: input.maxOutputTokens,
      } as const;
    }

    if (typeof input.url === "string") {
      return {
        type: "binary",
        url: input.url,
        additionalInstructions: input.additionalInstructions,
        maxOutputTokens: input.maxOutputTokens,
      } as const;
    }

    if (typeof input.path === "string") {
      return {
        type: "binary",
        path: input.path,
        additionalInstructions: input.additionalInstructions,
        maxOutputTokens: input.maxOutputTokens,
      } as const;
    }

    return {
      type: "binary",
      base64: input.base64 as string,
      additionalInstructions: input.additionalInstructions,
      maxOutputTokens: input.maxOutputTokens,
    } as const;
  })
  .describe(
    "Anything to inspect.\n" +
      "- Use `text` for plain text or websites (pass URL in the `text` field).\n" +
      "- Use `binary` for images/files/videos via exactly one of: `url`, `path`, or `base64`.\n" +
      "- If `type` is omitted, it is inferred from provided fields.\n",
  );

async function resolveContentInspectModel(
  getConfig: ContentInspectOptions["getConfig"],
): Promise<string> {
  const configured = getConfig
    ? (await getConfig()).tools.inspect.model
    : V2_CONTENT_INSPECT_DEFAULT_MODEL;

  if (configured.startsWith("google/")) return configured;

  logger.error("content.inspect configured model must start with google/; using default", {
    configuredModel: configured,
    fallbackModel: V2_CONTENT_INSPECT_DEFAULT_MODEL,
  });
  return V2_CONTENT_INSPECT_DEFAULT_MODEL;
}

export async function inspectContent(
  input: z.infer<typeof contentInspectInputSchema>,
  { abortSignal, model }: { abortSignal?: AbortSignal; model?: string },
) {
  let messages: ModelMessage[];

  switch (input.type) {
    case "text": {
      const content: UserContent = [];
      if (input.additionalInstructions) {
        content.push({ type: "text", text: input.additionalInstructions });
      }
      content.push({ type: "text", text: input.text });
      messages = buildContentInspectMessages({ role: "user", content });
      break;
    }
    case "binary": {
      const source = await loadInspectSource(input, abortSignal);

      const content: UserContent = [];

      if (input.additionalInstructions) {
        content.push({ type: "text", text: input.additionalInstructions });
      }

      if (source.kind === "text") {
        content.push({
          type: "text",
          text: [
            `Source: ${source.source}`,
            `Media type: ${source.mediaType}`,
            "",
            source.text,
          ].join("\n"),
        });
      } else {
        content.push({ type: "file", data: source.data, mediaType: source.mediaType });
      }

      messages = buildContentInspectMessages({
        role: "user",
        content,
      });
      break;
    }
  }

  const gateway = providers.vercel;
  if (!gateway) throw new Error("AI-GATEWAY not configured");

  const res = await generateText({
    model: gateway(model ?? V2_CONTENT_INSPECT_DEFAULT_MODEL),
    instructions: CONTENT_INSPECT_INSTRUCTIONS,
    messages,
    maxOutputTokens: input.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
    abortSignal,
    tools: {
      google_search: google.tools.googleSearch({}),
      url_context: google.tools.urlContext({}),
    } as ToolSet,
    providerOptions: {
      google: {
        thinkingConfig: {
          thinkingLevel: "high",
          includeThoughts: true,
        },
      } satisfies GoogleLanguageModelOptions,
    },
    stopWhen: isStepCount(10),
  });
  return res.text;
}

function buildContentInspectMessages(input: UserModelMessage): ModelMessage[] {
  return [input];
}

export async function loadInspectSource(
  input: Extract<z.infer<typeof contentInspectInputSchema>, { type: "binary" }>,
  abortSignal?: AbortSignal,
): Promise<LoadedInspectSource> {
  if (typeof input.url === "string") {
    if (isYouTubeURL(input.url)) {
      return {
        kind: "file",
        data: new URL(input.url),
        mediaType: "video/mp4",
        source: input.url,
      };
    }

    const res = await fetch(input.url, { signal: abortSignal });
    if (!res.ok) {
      throw new Error(`Failed to fetch ${input.url}: ${res.status} ${res.statusText}`.trim());
    }

    const blob = await res.blob();
    const bytes = await blob.bytes();
    const meta = await fileTypeFromBlob(blob);
    const declared = res.headers.get("content-type") ?? blob.type;
    const mediaType = resolveInspectMediaType({
      detected: meta?.mime,
      declared,
      source: input.url,
      bytes,
    });
    return sourceFromBytes({
      bytes,
      mediaType,
      charset: charsetFromMediaType(declared),
      source: input.url,
    });
  }

  if (typeof input.path === "string") {
    const file = Bun.file(input.path);
    const bytes = await file.bytes();
    const buf = Buffer.from(bytes);
    const meta = await fileTypeFromBuffer(buf);
    const declared = file.type;
    const mediaType = resolveInspectMediaType({
      detected: meta?.mime,
      declared,
      source: input.path,
      bytes: buf,
    });
    return sourceFromBytes({
      bytes: buf,
      mediaType,
      charset: charsetFromMediaType(declared),
      source: input.path,
    });
  }

  if (typeof input.base64 !== "string") {
    throw new Error("Invalid binary input; expected base64 string");
  }

  const buf = Buffer.from(input.base64, "base64");
  const meta = await fileTypeFromBuffer(buf);
  const mediaType = resolveInspectMediaType({
    detected: meta?.mime,
    source: "base64 input",
    bytes: buf,
  });
  return sourceFromBytes({ bytes: buf, mediaType, source: "base64 input" });
}

function sourceFromBytes(input: {
  bytes: Uint8Array;
  mediaType: string;
  charset?: string;
  source: string;
}): LoadedInspectSource {
  if (isTextLikeMediaType(input.mediaType)) {
    return {
      kind: "text",
      text: decodeInspectText(input.bytes, input.charset),
      mediaType: input.mediaType,
      charset: input.charset,
      source: input.source,
    };
  }

  if (input.mediaType === "application/octet-stream") {
    throw new Error(
      `Unsupported or unknown file media type for ${input.source}; pass text via --text or use a supported image/PDF/video file.`,
    );
  }

  return {
    kind: "file",
    data: input.bytes,
    mediaType: input.mediaType,
    source: input.source,
  };
}

export function resolveInspectMediaType(input: {
  detected?: string;
  declared?: string;
  source?: string;
  bytes?: Uint8Array;
}): string {
  const detected = normalizeInspectMediaType(input.detected);
  if (detected && detected !== "application/octet-stream") return detected;

  const declared = normalizeInspectMediaType(input.declared);
  if (declared && declared !== "application/octet-stream") return declared;

  const fromExtension = input.source ? mediaTypeFromSource(input.source) : undefined;
  if (fromExtension) return fromExtension;

  if (input.bytes && looksLikeUtf8Text(input.bytes)) return "text/plain";

  return "application/octet-stream";
}

export function isTextLikeMediaType(mediaType: string): boolean {
  const normalized = normalizeInspectMediaType(mediaType) ?? "";
  if (normalized.startsWith("text/")) return true;
  if (normalized.endsWith("+json") || normalized.endsWith("+xml")) return true;

  return [
    "application/javascript",
    "application/json",
    "application/ld+json",
    "application/sql",
    "application/toml",
    "application/x-ndjson",
    "application/xml",
    "application/yaml",
    "image/svg+xml",
  ].includes(normalized);
}

function mediaTypeFromSource(source: string): string | undefined {
  return TEXT_EXTENSION_MEDIA_TYPES[extname(urlSafePath(source)).toLowerCase()];
}

function normalizeInspectMediaType(mediaType: string | undefined): string | undefined {
  const normalized = mediaType?.split(";", 1)[0]?.trim().toLowerCase();
  return normalized ? normalized : undefined;
}

function charsetFromMediaType(mediaType: string | undefined): string | undefined {
  if (!mediaType) return undefined;

  const parts = mediaType.split(";").slice(1);
  for (const part of parts) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;

    const key = part.slice(0, eq).trim().toLowerCase();
    if (key !== "charset") continue;

    const value = part
      .slice(eq + 1)
      .trim()
      .replace(/^['"]|['"]$/g, "");
    return value ? value : undefined;
  }

  return undefined;
}

function looksLikeUtf8Text(bytes: Uint8Array): boolean {
  if (bytes.length === 0) return true;
  if (bytes.includes(0)) return false;

  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (!text) return true;
    let suspicious = 0;
    for (const char of text) {
      const code = char.charCodeAt(0);
      if (code < 32 && code !== 9 && code !== 10 && code !== 13) suspicious += 1;
    }
    return suspicious / text.length < 0.01;
  } catch {
    return false;
  }
}

function decodeInspectText(bytes: Uint8Array, charset: string | undefined): string {
  const encoding = charset ?? "utf-8";
  try {
    return new TextDecoder(encoding, { fatal: true }).decode(bytes);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    throw new Error(`Failed to decode text content as ${encoding}: ${message}`);
  }
}

function urlSafePath(source: string): string {
  try {
    return new URL(source).pathname;
  } catch {
    return source;
  }
}

function isYouTubeURL(url: string) {
  if (url.startsWith("https://www.youtube.com/watch?v=")) return true;
  if (url.startsWith("https://youtu.be/")) return true;
  return false;
}
