import { env, getModelProviders } from "@stanley2058/lilac-utils";
import {
  experimental_generateVideo as generateVideo,
  generateImage,
  type DataContent,
  type GenerateVideoPrompt,
  type ImageModel,
} from "ai";
import { fileTypeFromBuffer } from "file-type/core";
import fs from "node:fs/promises";
import { dirname, extname } from "node:path";
import { z } from "zod";
import {
  inferExtensionFromMimeType,
  inferMimeTypeFromFilename,
  resolveToolPath,
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

const optionalNonEmptyStringListInputSchema = z
  .union([z.string().min(1), z.array(z.string().min(1)).min(1)])
  .optional()
  .transform((value) => {
    if (value === undefined) return undefined;
    return Array.isArray(value) ? value : [value];
  });

export const imageGenerateInputSchema = z
  .object({
    path: z.string().min(1).describe("Output file path to write the generated image"),

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
          "- For gpt-5-image: 1024x1024 | 1536x1024 | 1024x1536.",
          "- For nanobanana(-pro): calculate based-on 1K, 2K, 4K. E.g.,",
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
          "- For nanobanana(-pro): 21:9 | 16:9 | 3:2 | 4:3 | 5:4 | 1:1 | 4:5 | 3:4 | 2:3 | 9:16.",
          "- For grok-imagine-image(-pro): 1:1 | 16:9 | 9:16 | 4:3 | 3:4 | 3:2 | 2:3 | 2:1 | 1:2 | 19.5:9 | 9:19.5 | 20:9 | 9:20.",
        ].join("\n"),
      ),
  })
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

  duration: z
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

