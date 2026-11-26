import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { nativeQuestionSchema, type NativeQuestion } from "@stanley2058/lilac-client-protocol";
import { QuestionCard } from "../src/components/QuestionCard";
import { MessageIdentityContext } from "../src/components/message-identity";
import {
  MessageServicesContext,
  QuestionReplyContext,
  type MessageServices,
  type QuestionReplyView,
  type QuestionServices,
} from "../src/components/message-services";

const pending: NativeQuestion["view"] = {
  state: "pending",
  prompt: {
    ordinal: 2,
    total: 3,
    header: "Database",
    question: "Which data should the preview use?",
    options: [
      {
        index: 1,
        label: "Snapshot",
        description: "Copy last night's data.",
        token: "t1",
      },
      {
        index: 2,
        label: "Empty",
        description: "Start with the schema only.",
        token: "t2",
      },
    ],
    customToken: "custom",
  },
};

function question(
  view: NativeQuestion["view"],
  respondentId = "alex",
  prompts?: NativeQuestion["prompts"],
): NativeQuestion {
  return nativeQuestionSchema.parse({
    questionCallId: "call",
    requestId: "request",
    respondentId,
    historyGeneration: 0,
    mode: "deferred",
    ...(prompts ? { prompts } : {}),
    view,
  });
}

const questions: QuestionServices = {
  onReply: () => {},
  onDismiss: async () => undefined,
};

function render(
  data: NativeQuestion,
  services: Partial<MessageServices> = {},
  reply: QuestionReplyView = {},
) {
  return renderToStaticMarkup(
    <MessageIdentityContext
      value={{
        viewerId: "alex",
        agent: { displayName: "Lilac" },
        users: new Map(),
      }}
    >
      <MessageServicesContext
        value={{
          canEdit: true,
          resourceUrl: () => "",
          onAction: () => {},
          onReaction: () => {},
          questions,
          ...services,
        }}
      >
        <QuestionReplyContext value={reply}>
          <QuestionCard question={data} />
        </QuestionReplyContext>
      </MessageServicesContext>
    </MessageIdentityContext>,
  );
}

describe("question card", () => {
  test("other viewers and viewers without edit access get a read-only card", () => {
    for (const html of [
      render(question(pending, "morgan")),
      render(question(pending), { canEdit: false }),
      render(question(pending), { questions: undefined }),
    ]) {
      expect(html).toContain("data-readonly");
      expect(html).toContain("Waiting for an answer");
      expect(html).toContain("Snapshot");
      expect(html).not.toContain("<button");
    }
  });
});
