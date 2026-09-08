import type { CoreLevel1ToolSpec, CoreToolPlugin } from "../types";
import { markBoundedBuiltinOutput } from "../types";
import { QuestionUnavailable } from "../../question/question-service";
import { createQuestionTool, formatQuestionToolArgs } from "../../tools/question";
import { adaptToolResultToHost } from "../../tools/tool-result-adapters";
import { Result } from "better-result";

const QUESTION_TOOL: CoreLevel1ToolSpec = markBoundedBuiltinOutput({
  name: "question",
  supportsBatch: false,
  isEnabled: ({ runtime, requestContext, runProfile }) => {
    if (runProfile !== "primary") return false;
    if (!runtime.questions || !requestContext?.requestDeliveryId) return false;
    const initiator = requestContext.requestInitiator;
    if (!initiator || initiator.platform !== requestContext.requestClient) return false;
    if (requestContext.requestInitiatorSessionId !== requestContext.sessionId) return false;
    return runtime.questions.supports(requestContext.requestClient);
  },
  formatArgs: formatQuestionToolArgs,
  createTool: ({ runtime }) => {
    if (!runtime.questions) {
      return adaptToolResultToHost(
        Result.err(new QuestionUnavailable({ message: "question service is unavailable" })),
      );
    }
    return createQuestionTool(runtime.questions);
  },
});

export function createBuiltinQuestionPlugin(): CoreToolPlugin {
  return {
    meta: {
      id: "builtin-question",
      name: "Built-in Question",
    },
    create() {
      return {
        level1: [QUESTION_TOOL],
        level2: [],
      };
    },
  };
}
