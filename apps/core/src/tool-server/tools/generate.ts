import {
  env,
  getModelProviders,
  type CoreConfig,
  type JSONObject,
  type JSONValue,
} from "@stanley2058/lilac-utils";
import {
  experimental_generateVideo as generateVideo,
  generateImage,
  type DataContent,
  type GenerateVideoPrompt,
  type ImageModel,
} from "ai";
import { fileTypeFromBuffer } from "file-type";
import fs from "node:fs/promises";
import { dirname, extname, join } from "node:path";
import { z } from "zod";
import {
  formatToolPathForRequestContext,
  inferExtensionFromMimeType,
  inferMimeTypeFromFilename,
  resolveToolPathForRequestContext,
} from "../../shared/attachment-utils";
import type { RequestContext, ServerTool } from "../types";
import { zodObjectToCliLines } from "./zod-cli";

type SupportedImageModelId =
  /**
   * - Aspect ratio: 1:1, 3:2, 2:3
   * - Sizes: 1024x1024 (1:1); 1536x1024 (3:2 landscape); 1024x1536 (2:3 portrait)
   */
  | "gpt-5-image"
  /**
   * - Aspect ratio: 21:9, 16:9, 3:2, 4:3, 5:4, 1:1, 4:5, 3:4, 2:3, 9:16
   */
  | "nanobanana"
  /**
   * - Provider/slug: openrouter/google/gemini-3.1-flash-image-preview
   * - Aspect ratio: 21:9, 16:9, 3:2, 4:3, 5:4, 1:1, 4:5, 3:4, 2:3, 9:16, 1:4, 4:1, 1:8, 8:1
   * - Supported resolution tiers: 1K, 2K, 4K
   */
  | "nanobanana-2"
  /**
   * - Aspect ratio: 21:9, 16:9, 3:2, 4:3, 5:4, 1:1, 4:5, 3:4, 2:3, 9:16
   * - Supported resolution tiers: 1K, 2K, 4K
   */
  | "nanobanana-pro"
  /**
   * - Aspect ratio: 1:1, 16:9, 9:16, 4:3, 3:4, 3:2, 2:3, 2:1, 1:2, 19.5:9,
   *   9:19.5, 20:9, 9:20
   */
  | "grok-imagine-image"
  /**
   * - Aspect ratio: 1:1, 16:9, 9:16, 4:3, 3:4, 3:2, 2:3, 2:1, 1:2, 19.5:9,
   *   9:19.5, 20:9, 9:20
   */
  | "grok-imagine-image-pro";

type SupportedVideoModelId =
  /**
   * - Modes: text-to-video, image-to-video
   * - Duration: 1-15s
   * - Aspect ratio: 1:1, 16:9, 9:16, 4:3, 3:4, 3:2, 2:3
   * - Resolution: 1280x720, 854x480, 640x480
   */
  "grok-imagine-video";

const GPT_5_IMAGE_ALLOWED_ASPECT_RATIOS = ["1:1", "3:2", "2:3"] as const;
const GPT_5_IMAGE_ALLOWED_SIZES = ["1024x1024", "1536x1024", "1024x1536"] as const;

const NANOBANANA_ALLOWED_ASPECT_RATIOS = [
  "21:9",
  "16:9",
  "3:2",
  "4:3",
  "5:4",
  "1:1",
  "4:5",
  "3:4",
  "2:3",
  "9:16",
] as const;

const NANOBANANA_2_ALLOWED_ASPECT_RATIOS = [
  ...NANOBANANA_ALLOWED_ASPECT_RATIOS,
  "1:4",
  "4:1",
  "1:8",
  "8:1",
] as const;

const GROK_IMAGE_ALLOWED_ASPECT_RATIOS = [
  "1:1",
  "16:9",
  "9:16",
  "4:3",
  "3:4",
  "3:2",
  "2:3",
  "2:1",
  "1:2",
  "19.5:9",
  "9:19.5",
  "20:9",
  "9:20",
] as const;

const DEFAULT_IMAGE_MODEL_FALLBACK_ORDER: readonly SupportedImageModelId[] = [
  "nanobanana-2",
  "nanobanana-pro",
  "gpt-5-image",
  "grok-imagine-image-pro",
  "grok-imagine-image",
  "nanobanana",
];

const GROK_VIDEO_ALLOWED_ASPECT_RATIOS = [
  "1:1",
  "16:9",
  "9:16",
  "4:3",
  "3:4",
  "3:2",
  "2:3",
] as const;
const GROK_VIDEO_ALLOWED_RESOLUTIONS = ["1280x720", "854x480", "640x480"] as const;
const DEFAULT_VIDEO_MODEL_FALLBACK_ORDER: readonly SupportedVideoModelId[] = ["grok-imagine-video"];
const DEFAULT_IMAGE_OUTPUT_BASENAME = "generated-image";

const optionalNonEmptyStringListInputSchema = z
  .union([z.string().min(1), z.array(z.string().min(1)).min(1)])
  .optional()
  .transform((value) => {
    if (value === undefined) return undefined;
    return Array.isArray(value) ? value : [value];
  });

export const imageGenerateInputSchema = z
  .object({
    outputDir: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Optional output directory. Defaults to current working directory. File extension is inferred from returned MIME type.",
      ),

    prompt: z.string().min(1).describe("Text prompt for image generation/editing"),

    inputImages: optionalNonEmptyStringListInputSchema.describe(
      "Optional local input image path(s) for image editing/variations.",
    ),

    maskImage: z
      .string()
      .min(1)
      .optional()
      .describe("Optional local mask image path for inpainting (applies to first input image)."),

    model: z
      .string()
      .min(1)
      .optional()
      .describe("Image model to use. If omitted, picks first configured model in fallback order."),

    size: z
      .string()
      .regex(/^\d+x\d+$/)
      .optional()
      .describe(
        [
          "Optional output size as '{width}x{height}'. (Use only one of --size or --aspect-ratio)",
          "- For gpt-image-2: arbitrary sizes are normalized to 16-pixel multiples and clamped to the provider pixel limit.",
          "- For gpt-5-image: 1024x1024 | 1536x1024 | 1024x1536.",
          "- For nanobanana(-2|-pro): calculate based-on 1K, 2K, 4K. E.g.,",
          "  - 1:1 @ 1K/2K/4K: 1024^2 / 2048^2 / 4096^2",
          "  - 16:9 @ 4K: about 7282 x 4096",
          "  - 9:16 @ 4K: about 4096 x 7282",
        ].join("\n"),
      ),

    aspectRatio: z
      .string()
      .min(1)
      .optional()
      .describe(
        [
          "Optional aspect ratio. (Use only one of --size or --aspect-ratio)",
          "- For gpt-5-image: 1:1 | 3:2 | 2:3.",
          "- For nanobanana/nanobanana-pro: 21:9 | 16:9 | 3:2 | 4:3 | 5:4 | 1:1 | 4:5 | 3:4 | 2:3 | 9:16.",
          "- For nanobanana-2: 21:9 | 16:9 | 3:2 | 4:3 | 5:4 | 1:1 | 4:5 | 3:4 | 2:3 | 9:16 | 1:4 | 4:1 | 1:8 | 8:1.",
          "- For grok-imagine-image(-pro): 1:1 | 16:9 | 9:16 | 4:3 | 3:4 | 3:2 | 2:3 | 2:1 | 1:2 | 19.5:9 | 9:19.5 | 20:9 | 9:20.",
        ].join("\n"),
      ),
  })
  .strict()
  .superRefine((input, ctx) => {
    if (input.size && input.aspectRatio) {
      ctx.addIssue({
        code: "custom",
        message: "Provide only one of size or aspectRatio (not both).",
      });
    }

    if (input.maskImage && (!input.inputImages || input.inputImages.length === 0)) {
      ctx.addIssue({
        code: "custom",
        path: ["maskImage"],
        message: "maskImage requires inputImages.",
      });
    }
  });

