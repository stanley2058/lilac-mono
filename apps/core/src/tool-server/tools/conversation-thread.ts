import { z } from "zod";
import type { NativeSearchService } from "../../surface/native/search";
import { nativeSearchTool, isNativeSearchContext } from "../../surface/native/search-tools";
import { Panic, Result, type Result as ResultType } from "better-result";
import {
  serverToolFailure,
  type ServerToolFailure,
  type ServerToolResult,
} from "@stanley2058/lilac-plugin-runtime";
import { defineServerTool, type ServerTool, type ServerToolCallOptions } from "../types";

import type {
  ConversationThreadRunSummarizationResult,
  ConversationThreadToolService,
} from "../../conversation/thread-service";
import { preserveToolPanic } from "../../tools/tool-result-adapters";

const searchInputSchema = z.object({
  surface: z
    .enum(["discord", "native"])
    .optional()
    .describe("Limit results to one surface. Defaults to both Discord and native."),
  query: z
    .union([z.string().min(1), z.array(z.string().min(1)).min(1).max(10)])
    .describe(
      "Search query, or multiple query variants/facets of the same intent to combine into one merged ranking. Multi-query is not parallel independent searches.",
    ),
  mode: z
    .enum(["hybrid", "semantic", "lexical"])
    .optional()
    .describe("Search mode. Defaults to hybrid."),
  limit: z.coerce.number().int().positive().max(50).optional().describe("Max results."),
  minScore: z.coerce
    .number()
    .nonnegative()
    .optional()
    .describe("Minimum final score after ranking and aboutness coverage. Defaults to 0.1."),
  sessionId: z
    .string()
    .min(1)
    .optional()
    .describe("Only return threads in this session/channel id."),
  participantId: z
    .string()
    .min(1)
    .optional()
    .describe("Only return threads containing this user id."),
  beforeTs: z.coerce
    .number()
    .nonnegative()
    .optional()
    .describe("Only return threads ending at or before this epoch ms."),
  afterTs: z.coerce
    .number()
    .nonnegative()
    .optional()
    .describe("Only return threads ending at or after this epoch ms."),
  verbose: z.boolean().optional().describe("Include scores, ids, anchors, and derived state."),
});

const readInputSchema = z.object({
  threadId: z.string().min(1).describe("Conversation thread id."),
  offset: z.coerce.number().int().nonnegative().optional().describe("Message offset."),
  limit: z.coerce.number().int().positive().max(200).optional().describe("Max messages."),
});

const metadataInputSchema = z.object({
  threadIds: z.array(z.string().min(1)).min(1).max(20).describe("Conversation thread ids."),
});

const runSummarizationInputSchema = z.object({
  dryRun: z.boolean().optional().describe("Only report eligible threads without summarizing."),
  force: z
    .boolean()
    .optional()
    .describe("Rerun summaries for quiet eligible threads even when fresh."),
  clear: z
    .boolean()
    .optional()
    .describe(
      "Clear existing summaries, facets, and embeddings before summarizing matching threads.",
    ),
  wait: z
    .boolean()
    .optional()
    .describe(
      "When a background worker is available, wait for completion instead of returning a queued job id.",
    ),
  limit: z.coerce
    .number()
    .int()
    .positive()
    .max(10_000)
    .optional()
    .describe("Optional maximum threads to process. Manual runs are unbounded by default."),
  threadId: z.string().min(1).optional().describe("Optional single thread id."),
  beforeTs: z.coerce
    .number()
    .nonnegative()
    .optional()
    .describe("Only include threads ending at or before this epoch ms."),
  afterTs: z.coerce
    .number()
    .nonnegative()
    .optional()
    .describe("Only include threads ending at or after this epoch ms."),
});

const CONVERSATION_THREAD_CALLABLE_IDS = {
  search: "conversation.thread.search",
  metadata: "conversation.thread.metadata",
  read: "conversation.thread.read",
  runSummarization: "conversation.thread.runSummarization",
} as const;

