import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { CoreConfig, ModelReasoningEffort } from "./core-config/types";
import { MODEL_REASONING_EFFORTS } from "./core-config/types";
import { env } from "./env";
import { modelCatalogCache } from "./model-catalog-cache";
import { claudeAliasTarget, modelFamily, newestModels } from "./model-catalog-family";
import type { ModelsDevModel, ModelsDevRegistry } from "./model-catalog-schema";
import { modelRuleDefaults } from "./model-rules";

export type CatalogModel = {
  id: string;
  label: string;
  provider: string;
  model: string;
  alias?: string;
  family?: string;
  legacy: boolean;
  reasoning: ModelReasoningEffort[];
  defaultReasoning?: ModelReasoningEffort;
  description?: string;
};

const providerCredentials: Record<string, readonly string[]> = {
  codex: [],
  openai: ["OPENAI_API_KEY"],
  "claude-code": ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY"],
  anthropic: ["ANTHROPIC_API_KEY"],
  xai: ["XAI_API_KEY"],
  openrouter: ["OPENROUTER_API_KEY"],
  vercel: ["AI_GATEWAY_API_KEY"],
  groq: ["GROQ_API_KEY"],
  cerebras: ["CEREBRAS_API_KEY"],
  "openai-compatible": ["OPENAI_COMPATIBLE_BASE_URL"],
};

const providerOrder = new Map(
  Object.keys(providerCredentials).map((provider, index) => [provider, index]),
);

export function compareCatalogProviders(a: string, b: string): number {
  return (
    (providerOrder.get(a) ?? providerOrder.size) - (providerOrder.get(b) ?? providerOrder.size) ||
    a.localeCompare(b)
  );
}

const CLAUDE_ALIASES = ["opus", "sonnet", "haiku", "fable"];
// Families whose newest release trails the vendor's newest by more than this are a previous generation.
const CURRENT_GENERATION_MS = 120 * 24 * 60 * 60 * 1000;

export function isClaudeAlias(model: Pick<CatalogModel, "provider" | "model">): boolean {
  return model.provider === "claude-code" && CLAUDE_ALIASES.includes(model.model);
}

function textModel(entry: ModelsDevModel): boolean {
  return (
    entry.tool_call !== false &&
    entry.modalities.output.length > 0 &&
    entry.modalities.output.every((modality) => modality === "text")
  );
}

/** Aggregators prefix ids with the vendor; generations are compared within one vendor. */
function modelVendor(entry: ModelsDevModel): string {
  const slash = entry.id.indexOf("/");
  return slash > 0 ? entry.id.slice(0, slash) : "";
}

function newestByVendor(entries: readonly ModelsDevModel[]): Map<string, number> {
  const newest = new Map<string, number>();
  for (const entry of entries) {
    if (!entry.release_date || entry.status === "deprecated") continue;
    const released = Date.parse(entry.release_date);
    if (Number.isNaN(released)) continue;
    const vendor = modelVendor(entry);
    newest.set(vendor, Math.max(newest.get(vendor) ?? 0, released));
  }
  return newest;
}

function previousGeneration(
  entry: ModelsDevModel,
  familyNewest: ModelsDevModel | undefined,
  vendorNewest: number | undefined,
): boolean {
  if (entry.status === "deprecated" || entry.id.endsWith("-latest")) return true;
  if (!entry.release_date) return false;
  if (familyNewest?.release_date && entry.release_date < familyNewest.release_date) return true;
  const released = Date.parse(entry.release_date);
  return vendorNewest !== undefined && vendorNewest - released > CURRENT_GENERATION_MS;
}

export function configuredCatalogProviders(config: CoreConfig): string[] {
  return Object.entries(providerCredentials).flatMap(([provider, keys]) => {
    const override = config.models.catalog?.providers[provider];
    if (override === "disabled") return [];
    if (override === "enabled") return [provider];
    let configured = keys.some((key) => Boolean(process.env[key]?.trim()));
    if (provider === "codex")
      configured = existsSync(path.join(env.dataDir, "secret", "codex.json"));
    if (provider === "claude-code")
      configured ||= existsSync(
        path.join(
          process.env.CLAUDE_CONFIG_DIR ?? path.join(homedir(), ".claude"),
          ".credentials.json",
        ),
      );
    return configured ? [provider] : [];
  });
}

function catalogMetadata(
  config: CoreConfig,
  registry: ModelsDevRegistry,
  spec: string,
  seen = new Set<string>(),
): ModelsDevModel | undefined {
  if (seen.has(spec)) return undefined;
  seen.add(spec);
  const inherited = config.models.capability.overrides[spec]?.inherit;
  if (inherited && inherited !== spec) return catalogMetadata(config, registry, inherited, seen);
  const slash = spec.indexOf("/");
  const provider = spec.slice(0, slash);
  const model = spec.slice(slash + 1);
  const upstream = { codex: "openai", "claude-code": "anthropic" }[provider] ?? provider;
  const target = provider === "claude-code" ? (claudeAliasTarget(registry, model) ?? model) : model;
  return registry[upstream]?.models[target];
}