export const videoGenerateInputSchema = z.object({
  path: z.string().min(1).describe("Output file path to write the generated video"),

  prompt: z.string().min(1).describe("Text prompt for video generation"),

  inputImage: z
    .string()
    .min(1)
    .optional()
    .describe("Optional local input image path for image-to-video generation."),

  model: z
    .string()
    .min(1)
    .optional()
    .describe("Video model to use. If omitted, picks first configured model in fallback order."),

  aspectRatio: z
    .string()
    .regex(/^\d+(?:\.\d+)?:\d+(?:\.\d+)?$/)
    .optional()
    .describe("Optional output aspect ratio (text-to-video and image-to-video)."),

  resolution: z
    .string()
    .regex(/^\d+x\d+$/)
    .optional()
    .describe("Optional output resolution. For grok-imagine-video: 1280x720 | 854x480 | 640x480."),

  duration: z.coerce
    .number()
    .int()
    .min(1)
    .max(15)
    .optional()
    .describe("Optional duration in seconds. For grok-imagine-video: 1-15."),
});

type ImageGenerateInput = z.infer<typeof imageGenerateInputSchema>;
type VideoGenerateInput = z.infer<typeof videoGenerateInputSchema>;

type ImageGenerationPrompt =
  | string
  | {
      text: string;
      images: DataContent[];
      mask?: DataContent;
    };

type VideoModelObject = Exclude<Parameters<typeof generateVideo>[0]["model"], string>;

type ModelDescriptor<TId extends string, TModel, TInput> = {
  id: TId;
  createModel: (providers: ReturnType<typeof getModelProviders>) => TModel | undefined;
  validateInput: (input: TInput) => void;
};

type ImageModelDescriptor = ModelDescriptor<SupportedImageModelId, ImageModel, ImageGenerateInput>;
type VideoModelDescriptor = ModelDescriptor<
  SupportedVideoModelId,
  VideoModelObject,
  VideoGenerateInput
>;

type ImageProviderId = "openai" | "openai-compatible" | "openrouter" | "xai" | "vercel";

type GenerateOptions = {
  config?: Pick<CoreConfig, "tools">;
  getConfig?: () => Promise<Pick<CoreConfig, "tools">>;
};

type ResolvedImageModel = {
  id: string;
  model: ImageModel;
  validateInput: (input: ImageGenerateInput) => void;
};

type GenerateImageCallOptions = Parameters<typeof generateImage>[0];
type ImageProviderOptions = NonNullable<GenerateImageCallOptions["providerOptions"]>;

type ImageGenerationResolvedParameters = {
  size?: `${number}x${number}`;
  aspectRatio?: `${number}:${number}`;
  maxRetries?: number;
  providerOptions?: ImageProviderOptions;
};

type ImageGenerationParameterWarning = {
  type: "parameter-adjusted";
  parameter: "size" | "aspectRatio";
  from?: string;
  to: string;
  reason: string;
};

// Keep explicit provider/model specs bounded to providers that are already
// wired through the AI SDK and expose image factories. This gives third-party
// URL flexibility without inventing a second HTTP image client in the tool.
const CONFIGURABLE_IMAGE_PROVIDER_IDS = [
  "openai",
  "openai-compatible",
  "openrouter",
  "xai",
  "vercel",
] as const satisfies readonly ImageProviderId[];

const GPT_IMAGE_2_MAX_PIXELS = 8_294_400;
// gpt-image-2 accepts at most 4096px per side; dimensions sent upstream must be 16px multiples.
const GPT_IMAGE_2_MAX_DIMENSION = 4096;
const GPT_IMAGE_2_SIZE_MULTIPLE = 16;
const GPT_IMAGE_2_DEFAULT_PIXELS = 1024 * 1024;

function isImageProviderId(value: string): value is ImageProviderId {
  return (CONFIGURABLE_IMAGE_PROVIDER_IDS as readonly string[]).includes(value);
}

function cloneJson(value: JSONValue): JSONValue {
  if (Array.isArray(value)) return value.map(cloneJson);
  if (value !== null && typeof value === "object") {
    const source = value as Record<string, JSONValue | undefined>;
    const next: Record<string, JSONValue | undefined> = {};
    for (const [key, entry] of Object.entries(source)) {
      next[key] = entry === undefined ? undefined : cloneJson(entry);
    }
    return next;
  }
  return value;
}

function deepMergeJson(base: JSONValue, override: JSONValue): JSONValue {
  if (Array.isArray(base) || Array.isArray(override)) {
    return cloneJson(override);
  }

  if (
    base !== null &&
    typeof base === "object" &&
    override !== null &&
    typeof override === "object"
  ) {
    const baseRecord = base as Record<string, JSONValue | undefined>;
    const overrideRecord = override as Record<string, JSONValue | undefined>;
    const out: Record<string, JSONValue | undefined> = {};

    for (const [key, entry] of Object.entries(baseRecord)) {
      out[key] = entry === undefined ? undefined : cloneJson(entry);
    }

    for (const [key, overrideEntry] of Object.entries(overrideRecord)) {
      if (overrideEntry === undefined) continue;

      const baseEntry = baseRecord[key];
      out[key] =
        baseEntry === undefined
          ? cloneJson(overrideEntry)
          : deepMergeJson(baseEntry, overrideEntry);
    }

    return out;
  }

  return cloneJson(override);
}

function deepMergeObjects(base?: JSONObject, override?: JSONObject): JSONObject | undefined {
  if (!base && !override) return undefined;
  if (!base) return cloneJson(override ?? {}) as JSONObject;
  if (!override) return cloneJson(base) as JSONObject;
  return deepMergeJson(base, override) as JSONObject;
}

