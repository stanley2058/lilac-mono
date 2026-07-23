import { z } from "zod";

import type { ModelCapabilityOverrides } from "@stanley2058/lilac-utils";

import type {
  LoadedProviderRegistry,
  ProviderAuth,
  ProviderConfig,
  ProviderDefinition,
  ProviderModelOverride,
  ProviderType,
} from "./providers";

const modalitySchema = z.enum(["text", "image", "audio", "video", "pdf"]);
export const modelSpecifierSchema = z.string().refine((value) => {
  const slash = value.indexOf("/");
  if (slash <= 0 || slash === value.length - 1) return false;
  const providerId = value.slice(0, slash);
  const modelId = value.slice(slash + 1);
  return (
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(providerId) &&
    modelId.trim() === modelId &&
    modelId.length > 0
  );
}, "expected provider/model");

const modelsDevModelSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1).optional(),
    family: z.string().min(1).optional(),
    attachment: z.boolean().optional(),
    reasoning: z.boolean().optional(),
    tool_call: z.boolean().optional(),
    modalities: z
      .object({
        input: z.array(modalitySchema),
        output: z.array(modalitySchema).optional(),
      })
      .optional(),
    limit: z
      .object({
        context: z.number().nonnegative(),
        output: z.number().nonnegative(),
      })
      .optional(),
  })
  .passthrough();

const modelsDevProviderSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1).optional(),
    models: z.record(z.string(), modelsDevModelSchema),
  })
  .passthrough();

export const modelsDevRegistrySchema = z.record(z.string(), z.unknown());

const v1ModelSchema = z
  .object({
    id: z.string().min(1),
    owned_by: z.string().optional(),
  })
  .passthrough();

export const v1ModelsResponseSchema = z
  .object({
    data: z.array(v1ModelSchema),
  })
  .passthrough();

export type ProviderRef = {
  id: string;
  type: ProviderType;
};

export type ModelRef = {
  providerId: string;
  modelId: string;
  value: `${string}/${string}`;
};

export type CatalogModel = {
  ref: ModelRef;
  provider: ProviderRef;
  source: "models-dev" | "v1";
  name?: string;
  family?: string;
  ownedBy?: string;
  attachment?: boolean;
  reasoning?: boolean;
  toolCall?: boolean;
  modalities?: {
    input: z.infer<typeof modalitySchema>[];
    output?: z.infer<typeof modalitySchema>[];
  };
  limits?: {
    context: number;
    output: number;
  };
};

export type ModelCatalogWarning = {
  code: "source-fetch-failed" | "source-invalid" | "provider-not-found" | "stale-cache";
  providerId: string;
  message: string;
};

export type ModelCatalogSnapshot = {
  providers: ProviderRef[];
  models: CatalogModel[];
  warnings: ModelCatalogWarning[];
  fetchedAt: Date;
  stale: boolean;
};

export type ModelCatalogOptions = {
  fetch?: CatalogFetch;
  modelsDevUrl?: string;
  cacheTtlMs?: number;
  now?: () => number;
  onWarning?: (warning: ModelCatalogWarning) => void;
  codexOAuthProviderIds?: readonly string[];
};

export type CatalogFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

const DEFAULT_BASE_URLS: Record<ProviderType, string> = {
  openai: "https://api.openai.com/v1",
  "openai-compatible": "",
  anthropic: "https://api.anthropic.com/v1",
  xai: "https://api.x.ai/v1",
  openrouter: "https://openrouter.ai/api/v1",
  groq: "https://api.groq.com/openai/v1",
  vercel: "https://ai-gateway.vercel.sh/v1",
};

export function parseModelRef(value: string): ModelRef {
  const parsed = modelSpecifierSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(`Invalid model reference '${value}'; expected provider/model`, {
      cause: parsed.error,
    });
  }
  const slash = parsed.data.indexOf("/");
  const providerId = parsed.data.slice(0, slash);
  const modelId = parsed.data.slice(slash + 1);
  return { providerId, modelId, value: `${providerId}/${modelId}` };
}

export function resolveLanguageModel(value: string, providers: LoadedProviderRegistry) {
  const ref = parseModelRef(value);
  if (!providers.config.providers[ref.providerId]) {
    throw new Error(`Provider '${ref.providerId}' is not configured`);
  }
  return {
    ref,
    model: providers.registry.languageModel(ref.value),
  };
}

function providerModelsUrl(definition: ProviderDefinition): string {
  const baseUrl = definition.baseUrl ?? DEFAULT_BASE_URLS[definition.type];
  const normalized = baseUrl.replace(/\/+$/, "");
  return normalized.endsWith("/v1") ? `${normalized}/models` : `${normalized}/v1/models`;
}

function authHeaders(type: ProviderType, apiKey: string): Headers {
  const headers = new Headers({ accept: "application/json" });
  if (type === "anthropic") {
    headers.set("x-api-key", apiKey);
    headers.set("anthropic-version", "2023-06-01");
  } else {
    headers.set("authorization", `Bearer ${apiKey}`);
  }
  return headers;
}

