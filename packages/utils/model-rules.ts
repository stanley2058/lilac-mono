import { isRecord } from "./runtime-utils";
import type { CoreConfig, JSONObject, ModelReasoningEffort } from "./core-config/types";

export type ModelRule = {
  match: string;
  options?: JSONObject;
  unset?: string[];
  reasoning?: ModelReasoningEffort;
  legacy?: boolean;
};

export function modelRuleMatches(pattern: string, spec: string): boolean {
  const escaped = pattern
    .split("*")
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${escaped}$`, "u").test(spec);
}

export function mergeModelOptions(base: JSONObject = {}, override: JSONObject = {}): JSONObject {
  const merged = structuredClone(base);
  for (const [key, value] of Object.entries(override)) {
    if (key === "__proto__" || key === "constructor" || key === "prototype") continue;
    const existing = merged[key];
    merged[key] =
      isRecord(value) && isRecord(existing)
        ? mergeModelOptions(existing, value)
        : structuredClone(value);
  }
  return merged;
}

export function modelRuleDefaults(
  config: CoreConfig,
  spec: string,
): { options: JSONObject; reasoning?: ModelReasoningEffort; legacy?: boolean } {
  let options: JSONObject = {};
  let reasoning: ModelReasoningEffort | undefined;
  let legacy: boolean | undefined;
  for (const rule of config.models.rules ?? []) {
    if (!modelRuleMatches(rule.match, spec)) continue;
    options = mergeModelOptions(options, rule.options);
    for (const key of rule.unset ?? []) {
      const parts = key.split(".");
      let parent = options;
      for (const part of parts.slice(0, -1)) {
        const value = parent[part];
        if (!isRecord(value)) {
          parent = {};
          break;
        }
        parent = value;
      }
      delete parent[parts.at(-1)!];
    }
    reasoning = rule.reasoning ?? reasoning;
    legacy = rule.legacy ?? legacy;
  }
  return { options, reasoning, legacy };
}