const KNOWN_PROVIDER_OPTION_NAMESPACES = new Set(
  CONFIGURABLE_IMAGE_PROVIDER_IDS.flatMap((provider) => {
    const namespace = providerOptionsNamespace(provider);
    return namespace === provider ? [provider] : [provider, namespace];
  }),
);

function looksLikeProviderOptionsMap(obj: JSONObject): boolean {
  const entries = Object.entries(obj);
  if (entries.length === 0) return false;

  for (const [provider, value] of entries) {
    if (!KNOWN_PROVIDER_OPTION_NAMESPACES.has(provider)) return false;
    if (value === undefined) continue;
    if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  }

  return true;
}

function providerOptionsNamespace(provider: string): string {
  if (provider === "openai-compatible" || provider === "openaiCompatible") {
    return "openaiCompatible";
  }
  if (provider === "vercel") return "gateway";
  return provider;
}

function getImageProviderConfig(provider: ImageProviderId): {
  apiKey?: string;
  baseUrl?: string;
} {
  if (provider === "openai-compatible") {
    return env.providers.openaiCompatible;
  }

  return env.providers[provider];
}

function isConfiguredProvider(provider: ImageProviderId): boolean {
  const config = getImageProviderConfig(provider);
  const apiKey = "apiKey" in config ? config.apiKey : undefined;
  const baseUrl = "baseUrl" in config ? config.baseUrl : undefined;

  // The OpenAI-compatible provider has no safe default endpoint. An API key
  // alone cannot identify where image requests should be sent.
  if (provider === "openai-compatible") {
    return Boolean(baseUrl?.trim());
  }

  return Boolean(apiKey?.trim() || baseUrl?.trim());
}

function configuredExplicitImageProviderIds(): ImageProviderId[] {
  return CONFIGURABLE_IMAGE_PROVIDER_IDS.filter((provider) => isConfiguredProvider(provider));
}

function parseProviderModelSpec(spec: string):
  | {
      provider: string;
      modelId: string;
    }
  | undefined {
  // Split only the first slash so upstream model IDs can contain their own
  // namespaces, e.g. openrouter/google/... or openai-compatible/acme/image.
  const separator = spec.indexOf("/");
  if (separator <= 0 || separator === spec.length - 1) return undefined;
  return {
    provider: spec.slice(0, separator),
    modelId: spec.slice(separator + 1),
  };
}

function isReflectable(value: unknown): value is object {
  return (typeof value === "object" && value !== null) || typeof value === "function";
}

function getImageModelProviderNamespace(model: ImageModel, fallbackModelId: string): string {
  if (isReflectable(model) && "provider" in model) {
    const provider = Reflect.get(model, "provider");
    if (typeof provider === "string" && provider.trim().length > 0) {
      return providerOptionsNamespace(provider.split(".")[0] ?? provider);
    }
  }

  const parsed = parseProviderModelSpec(fallbackModelId);
  return providerOptionsNamespace(parsed?.provider ?? "openai-compatible");
}

function normalizeImageProviderOptions(
  options: JSONObject | undefined,
  providerNamespace: string,
): ImageProviderOptions | undefined {
  if (!options || Object.keys(options).length === 0) return undefined;

  const raw = looksLikeProviderOptionsMap(options)
    ? options
    : ({
        [providerNamespace]: options,
      } satisfies JSONObject);

  const normalized: Record<string, JSONObject> = {};
  for (const [provider, value] of Object.entries(raw)) {
    if (value === undefined) continue;
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      normalized[provider] = {};
      continue;
    }
    normalized[provider] = cloneJson(value as JSONValue) as JSONObject;
  }

  return normalized as ImageProviderOptions;
}

function mergeImageProviderOptions(
  base: ImageProviderOptions | undefined,
  override: ImageProviderOptions | undefined,
): ImageProviderOptions | undefined {
  if (!base) return override;
  if (!override) return base;

  let merged: JSONObject | undefined;
  for (const [provider, value] of Object.entries(base)) {
    merged = deepMergeObjects(merged, {
      [provider]: cloneJson(value as JSONValue),
    });
  }
  for (const [provider, value] of Object.entries(override)) {
    merged = deepMergeObjects(merged, {
      [provider]: cloneJson(value as JSONValue),
    });
  }

  return merged as ImageProviderOptions | undefined;
}

function applyParameterDefaults(
  current: ImageGenerationResolvedParameters,
  defaults: CoreConfig["tools"]["generate"]["image"]["defaults"] | undefined,
  providerNamespace: string,
): ImageGenerationResolvedParameters {
  if (!defaults) return current;

  const next: ImageGenerationResolvedParameters = { ...current };
  if (defaults.size) {
    next.size = defaults.size as `${number}x${number}`;
    next.aspectRatio = undefined;
  } else if (defaults.aspectRatio) {
    next.aspectRatio = defaults.aspectRatio as `${number}:${number}`;
    next.size = undefined;
  }

  if (defaults.maxRetries !== undefined) next.maxRetries = defaults.maxRetries;

  next.providerOptions = mergeImageProviderOptions(
    next.providerOptions,
    normalizeImageProviderOptions(defaults.options, providerNamespace),
  );

  return next;
}

export function resolveImageGenerationParameters(params: {
  config: Pick<CoreConfig, "tools"> | undefined;
  modelId: string;
  model: ImageModel;
  input: Pick<ImageGenerateInput, "size" | "aspectRatio">;
}): ImageGenerationResolvedParameters {
  const imageConfig = params.config?.tools.generate.image;
  const providerNamespace = getImageModelProviderNamespace(params.model, params.modelId);
  const profileDefaults = imageConfig?.profiles[params.modelId]?.defaults;

  let resolved = applyParameterDefaults({}, imageConfig?.defaults, providerNamespace);
  resolved = applyParameterDefaults(resolved, profileDefaults, providerNamespace);

  // Caller input wins over config defaults. A caller-supplied size also clears
  // configured aspectRatio, and vice versa, preserving the one-shape-rule.
  if (params.input.size) {
    resolved = {
      ...resolved,
      size: params.input.size as `${number}x${number}`,
      aspectRatio: undefined,
    };
  } else if (params.input.aspectRatio) {
    resolved = {
      ...resolved,
      size: undefined,
      aspectRatio: params.input.aspectRatio as `${number}:${number}`,
    };
  }

  return resolved;
}

function parseSize(value: string): { width: number; height: number } {
  const [widthRaw, heightRaw] = value.split("x");
  const width = Number(widthRaw);
  const height = Number(heightRaw);
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new Error(
      `Invalid image size '${value}'. Expected positive integer size like 1024x1024.`,
    );
  }
  return { width, height };
}