export function projectModelCatalog(
  config: CoreConfig,
  registry: ModelsDevRegistry = modelCatalogCache.current(),
): CatalogModel[] {
  const models = new Map<string, CatalogModel>();
  const enabled = configuredCatalogProviders(config);
  for (const provider of enabled) {
    const upstream = { codex: "openai", "claude-code": "anthropic" }[provider] ?? provider;
    const entries = Object.values(registry[upstream]?.models ?? {}).filter(textModel);
    const latest = newestModels(entries);
    const vendors = newestByVendor(entries);
    for (const entry of entries) {
      const id = `${provider}/${entry.id}`;
      const family = modelFamily(entry);
      const newest = family ? latest.get(family) : undefined;
      const defaults = modelRuleDefaults(config, id);
      const supported =
        entry.reasoning_options?.flatMap((option) =>
          option.type === "effort" ? (option.values ?? []) : [],
        ) ?? [];
      models.set(id, {
        id,
        label: entry.name,
        provider,
        model: entry.id,
        family,
        legacy:
          defaults.legacy ?? previousGeneration(entry, newest, vendors.get(modelVendor(entry))),
        reasoning: MODEL_REASONING_EFFORTS.filter(
          (effort) => effort === "provider-default" || supported.includes(effort),
        ),
        defaultReasoning: defaults.reasoning,
      });
    }
    if (provider !== "claude-code") continue;
    for (const alias of CLAUDE_ALIASES) {
      const target = claudeAliasTarget(registry, alias);
      const base = target ? models.get(`${provider}/${target}`) : undefined;
      if (!base) continue;
      const id = `${provider}/${alias}`;
      models.set(id, {
        ...base,
        id,
        model: alias,
        label: `${alias[0]!.toUpperCase()}${alias.slice(1)} · latest`,
        legacy: false,
        defaultReasoning: modelRuleDefaults(config, id).reasoning,
      });
    }
  }
  const refs = [
    config.models.main.model,
    config.models.fast.model,
    ...Object.keys(config.models.def),
  ];
  for (const id of refs) {
    const preset = config.models.def[id];
    const spec = preset?.model ?? id;
    const slash = spec.indexOf("/");
    if (slash < 1) continue;
    const provider = spec.slice(0, slash);
    if (!enabled.includes(provider)) continue;
    const base = models.get(spec);
    models.set(id, {
      ...(base ?? {
        provider,
        model: spec.slice(slash + 1),
        legacy: false,
        reasoning: ["provider-default"],
      }),
      id,
      label: preset ? id : (base?.label ?? id),
      ...(preset ? { alias: id } : {}),
      defaultReasoning: preset?.reasoning ?? base?.defaultReasoning,
      ...(preset?.comment ? { description: preset.comment } : {}),
    });
  }
  for (const spec of Object.keys(config.models.capability.overrides)) {
    if (models.has(spec)) continue;
    const slash = spec.indexOf("/");
    const provider = spec.slice(0, slash);
    if (!enabled.includes(provider)) continue;
    models.set(spec, {
      legacy: false,
      reasoning: ["provider-default"],
      id: spec,
      label: spec.slice(slash + 1),
      provider,
      model: spec.slice(slash + 1),
    });
  }
  for (const entry of models.values()) {
    const spec = `${entry.provider}/${entry.model}`;
    const metadata = catalogMetadata(config, registry, spec);
    if (metadata) {
      const supported =
        metadata.reasoning_options?.flatMap((option) =>
          option.type === "effort" ? (option.values ?? []) : [],
        ) ?? [];
      entry.reasoning = MODEL_REASONING_EFFORTS.filter(
        (effort) => effort === "provider-default" || supported.includes(effort),
      );
      entry.family = modelFamily(metadata);
    }
    const defaults = modelRuleDefaults(config, spec);
    entry.legacy = defaults.legacy ?? entry.legacy;
    entry.defaultReasoning ??= defaults.reasoning;
  }
  return [...models.values()];
}

export function catalogReleaseDate(
  config: CoreConfig,
  registry: ModelsDevRegistry,
  model: Pick<CatalogModel, "provider" | "model">,
): string | undefined {
  return catalogMetadata(config, registry, `${model.provider}/${model.model}`)?.release_date;
}

export function findCatalogModel(config: CoreConfig, id: string): CatalogModel | undefined {
  return projectModelCatalog(config).find((model) => model.id === id);
}
