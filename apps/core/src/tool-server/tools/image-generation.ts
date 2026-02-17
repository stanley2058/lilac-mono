import { getModelProviders } from "@stanley2058/lilac-utils";
import { generateImage, type DataContent, type ImageModel } from "ai";
import { z } from "zod";
import { fileTypeFromBuffer } from "file-type/core";
import fs from "node:fs/promises";
import { dirname, extname } from "node:path";
import type { RequestContext, ServerTool } from "../types";
import { zodObjectToCliLines } from "./zod-cli";
import {
  inferExtensionFromMimeType,
  inferMimeTypeFromFilename,
  resolveToolPath,
} from "../../shared/attachment-utils";

type SupportedImageModels =
  /**
   * - Aspect ratio: 1:1, 3:2, 2:3
   * - Sizes: 1024×1024 (1:1); 1536×1024 (3:2 landscape); 1024×1536 (2:3 portrait)
   */
  | "gpt-5-image"
  /**
   * - Aspect ratio: 21:9, 16:9, 3:2, 4:3, 5:4, 1:1, 4:5, 3:4, 2:3, 9:16
   */
  | "nanobanana"
  /**
   * - Aspect ratio: 21:9, 16:9, 3:2, 4:3, 5:4, 1:1, 4:5, 3:4, 2:3, 9:16
   * - Supported resolution tiers: 1K, 2K, 4K
   * - Sizes:
   *   - 1:1 @ 1K/2K/4K: 1024² / 2048² / 4096²
   *   - 16:9 @ 4K: ≈ 7282 × 4096 (short side 4096)
   *   - 9:16 @ 4K: ≈ 4096 × 7282
   */
  | "nanobanana-pro";

export function getSupportedModels() {
  const providers = getModelProviders();

  const models = {
    "gpt-5-image": {
      openai: providers.openai?.image("gpt-image-1.5"),
      openrouter: providers.openrouter?.imageModel("openai/gpt-5-image"),
    },
    nanobanana: {
      vercel: undefined, // providers.vercel?.imageModel("google/gemini-2.5-flash-image"),
      openrouter: providers.openrouter?.imageModel("google/gemini-2.5-flash-image"),
    },
    "nanobanana-pro": {
      vercel: undefined, // providers.vercel?.imageModel("google/gemini-3-pro-image"),
      openrouter: providers.openrouter?.imageModel("google/gemini-3-pro-image-preview"),
    },
  } satisfies Record<SupportedImageModels, Partial<Record<string, ImageModel>>>;

  const available = Object.fromEntries(
    Object.entries({
      "gpt-5-image": models["gpt-5-image"].openai ?? models["gpt-5-image"].openrouter,
      nanobanana: models.nanobanana.vercel ?? models.nanobanana.openrouter,
      "nanobanana-pro": models["nanobanana-pro"].vercel ?? models["nanobanana-pro"].openrouter,
    }).filter(([_, v]) => !!v),
  ) as Partial<Record<SupportedImageModels, ImageModel>>;

  return available;
}

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

const DEFAULT_MODEL_FALLBACK_ORDER: SupportedImageModels[] = [
  "nanobanana-pro",
  "gpt-5-image",
  "nanobanana",
];

const optionalNonEmptyStringListInputSchema = z
  .union([z.string().min(1), z.array(z.string().min(1)).min(1)])
  .optional()
  .transform((value) => {
    if (value === undefined) return undefined;
    return Array.isArray(value) ? value : [value];
  });