type ConversationThreadCapturedFailure = {
  readonly cause: Error | Panic;
  readonly _tag?: string;
  readonly message: string;
};

function captureConversationThreadFailure(error: unknown): ConversationThreadCapturedFailure {
  const tag =
    typeof error === "object" && error !== null && "_tag" in error && typeof error._tag === "string"
      ? error._tag
      : undefined;
  const message =
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof error.message === "string"
      ? error.message
      : "Conversation thread operation failed";
  if (Panic.is(error)) return { cause: error, _tag: tag, message };
  if (error instanceof Error) return { cause: error, _tag: tag, message };
  return { cause: new Error(message, { cause: error }), _tag: tag, message };
}

function conversationThreadFailure(
  error: Error | Panic | { readonly _tag?: string; readonly message: string },
): ServerToolFailure {
  if (Panic.is(error)) preserveToolPanic(error);

  const tag = "_tag" in error && typeof error._tag === "string" ? error._tag : undefined;
  const message = error.message;
  const normalized = message.toLowerCase();
  switch (tag) {
    case "ConversationThreadInvalidInput":
      return conversationThreadServerFailure("usage", message);
    case "ConversationThreadAccessDenied":
      return conversationThreadServerFailure("denied", message);
    case "ConversationThreadNotFound":
      return conversationThreadServerFailure("not_found", message);
    case "ConversationThreadSummarizationRemoteError":
    case "ConversationThreadSummarizationTransportError":
    case "ModelResolutionFailed":
      return conversationThreadServerFailure("unavailable", message);
    case "ConversationThreadSummarizationRuntimeError":
    case "ConversationThreadOperationFailed":
      return conversationThreadServerFailure("internal", message);
    default:
      if (/\b(?:abort(?:ed)?|cancelled)\b/.test(normalized)) {
        return conversationThreadServerFailure("cancelled", message);
      }
      if (/\b(?:timeout|timed out)\b/.test(normalized)) {
        return conversationThreadServerFailure("timeout", message);
      }
      if (/\bnot found\b/.test(normalized)) {
        return conversationThreadServerFailure("not_found", message);
      }
      if (/\b(?:not allowed|permission denied|access denied)\b/.test(normalized)) {
        return conversationThreadServerFailure("denied", message);
      }
      if (/\b(?:required|invalid|must be|must not)\b/.test(normalized)) {
        return conversationThreadServerFailure("usage", message);
      }
      if (/\b(?:unavailable|connection|transport|provider)\b/.test(normalized)) {
        return conversationThreadServerFailure("unavailable", message);
      }
      return conversationThreadServerFailure("internal", message);
  }
}

function conversationThreadServerFailure(
  kind: ServerToolFailure["kind"],
  message: string,
): ServerToolFailure {
  return serverToolFailure({
    kind,
    code: `conversation_thread_${kind}`,
    message,
    retryable: kind === "unavailable" || kind === "timeout",
  });
}

async function captureConversationThreadOperation<TValue>(
  operation: () => Promise<TValue>,
): Promise<ResultType<TValue, ServerToolFailure>> {
  return (
    await Result.tryPromise({
      try: operation,
      catch: captureConversationThreadFailure,
    })
  ).mapError((failure) => {
    if (Panic.is(failure.cause)) return preserveToolPanic(failure.cause);
    return conversationThreadFailure(failure);
  });
}

export async function resolveConversationThreadSummarizationToolOperation(
  operation: Promise<
    ResultType<ConversationThreadRunSummarizationResult, { readonly message: string }>
  >,
): Promise<ResultType<ConversationThreadRunSummarizationResult, ServerToolFailure>> {
  return (await operation).mapError(conversationThreadFailure);
}

