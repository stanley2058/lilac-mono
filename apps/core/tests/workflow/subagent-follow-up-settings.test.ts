import { describe, expect, it } from "bun:test";
import { parseCoreConfigV2ToUniversal } from "@stanley2058/lilac-utils";

import { followUpRunSettings } from "../../src/workflow/subagent-follow-up";
import type { WorkflowRequestPolicy } from "../../src/workflow/workflow-request-authority";

const policy = {
  model: "fast",
  reasoning: "high",
  options: { speed: "fast" },
  resolvedModelRequest: { alias: "fast", spec: "anthropic/claude-fast", provider: "anthropic" },
} as unknown as WorkflowRequestPolicy;

describe("followUpRunSettings", () => {
  const config = parseCoreConfigV2ToUniversal({});
  config.models.def = {
    fast: { model: "anthropic/claude-fast", agentCanSelect: true },
    other: { model: "anthropic/claude-other", agentCanSelect: true },
    deep: { model: "openai/gpt-5.5", agentCanSelect: true },
  };

  it("keeps every setting when the sender changes none", () => {
    expect(followUpRunSettings({ policy, targetReasoning: null, config })).toEqual({
      modelOverride: "fast",
      reasoningOverride: "high",
      providerOptionsOverride: { speed: "fast" },
    });
  });

  it("keeps options across models of the same provider namespace only", () => {
    expect(
      followUpRunSettings({ policy, targetReasoning: null, requested: { model: "other" }, config }),
    ).toEqual({ modelOverride: "other", providerOptionsOverride: { speed: "fast" } });
    expect(
      followUpRunSettings({ policy, targetReasoning: null, requested: { model: "deep" }, config }),
    ).toEqual({ modelOverride: "deep" });
  });

  it("replaces or clears options when the sender passes them", () => {
    expect(
      followUpRunSettings({
        policy,
        targetReasoning: null,
        requested: { options: { speed: "standard" } },
        config,
      }).providerOptionsOverride,
    ).toEqual({ speed: "standard" });
    expect(
      followUpRunSettings({ policy, targetReasoning: null, requested: { options: {} }, config })
        .providerOptionsOverride,
    ).toBeUndefined();
  });

  it("treats the resolved spec as the same model", () => {
    expect(
      followUpRunSettings({
        policy,
        targetReasoning: null,
        requested: { model: "anthropic/claude-fast" },
        config,
      }),
    ).toEqual({
      modelOverride: "fast",
      reasoningOverride: "high",
      providerOptionsOverride: { speed: "fast" },
    });
  });

  it("drops reasoning when config remaps the previous alias", () => {
    const remapped = parseCoreConfigV2ToUniversal({});
    remapped.models.def = { fast: { model: "anthropic/claude-newer", agentCanSelect: true } };
    expect(followUpRunSettings({ policy, targetReasoning: null, config: remapped })).toEqual({
      modelOverride: "fast",
      providerOptionsOverride: { speed: "fast" },
    });
  });

  it("drops options when the default model now maps to another provider", () => {
    const onMain = { ...policy, model: null } as WorkflowRequestPolicy;
    const retargeted = parseCoreConfigV2ToUniversal({});
    retargeted.models.main = { model: "openai/gpt-5.5" };
    expect(
      followUpRunSettings({ policy: onMain, targetReasoning: null, config: retargeted }),
    ).toEqual({});
  });
});