function isOneOf<const T extends readonly string[]>(allowed: T, value: string): value is T[number] {
  return (allowed as readonly string[]).includes(value);
}

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
      .enum(["gpt-5-image", "nanobanana", "nanobanana-pro"])
      .optional()
      .describe("Image model to use. If omitted, defaults to `nanobanana-pro`."),

    size: z
      .string()
      .regex(/^\d+x\d+$/)
      .optional()
      .describe(
        [
          "Optional output size as '{width}x{height}'. (Use only one of --size or --aspect-ratio)",
          "- For gpt-5-image: 1024x1024 | 1536x1024 | 1024x1536.",
          "- For nanobanana(-pro): calculate based-on 1K, 2K, 4K. E.g.,",
          "  - 1:1 @ 1K/2K/4K: 1024² / 2048² / 4096²",
          "  - 16:9 @ 4K: ≈ 7282 × 4096 (short side 4096)",
          "  - 9:16 @ 4K: ≈ 4096 × 7282",
        ].join("\n"),
      ),

    aspectRatio: z
      .string()
      .regex(/^\d+:\d+$/)
      .optional()
      .describe(
        [
          "Optional aspect ratio as '{width}:{height}'. (Use only one of --size or --aspect-ratio)",
          "- For gpt-5-image: 1:1 | 3:2 | 2:3.",
          "- For nanobanana(-pro): 21:9 | 16:9 | 3:2 | 4:3 | 5:4 | 1:1 | 4:5 | 3:4 | 2:3 | 9:16.",
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

type ImageGenerateInput = z.infer<typeof imageGenerateInputSchema>;
type ImageGenerationPrompt =
  | string
  | {
      text: string;
      images: DataContent[];
      mask?: DataContent;
    };

function pickModel(
  available: Partial<Record<SupportedImageModels, ImageModel>>,
  requested?: SupportedImageModels,
): { id: SupportedImageModels; model: ImageModel } {
  if (requested) {
    const model = available[requested];
    if (!model) {
      throw new Error(
        `Requested model '${requested}' is not available (configured: ${Object.keys(available).join(", ") || "none"}).`,
      );
    }
    return { id: requested, model };
  }

  for (const id of DEFAULT_MODEL_FALLBACK_ORDER) {
    const model = available[id];
    if (model) return { id, model };
  }

  throw new Error(
    "No image providers configured. Configure at least one provider (vercel/openai/openrouter) so an image model is available.",
  );
}

function validateSettingsForModel(input: ImageGenerateInput, modelId: SupportedImageModels) {
  if (input.aspectRatio) {
    if (modelId === "gpt-5-image") {
      if (!isOneOf(GPT_5_IMAGE_ALLOWED_ASPECT_RATIOS, input.aspectRatio)) {
        throw new Error(
          `Unsupported aspectRatio '${input.aspectRatio}' for gpt-5-image. Allowed: ${GPT_5_IMAGE_ALLOWED_ASPECT_RATIOS.join(", ")}.`,
        );
      }
      return;
    }

    if (!isOneOf(NANOBANANA_ALLOWED_ASPECT_RATIOS, input.aspectRatio)) {
      throw new Error(
        `Unsupported aspectRatio '${input.aspectRatio}' for ${modelId}. Allowed: ${NANOBANANA_ALLOWED_ASPECT_RATIOS.join(", ")}.`,
      );
    }
  }

  if (input.size && modelId === "gpt-5-image") {
    if (!isOneOf(GPT_5_IMAGE_ALLOWED_SIZES, input.size)) {
      throw new Error(
        `Unsupported size '${input.size}' for gpt-5-image. Allowed: ${GPT_5_IMAGE_ALLOWED_SIZES.join(" | ")}.`,
      );
    }
  }
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

async function pathExists(p: string) {
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

export class ImageGeneration implements ServerTool {
  id = "image-generation";

  async init(): Promise<void> {}
  async destroy(): Promise<void> {}

  async list() {
    return [
      {
        callableId: "image.generate",
        name: "Image Generate",
        description:
          "Generate or edit an image with a configured provider and write it to a local file.",
        shortInput: zodObjectToCliLines(imageGenerateInputSchema, {
          mode: "required",
        }),
        input: zodObjectToCliLines(imageGenerateInputSchema),
      },
    ];
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
    if (callableId !== "image.generate") {
      throw new Error(`Invalid callable ID '${callableId}'`);
    }

    const payload = imageGenerateInputSchema.parse(input);
    const available = getSupportedModels();

    const picked = pickModel(available, payload.model as SupportedImageModels | undefined);

    validateSettingsForModel(payload, picked.id);

    const cwd = opts?.context?.cwd ?? process.cwd();
    const resolvedTarget = resolveToolPath(cwd, payload.path);

    // For gpt-5-image, map aspect ratio to a supported size for maximum provider compatibility.
    const size =
      payload.size && payload.size.length > 0
        ? (payload.size as `${number}x${number}`)
        : picked.id === "gpt-5-image" && payload.aspectRatio
          ? (gptAspectRatioToSize(
              payload.aspectRatio as (typeof GPT_5_IMAGE_ALLOWED_ASPECT_RATIOS)[number],
            ) as `${number}x${number}`)
          : undefined;

    const aspectRatio =
      !payload.size && payload.aspectRatio && picked.id !== "gpt-5-image"
        ? (payload.aspectRatio as `${number}:${number}`)
        : undefined;

    const prompt = await buildImageGenerationPrompt(cwd, payload);

    const res = await generateImageWithModel(picked.model, prompt, {
      abortSignal: opts?.signal,
      size,
      aspectRatio,
    });

    const img = res.image;

    const originalExt = extname(resolvedTarget);
    const inferredExt = inferExtensionFromMimeType(img.mediaType) || ".png";
    const targetWithExt =
      originalExt.length > 0 ? resolvedTarget : `${resolvedTarget}${inferredExt}`;

    const outPath = await pickAvailableFilename(targetWithExt);
    await fs.mkdir(dirname(outPath), { recursive: true });
    await fs.writeFile(outPath, img.uint8Array);

    return {
      ok: true as const,
      path: outPath,
      bytes: img.uint8Array.byteLength,
      mimeType: img.mediaType,
      model: picked.id,
      warnings: res.warnings,
    };
  }
}