function parseAspectRatio(value: string): { width: number; height: number } {
  const [widthRaw, heightRaw] = value.split(":");
  const width = Number(widthRaw);
  const height = Number(heightRaw);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new Error(`Invalid image aspectRatio '${value}'. Expected positive ratio like 3:4.`);
  }
  return { width, height };
}

function formatSize(width: number, height: number): `${number}x${number}` {
  return `${width}x${height}` as `${number}x${number}`;
}

function floorToMultiple(value: number, multiple: number): number {
  return Math.max(multiple, Math.floor(value / multiple) * multiple);
}

function roundToMultiple(value: number, multiple: number): number {
  return Math.max(multiple, Math.round(value / multiple) * multiple);
}

function clampGptImage2Size(width: number, height: number): `${number}x${number}` {
  if (
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width <= 0 ||
    height <= 0 ||
    width > GPT_IMAGE_2_MAX_DIMENSION ||
    height > GPT_IMAGE_2_MAX_DIMENSION
  ) {
    throw new Error(
      `gpt-image-2 dimensions must be positive finite values no larger than ${GPT_IMAGE_2_MAX_DIMENSION}px per side.`,
    );
  }

  let normalizedWidth = roundToMultiple(width, GPT_IMAGE_2_SIZE_MULTIPLE);
  let normalizedHeight = roundToMultiple(height, GPT_IMAGE_2_SIZE_MULTIPLE);

  if (normalizedWidth * normalizedHeight > GPT_IMAGE_2_MAX_PIXELS) {
    const scale = Math.sqrt(GPT_IMAGE_2_MAX_PIXELS / (normalizedWidth * normalizedHeight));
    normalizedWidth = floorToMultiple(normalizedWidth * scale, GPT_IMAGE_2_SIZE_MULTIPLE);
    normalizedHeight = floorToMultiple(normalizedHeight * scale, GPT_IMAGE_2_SIZE_MULTIPLE);
  }

  return formatSize(normalizedWidth, normalizedHeight);
}

function gptImage2AspectRatioToSize(aspectRatio: string): `${number}x${number}` {
  const ratio = parseAspectRatio(aspectRatio);
  const width = Math.sqrt(GPT_IMAGE_2_DEFAULT_PIXELS * (ratio.width / ratio.height));
  const height = width * (ratio.height / ratio.width);
  return clampGptImage2Size(width, height);
}

function isGptImage2ModelId(modelId: string): boolean {
  const parsed = parseProviderModelSpec(modelId);
  const concreteModelId = parsed?.modelId ?? modelId;
  return concreteModelId.split("/").at(-1) === "gpt-image-2";
}

export function normalizeImageGenerationParametersForModel(params: {
  modelId: string;
  parameters: ImageGenerationResolvedParameters;
}): {
  parameters: ImageGenerationResolvedParameters;
  warnings: ImageGenerationParameterWarning[];
} {
  if (!isGptImage2ModelId(params.modelId)) {
    return { parameters: params.parameters, warnings: [] };
  }

  if (params.parameters.size) {
    const parsed = parseSize(params.parameters.size);
    const normalizedSize = clampGptImage2Size(parsed.width, parsed.height);
    if (normalizedSize === params.parameters.size) {
      return { parameters: params.parameters, warnings: [] };
    }

    return {
      parameters: {
        ...params.parameters,
        size: normalizedSize,
        aspectRatio: undefined,
      },
      warnings: [
        {
          type: "parameter-adjusted",
          parameter: "size",
          from: params.parameters.size,
          to: normalizedSize,
          reason:
            "gpt-image-2 image sizes must use 16-pixel multiples and stay within the provider pixel limit.",
        },
      ],
    };
  }

  if (params.parameters.aspectRatio) {
    const normalizedSize = gptImage2AspectRatioToSize(params.parameters.aspectRatio);
    return {
      parameters: {
        ...params.parameters,
        size: normalizedSize,
        aspectRatio: undefined,
      },
      warnings: [
        {
          type: "parameter-adjusted",
          parameter: "aspectRatio",
          from: params.parameters.aspectRatio,
          to: normalizedSize,
          reason:
            "The OpenAI-compatible gpt-image-2 adapter does not forward aspectRatio, so Lilac converted it to a concrete size.",
        },
      ],
    };
  }

  return { parameters: params.parameters, warnings: [] };
}

type ProviderWithImageModel = {
  imageModel(modelId: string): ImageModel;
};

type ProviderWithImage = {
  image(modelId: string): ImageModel;
};

function hasImageModel(provider: unknown): provider is ProviderWithImageModel {
  return isReflectable(provider) && typeof Reflect.get(provider, "imageModel") === "function";
}

function hasImage(provider: unknown): provider is ProviderWithImage {
  return isReflectable(provider) && typeof Reflect.get(provider, "image") === "function";
}

export function createExplicitProviderImageModel(params: {
  spec: string;
  providers: Record<string, unknown>;
  configuredProviderIds: readonly string[];
}): ImageModel | undefined {
  const parsed = parseProviderModelSpec(params.spec);
  if (!parsed || !isImageProviderId(parsed.provider)) return undefined;
  if (!params.configuredProviderIds.includes(parsed.provider)) return undefined;

  const provider = params.providers[parsed.provider];
  // Prefer imageModel because OpenRouter and OpenAI-compatible expose the
  // provider-neutral AI SDK image interface there. Fall back to image for
  // providers such as OpenAI/xAI that expose that convenience method.
  if (hasImageModel(provider)) {
    return provider.imageModel(parsed.modelId);
  }
  if (hasImage(provider)) {
    return provider.image(parsed.modelId);
  }
  return undefined;
}

function isOneOf<const T extends readonly string[]>(allowed: T, value: string): value is T[number] {
  return (allowed as readonly string[]).includes(value);
}

function validateGptImageInput(input: ImageGenerateInput): void {
  if (input.aspectRatio && !isOneOf(GPT_5_IMAGE_ALLOWED_ASPECT_RATIOS, input.aspectRatio)) {
    throw new Error(
      `Unsupported aspectRatio '${input.aspectRatio}' for gpt-5-image. Allowed: ${GPT_5_IMAGE_ALLOWED_ASPECT_RATIOS.join(", ")}.`,
    );
  }

  if (input.size && !isOneOf(GPT_5_IMAGE_ALLOWED_SIZES, input.size)) {
    throw new Error(
      `Unsupported size '${input.size}' for gpt-5-image. Allowed: ${GPT_5_IMAGE_ALLOWED_SIZES.join(" | ")}.`,
    );
  }
}

