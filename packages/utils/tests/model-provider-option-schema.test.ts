import { describe, expect, it } from "bun:test";
import { z } from "zod";

import type { JSONObject } from "../core-config/types";
import {
  agentProviderOptionSchema,
  parseAgentProviderOptions,
} from "../model-provider-agent-option-schema";
import {
  MODEL_PROVIDER_OPTION_NON_JSON_PATHS,
  MODEL_PROVIDER_OPTION_SCHEMAS,
} from "../model-provider-option-schema.generated";

const schemas = JSON.parse(JSON.stringify(MODEL_PROVIDER_OPTION_SCHEMAS)) as Record<
  string,
  z.core.JSONSchema.JSONSchema
>;

function accepts(namespace: string, value: unknown): boolean {
  const schema = schemas[namespace];
  if (!schema) throw new Error(`Missing schema for '${namespace}'`);
  return z.fromJSONSchema(schema).safeParse(value).success;
}

describe("model provider option schemas", () => {
  it("survive a JSON round trip", () => {
    expect(schemas).toEqual(MODEL_PROVIDER_OPTION_SCHEMAS as unknown as typeof schemas);
    expect(MODEL_PROVIDER_OPTION_NON_JSON_PATHS).toEqual([]);
  });

  it("validate top-level enum options", () => {
    expect(accepts("anthropic", { speed: "fast" })).toBe(true);
    expect(accepts("anthropic", { speed: "turbo" })).toBe(false);
    expect(accepts("openai", { serviceTier: "priority" })).toBe(true);
    expect(accepts("openai", { serviceTier: "ultra" })).toBe(false);
  });

  it("validate nested options", () => {
    expect(accepts("anthropic", { thinking: { type: "enabled", budgetTokens: 1000 } })).toBe(true);
    expect(accepts("anthropic", { thinking: { type: "bogus" } })).toBe(false);
    expect(accepts("anthropic", { cacheControl: { type: "ephemeral", ttl: "1h" } })).toBe(true);
    expect(accepts("anthropic", { cacheControl: { ttl: "1h" } })).toBe(false);
  });

  it("reject unknown keys", () => {
    expect(accepts("anthropic", { serviceTeir: "auto" })).toBe(false);
  });
});

describe("agent provider options", () => {
  function parsed(
    provider: string,
    options: Record<string, unknown>,
  ): { ok: true; value: Record<string, JSONObject> } | { ok: false; message: string } {
    const result = parseAgentProviderOptions(provider, options as JSONObject);
    return result.isOk()
      ? { ok: true, value: result.value }
      : { ok: false, message: result.error.message };
  }

  it("namespaces valid options for the model's provider", () => {
    expect(
      parsed("anthropic", { speed: "fast", taskBudget: { type: "tokens", total: 50000 } }),
    ).toEqual({
      ok: true,
      value: { anthropic: { speed: "fast", taskBudget: { type: "tokens", total: 50000 } } },
    });
    expect(parsed("codex", { serviceTier: "priority" })).toEqual({
      ok: true,
      value: { openai: { serviceTier: "priority" } },
    });
    expect(parsed("claude-code", { settings: { fastMode: true } })).toEqual({
      ok: true,
      value: { "claude-code": { settings: { fastMode: true } } },
    });
  });

  it("rejects Core-owned options and suggests near keys", () => {
    const blocked = parsed("openai", { previousResponseId: "resp_1" });
    expect(blocked.ok).toBe(false);
    expect(!blocked.ok && blocked.message).toContain(
      "previousResponseId is not a supported option",
    );
    const inherited = parsed("openai", JSON.parse('{"constructor":1}'));
    expect(!inherited.ok && inherited.message).toContain("constructor is not a supported option");
    const typo = parsed("anthropic", { sped: "fast" });
    expect(!typo.ok && typo.message).toContain("did you mean 'speed'?");
  });

  it("reports wrong values with their path", () => {
    const enumIssue = parsed("anthropic", { speed: "turbo" });
    expect(!enumIssue.ok && enumIssue.message).toContain('speed must be "fast" | "standard"');
    const missing = parsed("anthropic", { taskBudget: { total: 50000 } });
    expect(!missing.ok && missing.message).toContain("taskBudget.type is required");
  });

  it("rejects options for providers without an option schema", () => {
    const result = parsed("openrouter", { route: "fallback" });
    expect(!result.ok && result.message).toContain("accept no agent options");
    expect(parsed("openrouter", {})).toEqual({ ok: true, value: {} });
  });

  it("hides blocked keys from the published schema", () => {
    const schema = agentProviderOptionSchema("anthropic");
    expect(schema?.namespace).toBe("anthropic");
    expect(Object.keys(schema?.schema.properties ?? {})).toContain("speed");
    expect(Object.keys(schema?.schema.properties ?? {})).not.toContain("cacheControl");
  });
});
