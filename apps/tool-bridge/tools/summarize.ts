import {
  generateText,
  stepCountIs,
  type ModelMessage,
  type ToolSet,
  type UserContent,
  type UserModelMessage,
} from "ai";
import { z } from "zod";
import { fileTypeFromBlob, fileTypeFromBuffer } from "file-type";
import { google, type GoogleGenerativeAIProviderOptions } from "@ai-sdk/google";
import type { ServerTool } from "./type";
import { zodObjectToCliLines } from "./zodCli";
import { providers } from "@stanley2058/lilac-utils";

export class Summarize implements ServerTool {
  id = "summarize";

  init(): Promise<void> {
    return Promise.resolve();
  }

  destroy(): Promise<void> {
    return Promise.resolve();
  }

  async list() {
    return [
      {
        callableId: "summarize",
        name: "Summarize Content",
        description:
          "Summarize the input using Gemini AI. Use --help to see all options.",
        shortInput: [],
        input: zodObjectToCliLines(agentSummarizeInputSchema),
      },
    ];
  }

  async call(
    callableId: string,
    input: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (callableId !== "summarize") throw new Error("Invalid callable ID");

    const payload = agentSummarizeInputSchema.parse(input);
    try {
      const text = await summarize(payload, { abortSignal: signal });
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

export const agentSummarizeInputSchema = z
  .discriminatedUnion("type", [
    z.object({
      type: z.literal("text"),
      text: z.string(),
    }),
    z.object({
      type: z.literal("binary-data"),
      data: z.base64(),
    }),
    z.object({
      type: z.literal("binary-url"),
      url: z.string(),
    }),
  ])
  .and(
    z.object({
      additionalInstructions: z
        .string()
        .optional()
        .describe("Additional instructions you want to give to the model."),
      maxOutputTokens: z
        .number()
        .optional()
        .describe(
          `Max output token, defaults to ${DEFAULT_MAX_OUTPUT_TOKENS}, max is 64k.`,
        ),
    }),
  )
  .describe(
    "Any thing to get summarized.\n" +
      "- Use `text` for plain text or websites (pass URL in the `text` field).\n" +
      "- Use `binary-*` for images, files, and YouTube videos (use `binary-url` for YouTube URLs).\n",
  );

export async function summarize(
  input: z.infer<typeof agentSummarizeInputSchema>,
  { abortSignal }: { abortSignal?: AbortSignal },
) {
  let prompt: ModelMessage[];

  switch (input.type) {
    case "text": {
      const content: UserContent = [];
      if (input.additionalInstructions) {
        content.push({ type: "text", text: input.additionalInstructions });
      }
      content.push({ type: "text", text: input.text });
      prompt = buildSummarizePrompt({ role: "user", content });
      break;
    }
    case "binary-url":
    case "binary-data": {
      let mime: string;
      let data: Uint8Array | URL;
      if (input.type === "binary-url") {
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
      } else {
        const buf = Buffer.from(input.data, "base64");
        const meta = await fileTypeFromBuffer(buf);
        mime = meta?.mime ?? "application/octet-stream";
        data = buf;
      }

      const content: UserContent = [];

      if (input.additionalInstructions) {
        content.push({ type: "text", text: input.additionalInstructions });
      }

      if (mime.startsWith("image/")) {
        content.push({ type: "image", image: data, mediaType: mime });
      } else {
        content.push({ type: "file", data, mediaType: mime });
      }

      prompt = buildSummarizePrompt({
        role: "user",
        content,
      });
      break;
    }
  }

  const gateway = providers.vercel;
  if (!gateway) throw new Error("AI-GATEWAY not configured");

  const res = await generateText({
    model: gateway("google/gemini-3-flash"),
    prompt,
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
      } satisfies GoogleGenerativeAIProviderOptions,
    },
    stopWhen: stepCountIs(10),
  });
  return res.text;
}

function buildSummarizePrompt(input: UserModelMessage) {
  const prompts: ModelMessage[] = [
    {
      role: "system",
      content: [
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
        "(2–5 sentences; must be fully supported by OBSERVATIONS; no new entities)",
      ].join("\n"),
    },
  ];

  prompts.push(input);
  return prompts;
}

function isYouTubeURL(url: string) {
  if (url.startsWith("https://www.youtube.com/watch?v=")) return true;
  if (url.startsWith("https://youtu.be/")) return true;
  return false;
}