function validateNanobananaInput(
  input: ImageGenerateInput,
  modelId: "nanobanana" | "nanobanana-2" | "nanobanana-pro",
): void {
  const allowedAspectRatios =
    modelId === "nanobanana-2"
      ? NANOBANANA_2_ALLOWED_ASPECT_RATIOS
      : NANOBANANA_ALLOWED_ASPECT_RATIOS;

  if (input.aspectRatio && !isOneOf(allowedAspectRatios, input.aspectRatio)) {
    throw new Error(
      `Unsupported aspectRatio '${input.aspectRatio}' for ${modelId}. Allowed: ${allowedAspectRatios.join(", ")}.`,
    );
  }
}

function validateGrokImagineInput(
  input: ImageGenerateInput,
  modelId: "grok-imagine-image" | "grok-imagine-image-pro",
): void {
  if (input.size) {
    throw new Error(`${modelId} does not support size. Use aspectRatio instead.`);
  }

  if (input.aspectRatio && !isOneOf(GROK_IMAGE_ALLOWED_ASPECT_RATIOS, input.aspectRatio)) {
    throw new Error(
      `Unsupported aspectRatio '${input.aspectRatio}' for ${modelId}. Allowed: ${GROK_IMAGE_ALLOWED_ASPECT_RATIOS.join(", ")}.`,
    );
  }

  if (input.maskImage) {
    throw new Error(`${modelId} does not support maskImage.`);
  }

  if ((input.inputImages?.length ?? 0) > 1) {
    throw new Error(`${modelId} supports only one input image.`);
  }
}

const IMAGE_MODEL_DESCRIPTORS: readonly ImageModelDescriptor[] = [
  {
    id: "gpt-5-image",
    createModel: (providers) => {
      if (isConfiguredProvider("openai")) {
        const model = providers.openai?.image("gpt-image-1.5");
        if (model) return model;
      }

      if (isConfiguredProvider("openrouter")) {
        return providers.openrouter?.imageModel("openai/gpt-5-image");
      }

      return undefined;
    },
    validateInput: validateGptImageInput,
  },
  {
    id: "nanobanana",
    createModel: (providers) => {
      if (isConfiguredProvider("openrouter")) {
        return providers.openrouter?.imageModel("google/gemini-2.5-flash-image");
      }
      return undefined;
    },
    validateInput: (input) => validateNanobananaInput(input, "nanobanana"),
  },
  {
    id: "nanobanana-2",
    createModel: (providers) => {
      if (isConfiguredProvider("openrouter")) {
        return providers.openrouter?.imageModel("google/gemini-3.1-flash-image-preview");
      }
      return undefined;
    },
    validateInput: (input) => validateNanobananaInput(input, "nanobanana-2"),
  },
  {
    id: "nanobanana-pro",
    createModel: (providers) => {
      if (isConfiguredProvider("openrouter")) {
        return providers.openrouter?.imageModel("google/gemini-3-pro-image-preview");
      }
      return undefined;
    },
    validateInput: (input) => validateNanobananaInput(input, "nanobanana-pro"),
  },
  {
    id: "grok-imagine-image",
    createModel: (providers) => {
      if (!isConfiguredProvider("xai")) {
        return undefined;
      }
      return providers.xai?.image("grok-imagine-image");
    },
    validateInput: (input) => validateGrokImagineInput(input, "grok-imagine-image"),
  },
  {
    id: "grok-imagine-image-pro",
    createModel: (providers) => {
      if (!isConfiguredProvider("xai")) {
        return undefined;
      }
      return providers.xai?.image("grok-imagine-image-pro");
    },
    validateInput: (input) => validateGrokImagineInput(input, "grok-imagine-image-pro"),
  },
];

// Built-in aliases carry local validation and provider fallback logic. Explicit
// provider/model specs below intentionally skip local capability rules because
// third-party providers often add provider-specific models faster than Lilac can
// encode their size/aspect-ratio matrix.
const IMAGE_MODEL_DESCRIPTOR_BY_ID = new Map<SupportedImageModelId, ImageModelDescriptor>(
  IMAGE_MODEL_DESCRIPTORS.map((descriptor) => [descriptor.id, descriptor]),
);

function validateGrokVideoInput(input: VideoGenerateInput): void {
  if (input.aspectRatio && !isOneOf(GROK_VIDEO_ALLOWED_ASPECT_RATIOS, input.aspectRatio)) {
    throw new Error(
      `Unsupported aspectRatio '${input.aspectRatio}' for grok-imagine-video. Allowed: ${GROK_VIDEO_ALLOWED_ASPECT_RATIOS.join(", ")}.`,
    );
  }

  if (input.resolution && !isOneOf(GROK_VIDEO_ALLOWED_RESOLUTIONS, input.resolution)) {
    throw new Error(
      `Unsupported resolution '${input.resolution}' for grok-imagine-video. Allowed: ${GROK_VIDEO_ALLOWED_RESOLUTIONS.join(", ")}.`,
    );
  }
}

const VIDEO_MODEL_DESCRIPTORS: readonly VideoModelDescriptor[] = [
  {
    id: "grok-imagine-video",
    createModel: (providers) => {
      if (!isConfiguredProvider("xai")) {
        return undefined;
      }

      const xaiProvider = providers.xai;
      if (!xaiProvider || !("video" in xaiProvider)) {
        return undefined;
      }

      const createVideoModel = xaiProvider.video;
      if (typeof createVideoModel !== "function") {
        return undefined;
      }

      return createVideoModel("grok-imagine-video") as VideoModelObject;
    },
    validateInput: validateGrokVideoInput,
  },
];

function resolveAvailableModels<TId extends string, TModel, TInput>(
  descriptors: readonly ModelDescriptor<TId, TModel, TInput>[],
  providers: ReturnType<typeof getModelProviders>,
): {
  available: Partial<Record<TId, TModel>>;
  byId: Map<TId, ModelDescriptor<TId, TModel, TInput>>;
  ids: TId[];
} {
  const available: Partial<Record<TId, TModel>> = {};
  const byId = new Map<TId, ModelDescriptor<TId, TModel, TInput>>();
  const ids: TId[] = [];

  for (const descriptor of descriptors) {
    const model = descriptor.createModel(providers);
    if (!model) continue;
    available[descriptor.id] = model;
    byId.set(descriptor.id, descriptor);
    ids.push(descriptor.id);
  }

  return {
    available,
    byId,
    ids,
  };
}

export function resolveConfiguredImageModelSpecs(
  config: Pick<CoreConfig, "tools"> | undefined,
): readonly string[] {
  const configured = config?.tools.generate.image.models ?? [];
  // Empty config preserves historical behavior: use Lilac's built-in aliases
  // and provider-aware fallback order.
  return configured.length > 0 ? configured : DEFAULT_IMAGE_MODEL_FALLBACK_ORDER;
}