async function nativeConversationOperation<T>(
  service: NativeSearchService | undefined,
  context: ServerToolCallOptions["context"],
  operation: (scoped: ConversationThreadToolService) => Promise<T>,
): Promise<ServerToolResult<T>> {
  const scoped = nativeSearchTool(service, context, (search, userId) =>
    Result.ok(search.forUser(userId)),
  );
  return Result.gen(async function* () {
    const bound = yield* scoped;
    const value = yield* Result.await(captureConversationThreadOperation(() => operation(bound)));
    return Result.ok(value);
  });
}

export class ConversationThread implements ServerTool {
  private readonly tool: ServerTool;

  constructor(
    private readonly params: {
      service: ConversationThreadToolService;
      nativeSearch?: NativeSearchService;
    },
  ) {
    this.tool = defineServerTool({
      id: "conversation.thread",
      callables: ({ callable }) => ({
        [CONVERSATION_THREAD_CALLABLE_IDS.search]: callable({
          name: "Conversation Thread Search",
          description:
            "Search summarized Discord and native conversation threads. Every result identifies its source surface. Returns compact threadId, title, and brief by default; use verbose for metadata/diagnostics or conversation.thread.read to expand a result. A thread that covers several subjects returns one result per subject; pass a result's offset to conversation.thread.read to start at that subject. Multi-query combines variants of one intent into one merged ranking.",
          inputSchema: searchInputSchema,
          primaryPositional: { field: "query", variadic: true },
          run: async (input, opts) => {
            if (isNativeSearchContext(opts?.context))
              return nativeConversationOperation(
                this.params.nativeSearch,
                opts?.context,
                (service) => service.search(input),
              );
            return captureConversationThreadOperation(() => this.params.service.search(input));
          },
        }),
        [CONVERSATION_THREAD_CALLABLE_IDS.metadata]: callable({
          name: "Conversation Thread Metadata",
          description:
            "Read conversation thread summary metadata by ids without loading transcript messages. A thread that covers several subjects lists each under entries. Supports up to 20 threadIds for candidate comparison.",
          inputSchema: metadataInputSchema,
          primaryPositional: { field: "threadIds", variadic: true },
          run: async (input, opts) => {
            if (isNativeSearchContext(opts?.context))
              return nativeConversationOperation(
                this.params.nativeSearch,
                opts?.context,
                (service) => service.metadata(input),
              );
            return captureConversationThreadOperation(() => this.params.service.metadata(input));
          },
        }),
        [CONVERSATION_THREAD_CALLABLE_IDS.read]: callable({
          name: "Conversation Thread Read",
          description:
            "Read a conversation thread transcript by id with offset/limit pagination. Output messages use content for message text.",
          inputSchema: readInputSchema,
          primaryPositional: "threadId",
          run: async (input, opts) => {
            if (isNativeSearchContext(opts?.context))
              return nativeConversationOperation(
                this.params.nativeSearch,
                opts?.context,
                (service) => service.read(input),
              );
            return captureConversationThreadOperation(() => this.params.service.read(input));
          },
        }),
        [CONVERSATION_THREAD_CALLABLE_IDS.runSummarization]: callable({
          name: "Conversation Thread Run Summarization",
          description: "Hidden admin runner for conversation thread refresh and summarization.",
          inputSchema: runSummarizationInputSchema,
          hidden: true,
          run: async (input, opts) => {
            if (isNativeSearchContext(opts?.context))
              return nativeConversationOperation(
                this.params.nativeSearch,
                opts?.context,
                (service) => service.runSummarization(input),
              );
            return captureConversationThreadOperation(() =>
              this.params.service.runSummarization(input),
            );
          },
        }),
      }),
    });
  }

  get id(): string {
    return this.tool.id;
  }

  init(): Promise<void> {
    return this.tool.init();
  }

  destroy(): Promise<void> {
    return this.tool.destroy();
  }

  list() {
    return this.tool.list();
  }

  call(
    callableId: string,
    input: Record<string, unknown>,
    opts?: ServerToolCallOptions,
  ): Promise<ServerToolResult> {
    return this.tool.call(callableId, input, opts);
  }
}
