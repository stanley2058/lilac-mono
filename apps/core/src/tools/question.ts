import { nativeThreadId } from "../surface/native/native-protocol";
import { tool } from "ai";
import { Result } from "better-result";
import { z } from "zod";

import { questionAnswersSchema, questionToolInputSchema } from "../question/question-domain";
import { QuestionUnavailable, type QuestionService } from "../question/question-service";
import { adaptToolResultToHost } from "./tool-result-adapters";

const questionRequestContextSchema = z.object({
  requestId: z.string().min(1),
  requestDeliveryId: z.string().min(1),
  sessionId: z.string().min(1),
  requestClient: z.enum(["discord", "native"]),
  currentTurnUserId: z.string().min(1).optional(),
  currentTurnMessageRef: z
    .strictObject({
      platform: z.enum(["discord", "native"]),
      channelId: z.string().min(1),
      messageId: z.string().min(1),
    })
    .optional(),
  requestInitiator: z.strictObject({
    platform: z.enum(["discord", "native"]),
    userId: z.string().min(1),
  }),
  requestInitiatorSessionId: z.string().min(1),
  metadata: z
    .object({
      onActivity: z
        .function({
          input: [z.enum(["tool", "subagent"])],
          output: z.void(),
        })
        .optional(),
    })
    .loose()
    .optional(),
});

export function formatQuestionToolArgs(input: unknown): string {
  const decoded = questionToolInputSchema.safeParse(input);
  if (!decoded.success) return "question";
  const first = decoded.data.questions[0];
  return first ? first.header : "question";
}

export function createQuestionTool(service: QuestionService) {
  return tool({
    description: [
      "Ask the current user one to three questions when their decision is required to continue.",
      "Default mode is deferred: acceptance means the question was created, not answered. Continue independent work.",
      "On native, deferred questions remain pending after your turn finishes and the user replies with a normal message, including attachments. Finish independent work and yield when ready.",
      "On Discord, when no independent work remains, call skip_reply with the reason you are waiting. The runtime resumes you with question_result.",
      "Use mode sync only when you need the answer before the next useful action. Never poll or call tools just to wait.",
      "Cancellation is not consent. Sync questions may expire; deferred questions have no inactivity timeout.",
      "Each question must have a stable ID and two or three mutually exclusive options.",
      "Put the recommended option first and explain the effect of every option.",
      "Do not add an Other option; the interface provides custom text input.",
      "Do not use this for status updates, questions you can answer from available context, or permission escalation.",
    ].join(" "),
    inputSchema: questionToolInputSchema,
    outputSchema: z.discriminatedUnion("mode", [
      z.strictObject({
        mode: z.literal("deferred"),
        status: z.literal("accepted"),
        questionCallId: z.string(),
      }),
      z.strictObject({
        mode: z.literal("sync"),
        status: z.literal("answered"),
        questionCallId: z.string(),
        answers: questionAnswersSchema,
      }),
    ]),
    execute: async (input, { abortSignal, context, toolCallId }) => {
      const decoded = questionRequestContextSchema.safeParse(context);
      if (!decoded.success) {
        return adaptToolResultToHost(
          Result.err(
            new QuestionUnavailable({
              message: "question requires an authenticated supported surface request",
            }),
          ),
        );
      }
      const request = decoded.data;
      const reportActivity = request.metadata?.onActivity;
      if (
        request.requestInitiatorSessionId !== request.sessionId ||
        request.requestInitiator.platform !== request.requestClient ||
        (request.currentTurnMessageRef &&
          request.currentTurnMessageRef.platform !== request.requestClient)
      ) {
        return adaptToolResultToHost(
          Result.err(
            new QuestionUnavailable({
              message: "question request origin does not match the active session",
            }),
          ),
        );
      }
      const result = await service.begin({
        mode: input.mode ?? "deferred",
        platform: request.requestClient,
        requestDeliveryId: request.requestDeliveryId,
        requestId: request.requestId,
        toolCallId,
        sessionId:
          request.requestClient === "native"
            ? nativeThreadId(request.sessionId)
            : request.sessionId,
        userId: request.currentTurnUserId ?? request.requestInitiator.userId,
        ...(request.currentTurnMessageRef ? { replyTo: request.currentTurnMessageRef } : {}),
        questions: { questions: input.questions },
        signal: abortSignal,
        ...(reportActivity ? { onActivity: () => reportActivity("tool") } : {}),
      });
      const handle = adaptToolResultToHost(result);
      if (handle.mode === "deferred")
        return {
          mode: "deferred" as const,
          status: "accepted" as const,
          questionCallId: handle.questionCallId,
        };
      return {
        mode: "sync" as const,
        status: "answered" as const,
        questionCallId: handle.questionCallId,
        answers: adaptToolResultToHost(await handle.completion),
      };
    },
  });
}