export function canRequestImageModel(params: {
  configuredModelSpecs: readonly string[];
  requested: string;
}): boolean {
  return (
    params.configuredModelSpecs.length === 0 ||
    params.configuredModelSpecs.includes(params.requested)
  );
}

export function resolveAvailableImageModels(params: {
  providers: ReturnType<typeof getModelProviders>;
  modelSpecs: readonly string[];
}): {
  available: ReadonlyMap<string, ImageModel>;
  byId: ReadonlyMap<string, ResolvedImageModel>;
  ids: string[];
} {
  const available = new Map<string, ImageModel>();
  const byId = new Map<string, ResolvedImageModel>();
  const ids: string[] = [];

  for (const spec of params.modelSpecs) {
    // First resolve stable Lilac aliases such as gpt-5-image or nanobanana-2.
    // These aliases can point at different concrete providers while retaining
    // one user-facing model name and local input validation.
    const builtInDescriptor = IMAGE_MODEL_DESCRIPTOR_BY_ID.get(spec as SupportedImageModelId);
    if (builtInDescriptor) {
      const model = builtInDescriptor.createModel(params.providers);
      if (!model) continue;

      available.set(spec, model);
      byId.set(spec, {
        id: spec,
        model,
        validateInput: builtInDescriptor.validateInput,
      });
      ids.push(spec);
      continue;
    }

    // Then resolve direct provider/model specs. This is the escape hatch for
    // third-party image APIs configured via OPENAI_COMPATIBLE_BASE_URL and for
    // operators who want to pin concrete upstream provider model IDs.
    const model = createExplicitProviderImageModel({
      spec,
      providers: params.providers,
      configuredProviderIds: configuredExplicitImageProviderIds(),
    });
    if (!model) continue;

    available.set(spec, model);
    byId.set(spec, {
      id: spec,
      model,
      validateInput: () => {},
    });
    ids.push(spec);
  }

  return {
    available,
    byId,
    ids,
  };
}

function describeImageParameterDefaults(
  defaults: CoreConfig["tools"]["generate"]["image"]["defaults"] | undefined,
): string | undefined {
  if (!defaults) return undefined;

  const parts: string[] = [];
  if (defaults.size) parts.push(`size=${defaults.size}`);
  if (defaults.aspectRatio) parts.push(`aspectRatio=${defaults.aspectRatio}`);
  if (defaults.maxRetries !== undefined) parts.push(`maxRetries=${defaults.maxRetries}`);
  if (defaults.options && Object.keys(defaults.options).length > 0) {
    parts.push("providerOptions=configured");
  }

  return parts.length > 0 ? parts.join(", ") : undefined;
}

function describeImageModelProfiles(
  config: Pick<CoreConfig, "tools"> | undefined,
  modelIds: readonly string[],
): string | undefined {
  const profiles = config?.tools.generate.image.profiles;
  if (!profiles) return undefined;

  const descriptions = modelIds
    .map((id) => {
      const profile = profiles[id];
      if (!profile) return undefined;

      const parts: string[] = [];
      if (profile.useWhen) parts.push(`use when: ${profile.useWhen}`);
      const defaults = describeImageParameterDefaults(profile.defaults);
      if (defaults) parts.push(`defaults: ${defaults}`);
      return parts.length > 0 ? `${id} (${parts.join("; ")})` : undefined;
    })
    .filter((entry): entry is string => entry !== undefined);

  return descriptions.length > 0 ? descriptions.join(" | ") : undefined;
}

async function getAvailableImageModels(options?: GenerateOptions) {
  const providers = getModelProviders();
  const config = await resolveGenerateConfig(options);
  const modelSpecs = resolveConfiguredImageModelSpecs(config);
  return resolveAvailableImageModels({
    providers,
    modelSpecs,
  });
}

async function resolveGenerateConfig(
  options?: GenerateOptions,
): Promise<Pick<CoreConfig, "tools"> | undefined> {
  return options?.config ?? (options?.getConfig ? await options.getConfig() : undefined);
}

function getAvailableVideoModels() {
  const providers = getModelProviders();
  return resolveAvailableModels(VIDEO_MODEL_DESCRIPTORS, providers);
}

function pickModel<TId extends string, TModel>(
  available: Partial<Record<TId, TModel>>,
  requested: string | undefined,
  fallbackOrder: readonly TId[],
  modalityLabel: string,
): { id: TId; model: TModel } {
  if (requested) {
    const model = available[requested as TId];
    if (!model) {
      throw new Error(
        `Requested model '${requested}' is not available for ${modalityLabel} generation (configured: ${Object.keys(available).join(", ") || "none"}).`,
      );
    }

    return {
      id: requested as TId,
      model,
    };
  }

  for (const id of fallbackOrder) {
    const model = available[id];
    if (model) {
      return { id, model };
    }
  }

  throw new Error(
    `No ${modalityLabel} generation models are configured. Configure at least one provider for ${modalityLabel} generation.`,
  );
}

function pickImageModel(params: {
  availableModels: Awaited<ReturnType<typeof getAvailableImageModels>>;
  requested: string | undefined;
  providers: ReturnType<typeof getModelProviders>;
  configuredModelSpecs: readonly string[];
}): ResolvedImageModel {
  if (params.requested) {
    if (
      !canRequestImageModel({
        configuredModelSpecs: params.configuredModelSpecs,
        requested: params.requested,
      })
    ) {
      throw new Error(
        `Requested image model '${params.requested}' is not listed in tools.generate.image.models. Configured image models: ${params.configuredModelSpecs.join(", ") || "none"}.`,
      );
    }

    const configuredModel = params.availableModels.byId.get(params.requested);
    if (configuredModel) return configuredModel;

    // If no image model allowlist is configured, a caller-supplied provider
    // model can still be used as an operator escape hatch.
    const explicitModel = createExplicitProviderImageModel({
      spec: params.requested,
      providers: params.providers,
      configuredProviderIds: configuredExplicitImageProviderIds(),
    });
    if (explicitModel) {
      return {
        id: params.requested,
        model: explicitModel,
        validateInput: () => {},
      };
    }

    const configured = params.availableModels.ids.join(", ") || "none";
    const explicitProviders = configuredExplicitImageProviderIds()
      .map((provider) => `${provider}/<model-id>`)
      .join(", ");
    throw new Error(
      `Requested model '${params.requested}' is not available for image generation (configured defaults: ${configured}; explicit providers: ${explicitProviders || "none"}).`,
    );
  }

  const first = params.availableModels.ids[0];
  if (first) {
    const model = params.availableModels.byId.get(first);
    if (model) return model;
  }

  const explicitProviders = configuredExplicitImageProviderIds()
    .map((provider) => `${provider}/<model-id>`)
    .join(", ");

  // If a generic provider is configured but no default image model is named,
  // keep the tool discoverable while requiring the caller to choose a model.
  if (explicitProviders) {
    throw new Error(
      `No default image generation model is configured. Set tools.generate.image.models or pass model as one of: ${explicitProviders}.`,
    );
  }

  throw new Error(
    "No image generation models are configured. Configure an image provider or set tools.generate.image.models.",
  );
}

