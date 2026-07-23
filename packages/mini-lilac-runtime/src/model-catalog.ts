import { open, rename, unlink, type FileHandle } from "node:fs/promises";
import path from "node:path";

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

const modelsDevCacheSchema = z
  .object({
    version: z.literal(1),
    fetchedAt: z.number().int().nonnegative(),
    registry: modelsDevRegistrySchema,
  })
  .strict();

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
  code:
    | "source-fetch-failed"
    | "source-invalid"
    | "provider-not-found"
    | "stale-cache"
    | "cache-invalid"
    | "cache-read-failed"
    | "cache-write-failed";
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
  cacheFilePath?: string;
  requestTimeoutMs?: number;
  maxResponseBytes?: number;
  now?: () => number;
  onWarning?: (warning: ModelCatalogWarning) => void;
  codexOAuthProviderIds?: readonly string[];
};

export type CatalogFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const positiveIntegerSchema = z.number().int().positive();

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
type ModelsDevRegistry = z.infer<typeof modelsDevRegistrySchema>;
type ModelsDevCache = z.infer<typeof modelsDevCacheSchema>;

type ModelsDevProviderError = {
  code: "source-invalid" | "provider-not-found";
  providerId: string;
  message: string;
};

type ModelsDevCatalogResult = {
  models: CatalogModel[];
  errors: ModelsDevProviderError[];
};

function abortError(): DOMException {
  return new DOMException("The operation was aborted", "AbortError");
}

