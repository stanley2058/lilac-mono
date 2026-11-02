import type { ModelsDevModel, ModelsDevRegistry } from "./model-catalog-schema";

export function modelFamily(model: Pick<ModelsDevModel, "id" | "family">): string | undefined {
  if (model.family) return model.family;
  const claude = /claude-(opus|sonnet|haiku|fable)/.exec(model.id);
  if (claude) return `claude-${claude[1]}`;
  const gpt = /gpt-[\d.]+-(astra|sol|terra|luna)/.exec(model.id);
  if (gpt) return `gpt-${gpt[1]}`;
  return undefined;
}

export function newestModels(models: readonly ModelsDevModel[]): Map<string, ModelsDevModel> {
  const latest = new Map<string, ModelsDevModel>();
  for (const model of models) {
    const family = modelFamily(model);
    if (
      !family ||
      !model.release_date ||
      model.status === "deprecated" ||
      model.status === "alpha" ||
      /preview|experimental|latest/.test(model.id)
    )
      continue;
    const previous = latest.get(family);
    if (!previous || model.release_date > (previous.release_date ?? "")) latest.set(family, model);
  }
  return latest;
}

export function claudeAliasTarget(registry: ModelsDevRegistry, alias: string): string | undefined {
  if (!["opus", "sonnet", "haiku", "fable"].includes(alias)) return undefined;
  return newestModels(Object.values(registry.anthropic?.models ?? {})).get(`claude-${alias}`)?.id;
}