function gptAspectRatioToSize(
  aspectRatio: (typeof GPT_5_IMAGE_ALLOWED_ASPECT_RATIOS)[number],
): (typeof GPT_5_IMAGE_ALLOWED_SIZES)[number] {
  switch (aspectRatio) {
    case "1:1":
      return "1024x1024";
    case "3:2":
      return "1536x1024";
    case "2:3":
      return "1024x1536";
  }
}

function looksLikeSvg(bytes: Buffer): boolean {
  const prefix = bytes.subarray(0, 1024).toString("utf8").trimStart().toLowerCase();
  return prefix.startsWith("<svg") || prefix.startsWith("<?xml");
}

async function readImageDataFromPath(path: string, displayPath = path): Promise<Buffer> {
  const bytes = await fs.readFile(path);
  const typeFromBytes = await fileTypeFromBuffer(bytes);

  if (typeFromBytes?.mime?.startsWith("image/")) {
    return bytes;
  }

  const mimeFromExtension = inferMimeTypeFromFilename(path);
  if (mimeFromExtension === "image/svg+xml" && looksLikeSvg(bytes)) {
    return bytes;
  }

  throw new Error(`Input file '${displayPath}' is not a valid image file.`);
}

export async function resolveImageEditInputs(
  cwd: string,
  input: {
    inputImages?: readonly string[];
    maskImage?: string;
  },
  context?: RequestContext,
): Promise<
  | {
      images: DataContent[];
      mask?: DataContent;
    }
  | undefined
> {
  if (!input.inputImages || input.inputImages.length === 0) {
    return undefined;
  }

  const images: DataContent[] = [];

  for (const imagePath of input.inputImages) {
    const resolved = resolveToolPathForRequestContext({ cwd, inputPath: imagePath, context });
    images.push(
      await readImageDataFromPath(
        resolved,
        formatToolPathForRequestContext({ path: resolved, context }),
      ),
    );
  }

  if (!input.maskImage) {
    return { images };
  }

  const resolvedMask = resolveToolPathForRequestContext({
    cwd,
    inputPath: input.maskImage,
    context,
  });
  const mask = await readImageDataFromPath(
    resolvedMask,
    formatToolPathForRequestContext({ path: resolvedMask, context }),
  );
  return { images, mask };
}

export async function buildImageGenerationPrompt(
  cwd: string,
  input: {
    prompt: string;
    inputImages?: readonly string[];
    maskImage?: string;
  },
  context?: RequestContext,
): Promise<ImageGenerationPrompt> {
  const editInputs = await resolveImageEditInputs(
    cwd,
    {
      inputImages: input.inputImages,
      maskImage: input.maskImage,
    },
    context,
  );

  if (!editInputs) {
    return input.prompt;
  }

  return {
    text: input.prompt,
    images: editInputs.images,
    mask: editInputs.mask,
  };
}

export async function buildVideoGenerationPrompt(
  cwd: string,
  input: {
    prompt: string;
    inputImage?: string;
  },
  context?: RequestContext,
): Promise<GenerateVideoPrompt> {
  if (!input.inputImage) {
    return input.prompt;
  }

  const resolvedImage = resolveToolPathForRequestContext({
    cwd,
    inputPath: input.inputImage,
    context,
  });
  const image = await readImageDataFromPath(
    resolvedImage,
    formatToolPathForRequestContext({ path: resolvedImage, context }),
  );
  return {
    text: input.prompt,
    image,
  };
}

async function writeFileWithUniqueName(targetPath: string, bytes: Uint8Array): Promise<string> {
  const ext = extname(targetPath);
  const base = ext ? targetPath.slice(0, -ext.length) : targetPath;

  for (let i = 0; i < 10_000; i++) {
    const candidate = i === 0 ? targetPath : `${base} (${i})${ext}`;
    try {
      await fs.writeFile(candidate, bytes, { flag: "wx" });
      return candidate;
    } catch (error) {
      const code =
        typeof error === "object" && error !== null && "code" in error
          ? (error.code as string | undefined)
          : undefined;
      if (code === "EEXIST") {
        continue;
      }
      throw error;
    }
  }

  throw new Error(`Failed to find an available filename for: ${targetPath}`);
}

export function generateImageWithModel(
  model: ImageModel,
  prompt: ImageGenerationPrompt,
  opts?: {
    abortSignal?: AbortSignal;
    size?: `${number}x${number}`;
    aspectRatio?: `${number}:${number}`;
    maxRetries?: number;
    providerOptions?: ImageProviderOptions;
  },
) {
  return generateImage({
    model,
    prompt,
    abortSignal: opts?.abortSignal,
    size: opts?.size,
    aspectRatio: opts?.aspectRatio,
    maxRetries: opts?.maxRetries,
    providerOptions: opts?.providerOptions,
  });
}

export function generateVideoWithModel(
  model: VideoModelObject,
  prompt: GenerateVideoPrompt,
  opts?: {
    abortSignal?: AbortSignal;
    aspectRatio?: `${number}:${number}`;
    resolution?: `${number}x${number}`;
    duration?: number;
  },
) {
  return generateVideo({
    model,
    prompt,
    abortSignal: opts?.abortSignal,
    aspectRatio: opts?.aspectRatio,
    resolution: opts?.resolution,
    duration: opts?.duration,
  });
}

export class Generate implements ServerTool {
  id = "generate";

  constructor(private readonly options: GenerateOptions = {}) {}

  async init(): Promise<void> {}
  async destroy(): Promise<void> {}

