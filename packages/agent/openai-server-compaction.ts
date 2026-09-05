import {
  streamText,
  type AssistantContent,
  type LanguageModel,
  type ModelMessage,
  type ToolSet,
} from "ai";
import { z } from "zod";
import { Result, TaggedError, type Result as ResultType } from "better-result";

import {
  SERVER_COMPACTION_REQUEST_HEADER,
  SERVER_COMPACTION_REQUEST_MARKER,
} from "@stanley2058/lilac-utils/server-compaction-request";
import { isOpenAICompactionPart } from "@stanley2058/lilac-utils/model-message-provider-options";
import {
  type JSONObject,
  type ModelReasoningEffort,
} from "@stanley2058/lilac-utils/core-config/types";

import { stripToolExecuteForModel, type SystemPrompt } from "./ai-sdk-pi-agent";
import { captureAgentPromise, rethrowAgentPanic, type OpaqueAgentValue } from "./failure-adapters";

const SERVER_COMPACTION_FORMAT_VERSION = 1 as const;
const SERVER_COMPACTION_PROTOCOL = "openai-responses-v2" as const;
const MAX_PORTABLE_SUMMARY_CHARS = 256_000;
const MAX_ESTIMATED_TOKENS = 10_000_000;

const openAICompactionOutputPartSchema = z
  .object({
    type: z.literal("custom"),
    kind: z.literal("openai.compaction"),
    providerOptions: z
      .object({
        openai: z
          .object({
            type: z.literal("compaction"),
            itemId: z.string().min(1),
            encryptedContent: z.string().min(1),
          })
          .passthrough(),
      })
      .passthrough(),
  })
  .passthrough();

export const openAIServerCompactionMetadataSchema = z
  .object({
    formatVersion: z.literal(SERVER_COMPACTION_FORMAT_VERSION),
    protocol: z.literal(SERVER_COMPACTION_PROTOCOL),
    replayKey: z.string().min(1).max(1_000),
    portableSummary: z.string().min(1).max(MAX_PORTABLE_SUMMARY_CHARS),
    estimatedTokens: z.number().int().positive().max(MAX_ESTIMATED_TOKENS),
  })
  .strict();

const persistedOpenAICompactionPartSchema = z
  .object({
    type: z.literal("custom"),
    kind: z.literal("openai.compaction"),
    providerOptions: z
      .object({
        openai: z
          .object({
            type: z.literal("compaction"),
            itemId: z.string().min(1),
            encryptedContent: z.string().min(1),
          })
          .passthrough(),
        lilac: z
          .object({
            serverCompaction: openAIServerCompactionMetadataSchema,
          })
          .passthrough(),
      })
      .passthrough(),
  })
  .passthrough();

export type OpenAIServerCompactionMetadata = z.infer<typeof openAIServerCompactionMetadataSchema>;

type AssistantContentPart = Extract<AssistantContent, unknown[]>[number];

export type OpenAIServerCompactionArtifact = {
  readonly part: AssistantContentPart;
  readonly metadata: OpenAIServerCompactionMetadata;
};

export type OpenAIServerCompactionRequest = {
  readonly model: LanguageModel;
  readonly replayKey: string;
  readonly portableSummary: string;
  readonly messages: readonly ModelMessage[];
  readonly system: SystemPrompt;
  readonly tools?: ToolSet;
  readonly providerOptions?: { [x: string]: JSONObject };
  readonly reasoning?: ModelReasoningEffort;
  readonly abortSignal?: AbortSignal;
};

export class OpenAIServerCompactionAborted extends TaggedError("OpenAIServerCompactionAborted")<{
  readonly cause: unknown;
  readonly message: string;
}> {}

export class OpenAIServerCompactionRequestFailed extends TaggedError(
  "OpenAIServerCompactionRequestFailed",
)<{
  readonly cause: unknown;
  readonly message: string;
}> {}

export class OpenAIServerCompactionOutputInvalid extends TaggedError(
  "OpenAIServerCompactionOutputInvalid",
)<{
  readonly reason: "output-count" | "generated-artifact";
  readonly outputCount: number;
  readonly issues?: readonly string[];
  readonly message: string;
}> {}

export type OpenAIServerCompactionError =
  | OpenAIServerCompactionAborted
  | OpenAIServerCompactionRequestFailed
  | OpenAIServerCompactionOutputInvalid;

