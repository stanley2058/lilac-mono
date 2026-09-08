import { describe, expect, it } from "bun:test";

import type { QuestionService } from "../../src/question/question-service";
import { createBuiltinQuestionPlugin } from "../../src/plugins/builtin/question";

describe("built-in question plugin", () => {
  it("advertises a Level 1 tool that does not support batch", async () => {
    const plugin = createBuiltinQuestionPlugin();
    const instance = await plugin.create({} as never);
    const spec = instance.level1?.[0];

    expect(spec?.name).toBe("question");
    expect(spec?.supportsBatch).toBe(false);
  });

  it("enables the tool only for primary runs with authenticated requests on a supported surface", async () => {
    const plugin = createBuiltinQuestionPlugin();
    const instance = await plugin.create({} as never);
    const spec = instance.level1?.[0];
    if (!spec) throw new Error("Question tool spec is missing");
    const service = {
      supports: (platform: string) => platform === "discord",
    } as unknown as QuestionService;
    const discordContext = {
      runtime: { questions: service },
      runProfile: "primary",
      subagentDepth: 0,
      requestContext: {
        requestId: "request-1",
        requestDeliveryId: "delivery-1",
        requestClient: "discord",
        sessionId: "channel-1",
        requestInitiatorSessionId: "channel-1",
        requestInitiator: { platform: "discord", userId: "user-1" },
      },
    } as Parameters<typeof spec.isEnabled>[0];

    expect(spec.isEnabled(discordContext)).toBe(true);
    const githubContext = {
      ...discordContext,
      requestContext: {
        ...discordContext.requestContext,
        requestClient: "github",
        requestInitiator: { platform: "github", userId: "user-1" },
      },
    } as Parameters<typeof spec.isEnabled>[0];
    expect(spec.isEnabled(githubContext)).toBe(false);
    for (const runProfile of ["explore", "general", "self"] as const) {
      expect(spec.isEnabled({ ...discordContext, runProfile, subagentDepth: 1 })).toBe(false);
    }
  });
});