  async list() {
    const config = await resolveGenerateConfig(this.options);
    const imageModels = (
      await getAvailableImageModels({
        ...this.options,
        config,
      })
    ).ids;
    const explicitImageProviders = configuredExplicitImageProviderIds();
    const configuredImageModelSpecs = config?.tools.generate.image.models ?? [];
    const videoModels = getAvailableVideoModels().ids;
    const tools = [];

    if (imageModels.length > 0 || explicitImageProviders.length > 0) {
      // A configured explicit provider is enough to advertise generate.image:
      // the tool description tells agents how to pass provider/model manually
      // even when the operator has not selected a default model.
      const explicitProviderSpecs =
        configuredImageModelSpecs.length > 0
          ? configuredImageModelSpecs
          : explicitImageProviders.map((provider) => `${provider}/<model-id>`);
      const globalDefaults = describeImageParameterDefaults(config?.tools.generate.image.defaults);
      const modelProfiles = describeImageModelProfiles(config, imageModels);
      tools.push({
        callableId: "generate.image",
        name: "Generate Image",
        description:
          "Generate or edit an image with a configured provider and write it to a local file in outputDir (or cwd). Returns absolute output path + MIME type. " +
          `Default models: ${imageModels.join(", ") || "none"}. ` +
          `Explicit model specs: ${explicitProviderSpecs.join(", ") || "none"}. ` +
          `Global defaults: ${globalDefaults || "none"}. ` +
          `Model profiles: ${modelProfiles || "none"}`,
        shortInput: zodObjectToCliLines(imageGenerateInputSchema, {
          mode: "required",
        }),
        input: zodObjectToCliLines(imageGenerateInputSchema),
        primaryPositional: {
          field: "prompt",
        },
      });
    }

    if (videoModels.length > 0) {
      tools.push({
        callableId: "generate.video",
        name: "Generate Video",
        description:
          "Generate a video with a configured provider and write it to a local file. " +
          `Available models: ${videoModels.join(", ")}`,
        shortInput: zodObjectToCliLines(videoGenerateInputSchema, {
          mode: "required",
        }),
        input: zodObjectToCliLines(videoGenerateInputSchema),
      });
    }

    return tools;
  }

  async call(
    callableId: string,
    input: Record<string, unknown>,
    opts?: {
      signal?: AbortSignal;
      context?: RequestContext;
      messages?: readonly unknown[];
    },
  ): Promise<unknown> {
    if (callableId === "generate.image") {
      return await this.callGenerateImage(input, opts);
    }

    if (callableId === "generate.video") {
      return await this.callGenerateVideo(input, opts);
    }

    throw new Error(`Invalid callable ID '${callableId}'`);
  }

  private async callGenerateImage(
    input: Record<string, unknown>,
    opts?: {
      signal?: AbortSignal;
      context?: RequestContext;
    },
  ): Promise<unknown> {
    const payload = imageGenerateInputSchema.parse(input);
    const providers = getModelProviders();
    const config = await resolveGenerateConfig(this.options);
    const availableModels = await getAvailableImageModels({
      ...this.options,
      config,
    });
    const picked = pickImageModel({
      availableModels,
      requested: payload.model,
      providers,
      configuredModelSpecs: config?.tools.generate.image.models ?? [],
    });

    const resolvedGenerationParameters = resolveImageGenerationParameters({
      config,
      modelId: picked.id,
      model: picked.model,
      input: payload,
    });
    const generationParameterNormalization = normalizeImageGenerationParametersForModel({
      modelId: picked.id,
      parameters: resolvedGenerationParameters,
    });
    const generationParameters = generationParameterNormalization.parameters;
    picked.validateInput({
      ...payload,
      size: generationParameters.size,
      aspectRatio: generationParameters.aspectRatio,
    });

    const cwd = opts?.context?.cwd ?? process.cwd();
    const resolvedOutputDir = resolveToolPathForRequestContext({
      cwd,
      inputPath: payload.outputDir ?? (opts?.context?.safetyMode === "restricted" ? "/tmp" : "."),
      context: opts?.context,
    });

    const size =
      generationParameters.size && generationParameters.size.length > 0
        ? generationParameters.size
        : picked.id === "gpt-5-image" && generationParameters.aspectRatio
          ? (gptAspectRatioToSize(
              generationParameters.aspectRatio as (typeof GPT_5_IMAGE_ALLOWED_ASPECT_RATIOS)[number],
            ) as `${number}x${number}`)
          : undefined;

    const aspectRatio =
      !size && generationParameters.aspectRatio ? generationParameters.aspectRatio : undefined;
    const prompt = await buildImageGenerationPrompt(cwd, payload, opts?.context);

    const res = await generateImageWithModel(picked.model, prompt, {
      abortSignal: opts?.signal,
      size,
      aspectRatio,
      maxRetries: generationParameters.maxRetries,
      providerOptions: generationParameters.providerOptions,
    });

    const image = res.image;
    const inferredExt = inferExtensionFromMimeType(image.mediaType) || ".png";
    const targetWithExt = join(resolvedOutputDir, `${DEFAULT_IMAGE_OUTPUT_BASENAME}${inferredExt}`);

    await fs.mkdir(dirname(targetWithExt), { recursive: true });
    const outPath = await writeFileWithUniqueName(targetWithExt, image.uint8Array);

    return {
      ok: true as const,
      path: formatToolPathForRequestContext({ path: outPath, context: opts?.context }),
      bytes: image.uint8Array.byteLength,
      mimeType: image.mediaType,
      model: picked.id,
      warnings: [...generationParameterNormalization.warnings, ...res.warnings],
    };
  }

  private async callGenerateVideo(
    input: Record<string, unknown>,
    opts?: {
      signal?: AbortSignal;
      context?: RequestContext;
    },
  ): Promise<unknown> {
    const payload = videoGenerateInputSchema.parse(input);
    const availableModels = getAvailableVideoModels();
    const picked = pickModel(
      availableModels.available,
      payload.model,
      DEFAULT_VIDEO_MODEL_FALLBACK_ORDER,
      "video",
    );

    const descriptor = availableModels.byId.get(picked.id);
    if (!descriptor) {
      throw new Error(`Model descriptor not found for '${picked.id}'.`);
    }
    descriptor.validateInput(payload);

    const cwd = opts?.context?.cwd ?? process.cwd();
    const resolvedTarget = resolveToolPathForRequestContext({
      cwd,
      inputPath: payload.path,
      context: opts?.context,
    });

    const prompt = await buildVideoGenerationPrompt(
      cwd,
      {
        prompt: payload.prompt,
        inputImage: payload.inputImage,
      },
      opts?.context,
    );

    const res = await generateVideoWithModel(picked.model, prompt, {
      abortSignal: opts?.signal,
      aspectRatio: payload.aspectRatio as `${number}:${number}` | undefined,
      resolution: payload.resolution as `${number}x${number}` | undefined,
      duration: payload.duration,
    });

    const video = res.video;
    const originalExt = extname(resolvedTarget);
    const inferredExt = inferExtensionFromMimeType(video.mediaType) || ".mp4";
    const targetWithExt =
      originalExt.length > 0 ? resolvedTarget : `${resolvedTarget}${inferredExt}`;

    await fs.mkdir(dirname(targetWithExt), { recursive: true });
    const outPath = await writeFileWithUniqueName(targetWithExt, video.uint8Array);

    return {
      ok: true as const,
      path: formatToolPathForRequestContext({ path: outPath, context: opts?.context }),
      bytes: video.uint8Array.byteLength,
      mimeType: video.mediaType,
      model: picked.id,
      warnings: res.warnings,
      providerMetadata: res.providerMetadata,
    };
  }
}
