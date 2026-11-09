import { z } from "zod";

const modelModalitySchema = z.enum(["text", "image", "audio", "video", "pdf"]);
const modelCostSchema = z.object({
  input: z.number(),
  output: z.number(),
  cache_read: z.number().optional(),
  cache_write: z.number().optional(),
  input_audio: z.number().optional(),
  output_audio: z.number().optional(),
  context_over_200k: z
    .object({
      input: z.number(),
      output: z.number(),
      cache_read: z.number().optional(),
      cache_write: z.number().optional(),
    })
    .optional(),
});
const modelLimitsSchema = z.object({ context: z.number(), output: z.number() });
const modelsDevModelSchema = z.object({
  id: z.string(),
  name: z.string(),
  family: z.string().optional(),
  status: z.string().optional(),
  reasoning_options: z
    .array(z.object({ type: z.string(), values: z.array(z.string().nullable()).optional() }))
    .optional(),
  attachment: z.boolean().optional(),
  reasoning: z.boolean().optional(),
  tool_call: z.boolean().optional(),
  temperature: z.boolean().optional(),
  knowledge: z.string().optional(),
  release_date: z.string().optional(),
  last_updated: z.string().optional(),
  modalities: z.object({
    input: z.array(modelModalitySchema),
    output: z.array(modelModalitySchema),
  }),
  open_weights: z.boolean().optional(),
  cost: modelCostSchema.optional(),
  limit: modelLimitsSchema,
});
const modelsDevProviderSchema = z.object({
  id: z.string(),
  env: z.array(z.string()).optional(),
  npm: z.string(),
  name: z.string(),
  doc: z.string().optional(),
  models: z.record(z.string(), modelsDevModelSchema),
});
const modelsDevProviderInfoSchema = modelsDevProviderSchema.omit({ models: true });
const modelsDevRegistrySchema = z.record(z.string(), modelsDevProviderSchema);

export type ModelsDevRegistry = z.output<typeof modelsDevRegistrySchema>;
export type ModelsDevProviderInfo = z.output<typeof modelsDevProviderInfoSchema>;
export type ModelsDevModel = z.output<typeof modelsDevModelSchema>;

export type ModelCatalog = {
  providerIds(): string[];
  provider(id: string): ModelsDevProviderInfo | undefined;
  model(provider: string, id: string): ModelsDevModel | undefined;
  models(provider: string): ModelsDevModel[];
  modelIds(provider: string): string[];
};

export function decodeModelsDevRegistry(value: unknown): ModelsDevRegistry | undefined {
  const parsed = modelsDevRegistrySchema.safeParse(value);
  return parsed.success && Object.keys(parsed.data).length > 0 ? parsed.data : undefined;
}

export function decodeModelsDevProviderInfo(value: unknown): ModelsDevProviderInfo | undefined {
  const parsed = modelsDevProviderInfoSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

export function decodeModelsDevModel(value: unknown): ModelsDevModel | undefined {
  const parsed = modelsDevModelSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

export function registryModelCatalog(registry: ModelsDevRegistry): ModelCatalog {
  return {
    providerIds: () => Object.keys(registry),
    provider: (id) => registry[id],
    model: (provider, id) => registry[provider]?.models[id],
    models: (provider) => Object.values(registry[provider]?.models ?? {}),
    modelIds: (provider) => Object.keys(registry[provider]?.models ?? {}),
  };
}