function isConfiguredProvider(provider: "openai" | "openrouter" | "xai" | "vercel"): boolean {
  const config = env.providers[provider];
  const apiKey = "apiKey" in config ? config.apiKey : undefined;
  const baseUrl = "baseUrl" in config ? config.baseUrl : undefined;
  return Boolean(apiKey?.trim() || baseUrl?.trim());
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
  modelId: "nanobanana" | "nanobanana-pro",
): void {
  if (input.aspectRatio && !isOneOf(NANOBANANA_ALLOWED_ASPECT_RATIOS, input.aspectRatio)) {
    throw new Error(
      `Unsupported aspectRatio '${input.aspectRatio}' for ${modelId}. Allowed: ${NANOBANANA_ALLOWED_ASPECT_RATIOS.join(", ")}.`,
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

function getAvailableImageModels() {
  const providers = getModelProviders();
  return resolveAvailableModels(IMAGE_MODEL_DESCRIPTORS, providers);
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

async function readImageDataFromPath(path: string): Promise<Buffer> {
  const bytes = await fs.readFile(path);
  const typeFromBytes = await fileTypeFromBuffer(bytes);

  if (typeFromBytes?.mime?.startsWith("image/")) {
    return bytes;
  }

  const mimeFromExtension = inferMimeTypeFromFilename(path);
  if (mimeFromExtension === "image/svg+xml" && looksLikeSvg(bytes)) {
    return bytes;
  }

  throw new Error(`Input file '${path}' is not a valid image file.`);
}

export async function resolveImageEditInputs(
  cwd: string,
  input: {
    inputImages?: readonly string[];
    maskImage?: string;
  },
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
    const resolved = resolveToolPath(cwd, imagePath);
    images.push(await readImageDataFromPath(resolved));
  }

  if (!input.maskImage) {
    return { images };
  }

  const resolvedMask = resolveToolPath(cwd, input.maskImage);
  const mask = await readImageDataFromPath(resolvedMask);
  return { images, mask };
}

export async function buildImageGenerationPrompt(
  cwd: string,
  input: {
    prompt: string;
    inputImages?: readonly string[];
    maskImage?: string;
  },
): Promise<ImageGenerationPrompt> {
  const editInputs = await resolveImageEditInputs(cwd, {
    inputImages: input.inputImages,
    maskImage: input.maskImage,
  });

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
): Promise<GenerateVideoPrompt> {
  if (!input.inputImage) {
    return input.prompt;
  }

  const resolvedImage = resolveToolPath(cwd, input.inputImage);
  const image = await readImageDataFromPath(resolvedImage);
  return {
    text: input.prompt,
    image,
  };
}

async function pathExists(p: string): Promise<boolean> {
  return await fs
    .access(p)
    .then(() => true)
    .catch(() => false);
}

async function pickAvailableFilename(targetPath: string): Promise<string> {
  if (!(await pathExists(targetPath))) return targetPath;

  const ext = extname(targetPath);
  const base = ext ? targetPath.slice(0, -ext.length) : targetPath;

  for (let i = 1; i < 10_000; i++) {
    const next = `${base} (${i})${ext}`;
    if (!(await pathExists(next))) return next;
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
  },
) {
  return generateImage({
    model,
    prompt,
    abortSignal: opts?.abortSignal,
    size: opts?.size,
    aspectRatio: opts?.aspectRatio,
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

  async init(): Promise<void> {}
  async destroy(): Promise<void> {}

  async list() {
    const imageModels = getAvailableImageModels().ids;
    const videoModels = getAvailableVideoModels().ids;
    const tools = [];

    if (imageModels.length > 0) {
      tools.push({
        callableId: "generate.image",
        name: "Generate Image",
        description:
          "Generate or edit an image with a configured provider and write it to a local file. " +
          `Available models: ${imageModels.join(", ")}`,
        shortInput: zodObjectToCliLines(imageGenerateInputSchema, {
          mode: "required",
        }),
        input: zodObjectToCliLines(imageGenerateInputSchema),
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
    const availableModels = getAvailableImageModels();
    const picked = pickModel(
      availableModels.available,
      payload.model,
      DEFAULT_IMAGE_MODEL_FALLBACK_ORDER,
      "image",
    );

    const descriptor = availableModels.byId.get(picked.id);
    if (!descriptor) {
      throw new Error(`Model descriptor not found for '${picked.id}'.`);
    }
    descriptor.validateInput(payload);

    const cwd = opts?.context?.cwd ?? process.cwd();
    const resolvedTarget = resolveToolPath(cwd, payload.path);

    const size =
      payload.size && payload.size.length > 0
        ? (payload.size as `${number}x${number}`)
        : picked.id === "gpt-5-image" && payload.aspectRatio
          ? (gptAspectRatioToSize(
              payload.aspectRatio as (typeof GPT_5_IMAGE_ALLOWED_ASPECT_RATIOS)[number],
            ) as `${number}x${number}`)
          : undefined;

    const aspectRatio =
      !payload.size && payload.aspectRatio
        ? (payload.aspectRatio as `${number}:${number}`)
        : undefined;
    const prompt = await buildImageGenerationPrompt(cwd, payload);

    const res = await generateImageWithModel(picked.model, prompt, {
      abortSignal: opts?.signal,
      size,
      aspectRatio,
    });

    const image = res.image;
    const originalExt = extname(resolvedTarget);
    const inferredExt = inferExtensionFromMimeType(image.mediaType) || ".png";
    const targetWithExt =
      originalExt.length > 0 ? resolvedTarget : `${resolvedTarget}${inferredExt}`;

    const outPath = await pickAvailableFilename(targetWithExt);
    await fs.mkdir(dirname(outPath), { recursive: true });
    await fs.writeFile(outPath, image.uint8Array);

    return {
      ok: true as const,
      path: outPath,
      bytes: image.uint8Array.byteLength,
      mimeType: image.mediaType,
      model: picked.id,
      warnings: res.warnings,
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
    const resolvedTarget = resolveToolPath(cwd, payload.path);

    const prompt = await buildVideoGenerationPrompt(cwd, {
      prompt: payload.prompt,
      inputImage: payload.inputImage,
    });

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

    const outPath = await pickAvailableFilename(targetWithExt);
    await fs.mkdir(dirname(outPath), { recursive: true });
    await fs.writeFile(outPath, video.uint8Array);

    return {
      ok: true as const,
      path: outPath,
      bytes: video.uint8Array.byteLength,
      mimeType: video.mediaType,
      model: picked.id,
      warnings: res.warnings,
      providerMetadata: res.providerMetadata,
    };
  }
}
