import { z } from "zod";

import type { ServerTool } from "../types";
import type { ConversationThreadToolService } from "../../conversation/thread-service";
import { zodObjectToCliLines } from "./zod-cli";

const searchInputSchema = z.object({
  query: z.string().min(1).describe("Search query."),
  mode: z
    .enum(["hybrid", "semantic", "lexical"])
    .optional()
    .describe("Search mode. Defaults to hybrid."),
  limit: z.coerce.number().int().positive().max(50).optional().describe("Max results."),
  sessionId: z
    .string()
    .min(1)
    .optional()
    .describe("Only return threads in this Discord session/channel id."),
  participantId: z
    .string()
    .min(1)
    .optional()
    .describe("Only return threads containing this Discord user id."),
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

const runSummarizationInputSchema = z.object({
  dryRun: z.boolean().optional().describe("Only report eligible threads without summarizing."),
  force: z
    .boolean()
    .optional()
    .describe("Rerun summaries for quiet eligible threads even when fresh."),
  wait: z
    .boolean()
    .optional()
    .describe(
      "When a background worker is available, wait for completion instead of returning a queued job id.",
    ),
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

export class ConversationThread implements ServerTool {
  id = "conversation.thread";

  constructor(
    private readonly params: {
      service: ConversationThreadToolService;
    },
  ) {}

  async init(): Promise<void> {}
  async destroy(): Promise<void> {}

  async list() {
    return [
      {
        callableId: "conversation.thread.search",
        name: "Conversation Thread Search",
        description:
          "Search summarized conversation threads. Returns compact title, brief, topics, importance, and metadata; use conversation.thread.read to expand a result.",
        shortInput: zodObjectToCliLines(searchInputSchema, { mode: "required" }),
        input: zodObjectToCliLines(searchInputSchema),
        primaryPositional: {
          field: "query",
        },
      },
      {
        callableId: "conversation.thread.read",
        name: "Conversation Thread Read",
        description: "Read a conversation thread transcript by id with offset/limit pagination.",
        shortInput: zodObjectToCliLines(readInputSchema, { mode: "required" }),
        input: zodObjectToCliLines(readInputSchema),
      },
      {
        callableId: "conversation.thread.runSummarization",
        name: "Conversation Thread Run Summarization",
        description: "Hidden admin runner for conversation thread refresh and summarization.",
        shortInput: zodObjectToCliLines(runSummarizationInputSchema, { mode: "required" }),
        input: zodObjectToCliLines(runSummarizationInputSchema),
        hidden: true,
      },
    ];
  }

  async call(callableId: string, rawInput: Record<string, unknown>): Promise<unknown> {
    if (callableId === "conversation.thread.search") {
      const input = searchInputSchema.parse(rawInput);
      return await this.params.service.search(input);
    }

    if (callableId === "conversation.thread.read") {
      const input = readInputSchema.parse(rawInput);
      return await this.params.service.read(input);
    }

    if (callableId === "conversation.thread.runSummarization") {
      const input = runSummarizationInputSchema.parse(rawInput);
      return await this.params.service.runSummarization(input);
    }

    throw new Error(`Invalid callable ID '${callableId}'`);
  }
}