function modelRef(providerId: string, modelId: string): ModelRef {
  return { providerId, modelId, value: `${providerId}/${modelId}` };
}

function applyModelOverride(
  model: CatalogModel,
  override: ProviderModelOverride | undefined,
): CatalogModel {
  if (override === undefined) return model;
  return {
    ...model,
    ...(override.name === undefined ? {} : { name: override.name }),
    ...(override.family === undefined ? {} : { family: override.family }),
    ...(override.attachment === undefined ? {} : { attachment: override.attachment }),
    ...(override.reasoning === undefined ? {} : { reasoning: override.reasoning }),
    ...(override.toolCall === undefined ? {} : { toolCall: override.toolCall }),
    ...(override.modalities === undefined ? {} : { modalities: override.modalities }),
    ...(override.limit === undefined
      ? {}
      : {
          limits: {
            context: override.limit.context ?? model.limits?.context ?? 0,
            output: override.limit.output ?? model.limits?.output ?? 0,
          },
        }),
  };
}

export function modelCapabilityOverrides(
  snapshot: Pick<ModelCatalogSnapshot, "models">,
): ModelCapabilityOverrides {
  return Object.fromEntries(
    snapshot.models.flatMap((model) =>
      model.limits === undefined
        ? []
        : [
            [
              model.ref.value,
              {
                limit: model.limits,
                ...(model.attachment === undefined ? {} : { attachment: model.attachment }),
                ...(model.modalities === undefined ? {} : { modalities: model.modalities }),
              },
            ] as const,
          ],
    ),
  );
}

type ModelsDevModel = z.infer<typeof modelsDevModelSchema>;

// Codex OAuth exposes only modern conversational coding models, not the full OpenAI API catalog.
function isCodexOAuthModel(model: ModelsDevModel): boolean {
  const match = /^gpt-5\.(\d+)(?:-[a-z0-9][a-z0-9.-]*)?$/.exec(model.id);
  if (!match || Number(match[1]) < 3) return false;
  const input = model.modalities?.input;
  const output = model.modalities?.output;
  return (
    model.tool_call === true &&
    model.reasoning === true &&
    input?.includes("text") === true &&
    output?.includes("text") === true &&
    output.every((modality) => modality === "text")
  );
}

export class ModelCatalog {
  private readonly fetchFn: CatalogFetch;
  private readonly modelsDevUrl: string;
  private readonly cacheTtlMs: number;
  private readonly now: () => number;
  private readonly onWarning?: (warning: ModelCatalogWarning) => void;
  private readonly codexOAuthProviderIds: ReadonlySet<string>;
  private cache: ModelCatalogSnapshot | undefined;
  private cacheTime = 0;
  private refreshPromise: Promise<ModelCatalogSnapshot> | undefined;

  constructor(
    private readonly config: ProviderConfig,
    private readonly auth: ProviderAuth,
    options: ModelCatalogOptions = {},
  ) {
    this.fetchFn = options.fetch ?? fetch;
    this.modelsDevUrl = options.modelsDevUrl ?? "https://models.dev/api.json";
    this.cacheTtlMs = options.cacheTtlMs ?? 5 * 60_000;
    this.now = options.now ?? Date.now;
    this.onWarning = options.onWarning;
    this.codexOAuthProviderIds = new Set(options.codexOAuthProviderIds);
  }

  async get(
    options: { forceRefresh?: boolean; signal?: AbortSignal } = {},
  ): Promise<ModelCatalogSnapshot> {
    if (!options.forceRefresh && this.cache && this.now() - this.cacheTime < this.cacheTtlMs) {
      return this.cache;
    }
    if (options.signal) {
      return this.refresh(options.signal, true);
    }
    if (!this.refreshPromise) {
      this.refreshPromise = this.refresh(undefined, true).finally(() => {
        this.refreshPromise = undefined;
      });
    }
    return this.refreshPromise;
  }

  clear(): void {
    this.cache = undefined;
    this.cacheTime = 0;
  }

  private warn(warnings: ModelCatalogWarning[], warning: ModelCatalogWarning): void {
    warnings.push(warning);
    this.onWarning?.(warning);
  }

  private staleModels(providerId: string): CatalogModel[] {
    return this.cache?.models.filter((model) => model.ref.providerId === providerId) ?? [];
  }

  private useStale(
    providerId: string,
    models: CatalogModel[],
    warnings: ModelCatalogWarning[],
  ): boolean {
    const stale = this.staleModels(providerId);
    if (stale.length === 0) return false;
    models.push(...stale);
    this.warn(warnings, {
      code: "stale-cache",
      providerId,
      message: `Using stale in-memory model catalog for provider '${providerId}'`,
    });
    return true;
  }

