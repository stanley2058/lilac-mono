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
      let mime: string;
      let data: Uint8Array | URL;

      if (typeof input.url === "string") {
        if (isYouTubeURL(input.url)) {
          data = new URL(input.url);
          mime = "video/mp4";
        } else {
          const res = await fetch(input.url, { signal: abortSignal });
          const blob = await res.blob();
          const meta = await fileTypeFromBlob(blob);
          mime = meta?.mime ?? "application/octet-stream";
          data = await blob.bytes();
        }
      } else if (typeof input.path === "string") {
        const bytes = await Bun.file(input.path).bytes();
        const buf = Buffer.from(bytes);
        const meta = await fileTypeFromBuffer(buf);
        mime = meta?.mime ?? "application/octet-stream";
        data = buf;
      } else {
        if (typeof input.base64 !== "string") {
          throw new Error("Invalid binary input; expected base64 string");
        }
        const buf = Buffer.from(input.base64, "base64");
        const meta = await fileTypeFromBuffer(buf);
        mime = meta?.mime ?? "application/octet-stream";
        data = buf;
      }

      const content: UserContent = [];

      if (input.additionalInstructions) {
        content.push({ type: "text", text: input.additionalInstructions });
      }

      content.push({ type: "file", data, mediaType: mime });

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

function isYouTubeURL(url: string) {
  if (url.startsWith("https://www.youtube.com/watch?v=")) return true;
  if (url.startsWith("https://youtu.be/")) return true;
  return false;
}
