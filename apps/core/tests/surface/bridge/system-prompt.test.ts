import { expect, it } from "bun:test";
import { parseCoreConfigV2ToUniversal, resolveModelRef } from "@stanley2058/lilac-utils";
import { buildAgentRunSystemPrompt } from "../../../src/surface/bridge/bus-agent-runner/system-prompt";

it("puts basePrompt before the workspace prompt for Codex", () => {
  const cfg = parseCoreConfigV2ToUniversal({ basePrompt: "Base prompt" });
  cfg.agent.systemPrompt = "Workspace prompt";
  const prompt = buildAgentRunSystemPrompt({
    cfg,
    resolved: resolveModelRef(cfg, { model: "codex/gpt-6.2-sol" }, "test"),
    requestClient: "native",
    runProfile: "primary",
    editingToolMode: "apply_patch",
    skillsSection: null,
    additionalSessionPrompts: [],
    messages: [],
    safetyMode: "trusted",
    sessionId: "channel",
  });
  expect(prompt).toStartWith("Base prompt\n\nWorkspace prompt");
  expect(prompt.split("Base prompt")).toHaveLength(2);
});

it("adds output instructions for the requesting surface", () => {
  const cfg = parseCoreConfigV2ToUniversal({});
  const resolved = resolveModelRef(cfg, { model: "openai/gpt-5" }, "test");
  const input = {
    cfg,
    resolved,
    runProfile: "primary" as const,
    editingToolMode: "apply_patch" as const,
    skillsSection: null,
    additionalSessionPrompts: [],
    messages: [],
    safetyMode: "trusted" as const,
    sessionId: "channel",
  };
  const discord = buildAgentRunSystemPrompt({ ...input, requestClient: "discord" });
  expect(discord).toContain("Do not put links in Markdown tables. Use a list instead");
  expect(discord).toContain("outside lists and blockquotes");
  expect(discord).not.toContain("Native web file presentation");
  const native = buildAgentRunSystemPrompt({ ...input, requestClient: "native" });
  expect(native).toContain("Native web file presentation");
  expect(native).not.toContain("Discord output formatting");
  const github = buildAgentRunSystemPrompt({ ...input, requestClient: "github" });
  expect(github).not.toContain("Discord output formatting");
  expect(github).not.toContain("Native web file presentation");
});