  private async refresh(
    signal: AbortSignal | undefined,
    updateCache: boolean,
  ): Promise<ModelCatalogSnapshot> {
    const warnings: ModelCatalogWarning[] = [];
    const models: CatalogModel[] = [];
    let stale = false;
    const configured = Object.entries(this.config.providers);
    const modelsDevProviders = configured.filter(
      ([, provider]) => provider.catalog === "models-dev",
    );

    if (modelsDevProviders.length > 0) {
      try {
        const response = await this.fetchFn(this.modelsDevUrl, { signal });
        if (!response.ok) {
          throw new Error(`${response.status} ${response.statusText}`.trim());
        }
        const registry = modelsDevRegistrySchema.safeParse(await response.json());
        if (!registry.success) {
          for (const [providerId] of modelsDevProviders) {
            this.warn(warnings, {
              code: "source-invalid",
              providerId,
              message: `models.dev returned an invalid registry for provider '${providerId}': ${z.prettifyError(registry.error)}`,
            });
            stale = this.useStale(providerId, models, warnings) || stale;
          }
        } else {
          for (const [providerId, definition] of modelsDevProviders) {
            const sourceProviderValue = registry.data[providerId] ?? registry.data[definition.type];
            if (!sourceProviderValue) {
              this.warn(warnings, {
                code: "provider-not-found",
                providerId,
                message: `models.dev has no provider matching '${providerId}' or type '${definition.type}'`,
              });
              stale = this.useStale(providerId, models, warnings) || stale;
              continue;
            }
            const sourceProvider = modelsDevProviderSchema.safeParse(sourceProviderValue);
            if (!sourceProvider.success) {
              this.warn(warnings, {
                code: "source-invalid",
                providerId,
                message: `models.dev returned invalid data for provider '${providerId}': ${z.prettifyError(sourceProvider.error)}`,
              });
              stale = this.useStale(providerId, models, warnings) || stale;
              continue;
            }
            const entries = Object.values(sourceProvider.data.models).filter(
              (entry) => !this.codexOAuthProviderIds.has(providerId) || isCodexOAuthModel(entry),
            );
            for (const entry of entries) {
              models.push(
                applyModelOverride(
                  {
                    ref: modelRef(providerId, entry.id),
                    provider: { id: providerId, type: definition.type },
                    source: "models-dev",
                    name: entry.name,
                    family: entry.family,
                    attachment: entry.attachment,
                    reasoning: entry.reasoning,
                    toolCall: entry.tool_call,
                    modalities: entry.modalities,
                    limits: entry.limit,
                  },
                  definition.models?.[entry.id],
                ),
              );
            }
          }
        }
      } catch (error) {
        if (signal?.aborted || (error instanceof Error && error.name === "AbortError")) {
          throw error;
        }
        const message = error instanceof Error ? error.message : String(error);
        for (const [providerId] of modelsDevProviders) {
          this.warn(warnings, {
            code: "source-fetch-failed",
            providerId,
            message: `Failed to fetch models.dev catalog for provider '${providerId}': ${message}`,
          });
          stale = this.useStale(providerId, models, warnings) || stale;
        }
      }
    }

    await Promise.all(
      configured
        .filter(([, provider]) => provider.catalog === "v1")
        .map(async ([providerId, definition]) => {
          try {
            const apiKey = this.auth[providerId]?.key;
            if (!apiKey) throw new Error("credentials are missing");
            const response = await this.fetchFn(providerModelsUrl(definition), {
              headers: authHeaders(definition.type, apiKey),
              signal,
            });
            if (!response.ok) {
              throw new Error(`${response.status} ${response.statusText}`.trim());
            }
            const parsed = v1ModelsResponseSchema.safeParse(await response.json());
            if (!parsed.success) {
              this.warn(warnings, {
                code: "source-invalid",
                providerId,
                message: `Provider '${providerId}' returned invalid /v1/models data: ${z.prettifyError(parsed.error)}`,
              });
              stale = this.useStale(providerId, models, warnings) || stale;
              return;
            }
            for (const entry of parsed.data.data) {
              models.push(
                applyModelOverride(
                  {
                    ref: modelRef(providerId, entry.id),
                    provider: { id: providerId, type: definition.type },
                    source: "v1",
                    ownedBy: entry.owned_by,
                  },
                  definition.models?.[entry.id],
                ),
              );
            }
          } catch (error) {
            if (signal?.aborted || (error instanceof Error && error.name === "AbortError")) {
              throw error;
            }
            const message = error instanceof Error ? error.message : String(error);
            this.warn(warnings, {
              code: "source-fetch-failed",
              providerId,
              message: `Failed to fetch /v1/models for provider '${providerId}': ${message}`,
            });
            stale = this.useStale(providerId, models, warnings) || stale;
          }
        }),
    );

    models.sort((left, right) => left.ref.value.localeCompare(right.ref.value));
    const snapshot: ModelCatalogSnapshot = {
      providers: configured.map(([id, definition]) => ({ id, type: definition.type })),
      models,
      warnings,
      fetchedAt: new Date(this.now()),
      stale,
    };
    if (updateCache) {
      this.cache = snapshot;
      this.cacheTime = this.now();
    }
    return snapshot;
  }
}