function parseJson(source: string): unknown {
  return JSON.parse(source) as unknown;
}

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
  private readonly cacheFilePath?: string;
  private readonly requestTimeoutMs: number;
  private readonly maxResponseBytes: number;
  private readonly now: () => number;
  private readonly onWarning?: (warning: ModelCatalogWarning) => void;
  private readonly codexOAuthProviderIds: ReadonlySet<string>;
  private cache: ModelCatalogSnapshot | undefined;
  private cacheTime = 0;
  private cacheComplete = false;
  private diskCacheLoaded = false;
  private diskCachePromise: Promise<void> | undefined;
  private pendingWarnings: ModelCatalogWarning[] = [];
  private refreshPromise: Promise<ModelCatalogSnapshot> | undefined;

  constructor(
    private readonly config: ProviderConfig,
    private readonly auth: ProviderAuth,
    options: ModelCatalogOptions = {},
  ) {
    this.fetchFn = options.fetch ?? fetch;
    this.modelsDevUrl = options.modelsDevUrl ?? "https://models.dev/api.json";
    this.cacheTtlMs = options.cacheTtlMs ?? 5 * 60_000;
    this.cacheFilePath = options.cacheFilePath;
    this.requestTimeoutMs = positiveIntegerSchema.parse(
      options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    );
    this.maxResponseBytes = positiveIntegerSchema.parse(
      options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
    );
    this.now = options.now ?? Date.now;
    this.onWarning = options.onWarning;
    this.codexOAuthProviderIds = new Set(options.codexOAuthProviderIds);
  }

  async get(
    options: { forceRefresh?: boolean; backgroundRefresh?: boolean; signal?: AbortSignal } = {},
  ): Promise<ModelCatalogSnapshot> {
    await this.ensureDiskCacheLoaded();
    if (options.backgroundRefresh && !options.signal) {
      const cached = this.cache ?? this.emptySnapshot();
      this.cache ??= cached;
      this.startBackgroundRefresh();
      return cached;
    }
    if (
      !options.forceRefresh &&
      this.cacheComplete &&
      this.cache &&
      this.now() - this.cacheTime < this.cacheTtlMs
    ) {
      return this.cache;
    }
    if (options.signal) {
      return this.refresh(options.signal, true);
    }
    return this.startSharedRefresh();
  }

  clear(): void {
    this.cache = undefined;
    this.cacheTime = 0;
    this.cacheComplete = false;
  }

  private startSharedRefresh(): Promise<ModelCatalogSnapshot> {
    if (!this.refreshPromise) {
      this.refreshPromise = this.refresh(undefined, true).finally(() => {
        this.refreshPromise = undefined;
      });
    }
    return this.refreshPromise;
  }

  private startBackgroundRefresh(): void {
    void this.startSharedRefresh().catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      const warnings: ModelCatalogWarning[] = [];
      for (const [providerId] of Object.entries(this.config.providers)) {
        const warning = {
          code: "source-fetch-failed",
          providerId,
          message: `Background model catalog refresh failed: ${message}`,
        } satisfies ModelCatalogWarning;
        warnings.push(warning);
        this.onWarning?.(warning);
      }
      if (this.cache) {
        this.cache = {
          ...this.cache,
          warnings: [...this.cache.warnings, ...warnings],
          stale: true,
        };
      } else {
        this.pendingWarnings.push(...warnings);
      }
    });
  }

  private emptySnapshot(): ModelCatalogSnapshot {
    return {
      providers: Object.entries(this.config.providers).map(([id, definition]) => ({
        id,
        type: definition.type,
      })),
      models: [],
      warnings: [...this.pendingWarnings],
      fetchedAt: new Date(this.now()),
      stale: true,
    };
  }

  private modelsDevProviders(): [string, ProviderDefinition][] {
    return Object.entries(this.config.providers).filter(
      (entry): entry is [string, ProviderDefinition] => entry[1].catalog === "models-dev",
    );
  }

  private modelsFromModelsDev(registry: ModelsDevRegistry): ModelsDevCatalogResult {
    const models: CatalogModel[] = [];
    const errors: ModelsDevProviderError[] = [];

    for (const [providerId, definition] of this.modelsDevProviders()) {
      const sourceProviderValue = registry[providerId] ?? registry[definition.type];
      if (!sourceProviderValue) {
        errors.push({
          code: "provider-not-found",
          providerId,
          message: `models.dev has no provider matching '${providerId}' or type '${definition.type}'`,
        });
        continue;
      }
      const sourceProvider = modelsDevProviderSchema.safeParse(sourceProviderValue);
      if (!sourceProvider.success) {
        errors.push({
          code: "source-invalid",
          providerId,
          message: `models.dev returned invalid data for provider '${providerId}': ${z.prettifyError(sourceProvider.error)}`,
        });
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
    return { models, errors };
  }

  private async ensureDiskCacheLoaded(): Promise<void> {
    if (this.diskCacheLoaded || !this.cacheFilePath || this.modelsDevProviders().length === 0) {
      this.diskCacheLoaded = true;
      return;
    }
    if (!this.diskCachePromise) {
      this.diskCachePromise = this.loadDiskCache().finally(() => {
        this.diskCacheLoaded = true;
        this.diskCachePromise = undefined;
      });
    }
    await this.diskCachePromise;
  }

  private cacheWarning(code: ModelCatalogWarning["code"], message: string): void {
    for (const [providerId] of this.modelsDevProviders()) {
      const warning = { code, providerId, message } satisfies ModelCatalogWarning;
      this.pendingWarnings.push(warning);
      this.onWarning?.(warning);
    }
  }

  private async loadDiskCache(): Promise<void> {
    if (!this.cacheFilePath) return;
    let source: string;
    try {
      const handle = await open(this.cacheFilePath, "r");
      try {
        const cacheStat = await handle.stat();
        if (!cacheStat.isFile()) throw new Error("cache path is not a regular file");
        if (cacheStat.size > this.maxResponseBytes) {
          throw new Error(`cache exceeded ${this.maxResponseBytes} bytes`);
        }
        const bytes = new Uint8Array(this.maxResponseBytes + 1);
        let offset = 0;
        while (offset < bytes.byteLength) {
          const result = await handle.read(bytes, offset, bytes.byteLength - offset, offset);
          if (result.bytesRead === 0) break;
          offset += result.bytesRead;
        }
        if (offset > this.maxResponseBytes) {
          throw new Error(`cache exceeded ${this.maxResponseBytes} bytes`);
        }
        source = new TextDecoder().decode(bytes.subarray(0, offset));
      } finally {
        await handle.close();
      }
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
      const message = error instanceof Error ? error.message : String(error);
      this.cacheWarning(
        "cache-read-failed",
        `Failed to read models.dev cache '${this.cacheFilePath}': ${message}`,
      );
      return;
    }

    let parsedJson: unknown;
    try {
      parsedJson = parseJson(source);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.cacheWarning(
        "cache-invalid",
        `Ignoring invalid models.dev cache '${this.cacheFilePath}': ${message}`,
      );
      return;
    }
    const parsed = modelsDevCacheSchema.safeParse(parsedJson);
    if (!parsed.success) {
      this.cacheWarning(
        "cache-invalid",
        `Ignoring invalid models.dev cache '${this.cacheFilePath}': ${z.prettifyError(parsed.error)}`,
      );
      return;
    }
    const catalog = this.modelsFromModelsDev(parsed.data.registry);
    if (catalog.errors.length > 0) {
      this.cacheWarning(
        "cache-invalid",
        `Ignoring models.dev cache '${this.cacheFilePath}': ${catalog.errors.map((error) => error.message).join("; ")}`,
      );
      return;
    }

    const stale = this.now() - parsed.data.fetchedAt >= this.cacheTtlMs;
    const warnings: ModelCatalogWarning[] = [];
    if (stale) {
      for (const [providerId] of this.modelsDevProviders()) {
        this.warn(warnings, {
          code: "stale-cache",
          providerId,
          message: `Using stale on-disk model catalog for provider '${providerId}'`,
        });
      }
    }
    catalog.models.sort((left, right) => left.ref.value.localeCompare(right.ref.value));
    this.cache = {
      providers: Object.entries(this.config.providers).map(([id, definition]) => ({
        id,
        type: definition.type,
      })),
      models: catalog.models,
      warnings,
      fetchedAt: new Date(parsed.data.fetchedAt),
      stale,
    };
    this.cacheTime = parsed.data.fetchedAt;
    this.cacheComplete = Object.values(this.config.providers).every(
      (provider) => provider.catalog === "models-dev",
    );
  }

  private async writeDiskCache(cache: ModelsDevCache): Promise<void> {
    if (!this.cacheFilePath) return;
    const temporaryFile = path.join(
      path.dirname(this.cacheFilePath),
      `.${path.basename(this.cacheFilePath)}.${crypto.randomUUID()}.tmp`,
    );
    let handle: FileHandle | undefined;
    let needsCleanup = false;
    try {
      handle = await open(temporaryFile, "wx", 0o600);
      needsCleanup = true;
      await handle.chmod(0o600);
      await handle.writeFile(`${JSON.stringify(cache)}\n`, "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temporaryFile, this.cacheFilePath);
      needsCleanup = false;
    } catch (error) {
      if (handle) {
        try {
          await handle.close();
        } catch {
          // The original write error is more actionable than a secondary close failure.
        }
      }
      if (needsCleanup) {
        try {
          await unlink(temporaryFile);
        } catch {
          // Best effort cleanup; cache replacement never occurred.
        }
      }
      throw error;
    }
  }

  private async fetchJson(
    input: string | URL | Request,
    init: RequestInit,
    externalSignal: AbortSignal | undefined,
  ): Promise<unknown> {
    const controller = new AbortController();
    let rejectCancellation: (reason: Error) => void = () => {};
    const cancellation = new Promise<never>((_resolve, reject) => {
      rejectCancellation = reject;
    });
    const cancelForSignal = () => {
      rejectCancellation(abortError());
      controller.abort();
    };
    if (externalSignal?.aborted) cancelForSignal();
    else externalSignal?.addEventListener("abort", cancelForSignal, { once: true });
    const timer = setTimeout(() => {
      rejectCancellation(new Error(`Request timed out after ${this.requestTimeoutMs}ms`));
      controller.abort();
    }, this.requestTimeoutMs);

    try {
      const response = await Promise.race([
        this.fetchFn(input, { ...init, signal: controller.signal }),
        cancellation,
      ]);
      if (!response.ok) {
        throw new Error(`${response.status} ${response.statusText}`.trim());
      }
      const contentLength = Number(response.headers.get("content-length"));
      if (Number.isFinite(contentLength) && contentLength > this.maxResponseBytes) {
        controller.abort();
        throw new Error(`Response exceeded ${this.maxResponseBytes} bytes`);
      }
      if (!response.body) return parseJson("");

      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let totalBytes = 0;
      try {
        while (true) {
          const result = await Promise.race([reader.read(), cancellation]);
          if (result.done) break;
          totalBytes += result.value.byteLength;
          if (totalBytes > this.maxResponseBytes) {
            controller.abort();
            throw new Error(`Response exceeded ${this.maxResponseBytes} bytes`);
          }
          chunks.push(result.value);
        }
      } finally {
        reader.releaseLock();
      }
      const bytes = new Uint8Array(totalBytes);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return parseJson(new TextDecoder().decode(bytes));
    } finally {
      clearTimeout(timer);
      externalSignal?.removeEventListener("abort", cancelForSignal);
    }
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
    const warnings: ModelCatalogWarning[] = [...this.pendingWarnings];
    const models: CatalogModel[] = [];
    let stale = false;
    const configured = Object.entries(this.config.providers);
    const modelsDevProviders = this.modelsDevProviders();
    let registryForCache: ModelsDevRegistry | undefined;

    if (modelsDevProviders.length > 0) {
      try {
        const registry = modelsDevRegistrySchema.safeParse(
          await this.fetchJson(this.modelsDevUrl, {}, signal),
        );
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
          const catalog = this.modelsFromModelsDev(registry.data);
          models.push(...catalog.models);
          for (const error of catalog.errors) {
            this.warn(warnings, error);
            stale = this.useStale(error.providerId, models, warnings) || stale;
          }
          if (catalog.errors.length === 0) registryForCache = registry.data;
        }
      } catch (error) {
        if (signal?.aborted) throw error;
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
            const parsed = v1ModelsResponseSchema.safeParse(
              await this.fetchJson(
                providerModelsUrl(definition),
                { headers: authHeaders(definition.type, apiKey) },
                signal,
              ),
            );
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
            if (signal?.aborted) throw error;
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

    const fetchedAt = this.now();
    if (registryForCache) {
      try {
        await this.writeDiskCache({ version: 1, fetchedAt, registry: registryForCache });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        for (const [providerId] of modelsDevProviders) {
          this.warn(warnings, {
            code: "cache-write-failed",
            providerId,
            message: `Failed to write models.dev cache '${this.cacheFilePath}': ${message}`,
          });
        }
      }
    }
    models.sort((left, right) => left.ref.value.localeCompare(right.ref.value));
    const snapshot: ModelCatalogSnapshot = {
      providers: configured.map(([id, definition]) => ({ id, type: definition.type })),
      models,
      warnings,
      fetchedAt: new Date(fetchedAt),
      stale,
    };
    this.pendingWarnings = [];
    if (updateCache) {
      this.cache = snapshot;
      this.cacheTime = fetchedAt;
      this.cacheComplete = true;
    }
    return snapshot;
  }
}