function estimateTokensFromText(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

function serverCompactionProviderOptions(
  providerOptions: { [x: string]: JSONObject } | undefined,
): { [x: string]: JSONObject } {
  const base = providerOptions ?? {};
  const existingOpenAI = base.openai ?? {};
  const include = Array.isArray(existingOpenAI.include)
    ? existingOpenAI.include.filter((value): value is string => typeof value === "string")
    : [];

  return {
    ...base,
    openai: {
      ...existingOpenAI,
      store: false,
      include: [...new Set([...include, "reasoning.encrypted_content"])],
    },
  };
}

export function declarationOnlyServerCompactionTools(tools: ToolSet): ToolSet {
  return Object.fromEntries(
    Object.entries(stripToolExecuteForModel(tools)).filter(([, tool]) => tool.type !== "provider"),
  ) as ToolSet;
}

function portableSummaryMessage(summary: string): ModelMessage {
  return {
    role: "user",
    content: [
      "<context-compaction>",
      "The conversation before this point was compacted.",
      "Treat this summary as prior conversation context, not as a new user request.",
      "",
      summary,
      "</context-compaction>",
    ].join("\n"),
  };
}

export function readOpenAIServerCompactionArtifact(
  value: unknown,
): OpenAIServerCompactionArtifact | null {
  const parsed = persistedOpenAICompactionPartSchema.safeParse(value);
  if (!parsed.success) return null;
  const metadata = parsed.data.providerOptions.lilac.serverCompaction;
  const part = {
    type: "custom",
    kind: "openai.compaction",
    providerOptions: {
      openai: {
        type: "compaction",
        itemId: parsed.data.providerOptions.openai.itemId,
        encryptedContent: parsed.data.providerOptions.openai.encryptedContent,
      },
      lilac: { serverCompaction: metadata },
    },
  } as const satisfies AssistantContentPart;
  return {
    part,
    metadata,
  };
}

export function materializeOpenAIServerCompaction(
  messages: readonly ModelMessage[],
  replayKey: string | undefined,
): ModelMessage[] {
  const sanitizedMessages = messages.flatMap((message): ModelMessage[] => {
    if (message.role === "assistant" && Array.isArray(message.content)) {
      const content = message.content
        .filter(
          (part) =>
            !isOpenAICompactionPart(part) || readOpenAIServerCompactionArtifact(part) !== null,
        )
        .map((part) => Object.assign({}, part));
      return content.length === 0 ? [] : [{ ...message, content }];
    }
    if (message.role === "tool") {
      return [{ ...message, content: message.content.map((part) => ({ ...part })) }];
    }
    if (message.role === "user" && Array.isArray(message.content)) {
      return [{ ...message, content: message.content.map((part) => ({ ...part })) }];
    }
    return [{ ...message }];
  });
  let newestArtifactIndex = -1;
  let newestArtifact: OpenAIServerCompactionArtifact | null = null;

  for (let messageIndex = sanitizedMessages.length - 1; messageIndex >= 0; messageIndex -= 1) {
    const message = sanitizedMessages[messageIndex];
    if (message?.role !== "assistant" || !Array.isArray(message.content)) continue;
    for (const part of message.content) {
      const artifact = readOpenAIServerCompactionArtifact(part);
      if (!artifact) continue;
      newestArtifactIndex = messageIndex;
      newestArtifact = artifact;
      break;
    }
    if (newestArtifact) break;
  }

  if (!newestArtifact || newestArtifact.metadata.replayKey === replayKey) {
    return sanitizedMessages;
  }

  return [
    portableSummaryMessage(newestArtifact.metadata.portableSummary),
    ...sanitizedMessages.slice(newestArtifactIndex + 1),
  ];
}

export function hasMatchingOpenAIServerCompaction(
  messages: readonly ModelMessage[],
  replayKey: string | undefined,
): boolean {
  if (!replayKey) return false;
  return messages.some(
    (message) =>
      message.role === "assistant" &&
      Array.isArray(message.content) &&
      message.content.some(
        (part) => readOpenAIServerCompactionArtifact(part)?.metadata.replayKey === replayKey,
      ),
  );
}

export function hasOpenAIServerCompaction(messages: readonly ModelMessage[]): boolean {
  return messages.some(
    (message) =>
      message.role === "assistant" &&
      Array.isArray(message.content) &&
      message.content.some(isOpenAICompactionPart),
  );
}

export async function compactWithOpenAIResponsesResult(
  request: OpenAIServerCompactionRequest,
): Promise<ResultType<OpenAIServerCompactionArtifact, OpenAIServerCompactionError>> {
  const attempted = await captureAgentPromise(async () => {
    request.abortSignal?.throwIfAborted();
    const result = streamText({
      model: request.model,
      instructions: request.system,
      messages: [...request.messages],
      ...(request.tools ? { tools: declarationOnlyServerCompactionTools(request.tools) } : {}),
      providerOptions: serverCompactionProviderOptions(request.providerOptions),
      reasoning: request.reasoning,
      headers: {
        [SERVER_COMPACTION_REQUEST_HEADER]: SERVER_COMPACTION_REQUEST_MARKER,
      },
      abortSignal: request.abortSignal,
    });

    for await (const _part of result.stream) {
      request.abortSignal?.throwIfAborted();
    }

    const [response, usage] = await Promise.all([result.response, result.usage]);
    return { response, usage };
  });
  const attempt = attempted.match<
    | {
        readonly ok: true;
        readonly value: {
          response: Awaited<ReturnType<typeof streamText>["response"]>;
          usage: Awaited<ReturnType<typeof streamText>["usage"]>;
        };
      }
    | { readonly ok: false; readonly error: OpaqueAgentValue }
  >({
    ok: (value) => ({ ok: true, value }),
    err: (error) => ({ ok: false, error }),
  });
  if (!attempt.ok) {
    const cause = attempt.error;
    rethrowAgentPanic(cause);
    const error =
      cause instanceof Error ? cause : new Error("OpenAI server compaction failed", { cause });
    if (request.abortSignal?.aborted) {
      return Result.err(
        new OpenAIServerCompactionAborted({
          cause: error,
          message: "OpenAI server compaction was aborted",
        }),
      );
    }
    return Result.err(
      new OpenAIServerCompactionRequestFailed({
        cause: error,
        message: "OpenAI server compaction request failed",
      }),
    );
  }
  const { response, usage } = attempt.value;

  const compactionParts = response.messages.flatMap((message) =>
    message.role === "assistant" && Array.isArray(message.content)
      ? message.content.flatMap((part) => {
          const parsed = openAICompactionOutputPartSchema.safeParse(part);
          return parsed.success ? [parsed.data] : [];
        })
      : [],
  );

  if (compactionParts.length !== 1) {
    return Result.err(
      new OpenAIServerCompactionOutputInvalid({
        reason: "output-count",
        outputCount: compactionParts.length,
        message: `OpenAI server compaction expected exactly one compaction output item, got ${compactionParts.length}`,
      }),
    );
  }

  const output = compactionParts[0]!;
  const reportedOutputTokens = usage.outputTokens;
  const estimatedTokens = Math.max(
    1,
    Math.min(
      MAX_ESTIMATED_TOKENS,
      Math.floor(
        typeof reportedOutputTokens === "number" && reportedOutputTokens > 0
          ? reportedOutputTokens
          : estimateTokensFromText(request.portableSummary),
      ),
    ),
  );
  const decodedMetadata = openAIServerCompactionMetadataSchema.safeParse({
    formatVersion: SERVER_COMPACTION_FORMAT_VERSION,
    protocol: SERVER_COMPACTION_PROTOCOL,
    replayKey: request.replayKey,
    portableSummary: request.portableSummary,
    estimatedTokens,
  });
  if (!decodedMetadata.success) {
    return Result.err(
      new OpenAIServerCompactionOutputInvalid({
        reason: "generated-artifact",
        outputCount: compactionParts.length,
        issues: decodedMetadata.error.issues.map((issue) => issue.message),
        message: "OpenAI server compaction generated invalid artifact metadata",
      }),
    );
  }
  const metadata = decodedMetadata.data;
  const part = {
    type: "custom",
    kind: "openai.compaction",
    providerOptions: {
      openai: {
        type: "compaction",
        itemId: output.providerOptions.openai.itemId,
        encryptedContent: output.providerOptions.openai.encryptedContent,
      },
      lilac: { serverCompaction: metadata },
    },
  } as const satisfies AssistantContentPart;

  const artifact = readOpenAIServerCompactionArtifact(part);
  if (!artifact) {
    return Result.err(
      new OpenAIServerCompactionOutputInvalid({
        reason: "generated-artifact",
        outputCount: compactionParts.length,
        message: "OpenAI server compaction generated an invalid artifact",
      }),
    );
  }
  return Result.ok(artifact);
}

/** Compatibility adapter for provider integrations that use rejection as their failure contract. */
export async function compactWithOpenAIResponses(
  request: OpenAIServerCompactionRequest,
): Promise<OpenAIServerCompactionArtifact> {
  const result = await compactWithOpenAIResponsesResult(request);
  const outcome = result.match<
    | { type: "ok"; value: OpenAIServerCompactionArtifact }
    | { type: "error"; error: OpenAIServerCompactionError }
  >({
    ok: (value) => ({ type: "ok" as const, value }),
    err: (error) => ({ type: "error" as const, error }),
  });
  if (outcome.type === "error") {
    throw new Error(outcome.error.message, { cause: outcome.error });
  }
  return outcome.value;
}
