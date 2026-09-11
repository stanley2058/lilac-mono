import { captureError } from "../../shared/error-capture";
import { env, errorMessage, getModelProviders } from "@stanley2058/lilac-utils";
import {
  defineServerTool,
  type RequestContext,
  type ServerTool,
  type ServerToolCallOptions,
} from "../types";
import {
  serverToolFailure,
  type ServerToolFailure,
  type ServerToolResult,
} from "@stanley2058/lilac-plugin-runtime";
import { Panic, Result, type Result as ResultType } from "better-result";
import { preserveToolPanic } from "../../tools/tool-result-adapters";

function settleCapturedError<T, E>(
  result: ResultType<T, { readonly cause: Error | Panic }>,
  resolve: (cause: Error | Panic) => E,
): ResultType<T, E> {
  return result.mapError(({ cause }) => resolve(cause));
}

async function settleCapturedPromise<T, E>(
  result: Promise<ResultType<T, { readonly cause: Error | Panic }>>,
  resolve: (cause: Error | Panic) => E,
): Promise<ResultType<T, E>> {
  return settleCapturedError(await result, resolve);
}

function captureGenerateFailure(cause: unknown): { readonly cause: Error | Panic } {
  if (Panic.is(cause)) return { cause };
  if (cause instanceof Error) return { cause };
  return { cause: new Error("Unknown image generation failure", { cause }) };
}
import { experimental_generateVideo as generateVideo, type GenerateVideoPrompt } from "ai";
import { fileTypeFromBuffer } from "file-type";
import fs from "node:fs/promises";
import { dirname, extname, join } from "node:path";
import { z } from "zod";
import {
  imageScriptInputSchema,
  imageScriptDescription,
  configuredImageProviders,
  runImageScript,
} from "./image-script";
import {
  formatToolPathForRequestContext,
  inferExtensionFromMimeType,
  inferMimeTypeFromFilename,
  resolveToolPathForRequestContext,
} from "../../shared/attachment-utils";

function generateFailure(kind: ServerToolFailure["kind"], message: string): ServerToolFailure {
  return serverToolFailure({
    kind,
    code: `generate_${kind}`,
    message,
    retryable: kind === "unavailable" || kind === "timeout",
  });
}

type SupportedVideoModelId =
  /**
   * - Modes: text-to-video, image-to-video
   * - Duration: 1-15s
   * - Aspect ratio: 1:1, 16:9, 9:16, 4:3, 3:4, 3:2, 2:3
   * - Resolution: 1280x720, 854x480, 640x480
   */
  "grok-imagine-video";

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

type VideoGenerateInput = z.infer<typeof videoGenerateInputSchema>;

type VideoModelObject = Exclude<Parameters<typeof generateVideo>[0]["model"], string>;
type GenerationProvider = "openai" | "openrouter" | "xai" | "vercel";

type ModelDescriptor<TId extends string, TModel, TInput> = {
  id: TId;
  createModel: (providers: ReturnType<typeof getModelProviders>) => TModel | undefined;
  validateInput: (input: TInput) => ResultType<void, ServerToolFailure>;
};

type VideoModelDescriptor = ModelDescriptor<
  SupportedVideoModelId,
  VideoModelObject,
  VideoGenerateInput
>;

function hasConfiguredProviderValue(config: {
  readonly apiKey: string | undefined;
  readonly baseUrl: string | undefined;
}): boolean {
  return Boolean(config.apiKey?.trim() || config.baseUrl?.trim());
}

function isConfiguredProvider(provider: GenerationProvider): boolean {
  switch (provider) {
    case "openai":
      return hasConfiguredProviderValue(env.providers.openai);
    case "openrouter":
      return hasConfiguredProviderValue(env.providers.openrouter);
    case "xai":
      return hasConfiguredProviderValue(env.providers.xai);
    case "vercel":
      return hasConfiguredProviderValue(env.providers.vercel);
  }
}

function isOneOf<const T extends readonly string[]>(allowed: T, value: string): value is T[number] {
  return (allowed as readonly string[]).includes(value);
}

function validateGrokVideoInput(input: VideoGenerateInput): ResultType<void, ServerToolFailure> {
  if (input.aspectRatio && !isOneOf(GROK_VIDEO_ALLOWED_ASPECT_RATIOS, input.aspectRatio)) {
    return Result.err(
      generateFailure(
        "usage",
        `Unsupported aspectRatio '${input.aspectRatio}' for grok-imagine-video. Allowed: ${GROK_VIDEO_ALLOWED_ASPECT_RATIOS.join(", ")}.`,
      ),
    );
  }

  if (input.resolution && !isOneOf(GROK_VIDEO_ALLOWED_RESOLUTIONS, input.resolution)) {
    return Result.err(
      generateFailure(
        "usage",
        `Unsupported resolution '${input.resolution}' for grok-imagine-video. Allowed: ${GROK_VIDEO_ALLOWED_RESOLUTIONS.join(", ")}.`,
      ),
    );
  }
  return Result.ok(undefined);
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

function getAvailableVideoModels() {
  const providers = getModelProviders();
  return resolveAvailableModels(VIDEO_MODEL_DESCRIPTORS, providers);
}

function pickModel<TId extends string, TModel>(
  available: Partial<Record<TId, TModel>>,
  requested: string | undefined,
  fallbackOrder: readonly TId[],
  modalityLabel: string,
): ResultType<{ id: TId; model: TModel }, ServerToolFailure> {
  if (requested) {
    const model = available[requested as TId];
    if (!model) {
      return Result.err(
        generateFailure(
          "unavailable",
          `Requested model '${requested}' is not available for ${modalityLabel} generation (configured: ${Object.keys(available).join(", ") || "none"}).`,
        ),
      );
    }

    return Result.ok({
      id: requested as TId,
      model,
    });
  }

  for (const id of fallbackOrder) {
    const model = available[id];
    if (model) {
      return Result.ok({ id, model });
    }
  }

  return Result.err(
    generateFailure(
      "unavailable",
      `No ${modalityLabel} generation models are configured. Configure at least one provider for ${modalityLabel} generation.`,
    ),
  );
}

function looksLikeSvg(bytes: Buffer): boolean {
  const prefix = bytes.subarray(0, 1024).toString("utf8").trimStart().toLowerCase();
  return prefix.startsWith("<svg") || prefix.startsWith("<?xml");
}

async function readImageDataFromPath(
  path: string,
  displayPath = path,
): Promise<ResultType<Buffer, ServerToolFailure>> {
  const read = await settleCapturedPromise(
    Result.tryPromise({
      try: () => fs.readFile(path),
      catch: captureGenerateFailure,
    }),
    (cause) => {
      if (Panic.is(cause)) return preserveToolPanic(cause);
      return generateFailure(
        typeof cause === "object" && cause !== null && "code" in cause && cause.code === "ENOENT"
          ? "not_found"
          : "unavailable",
        errorMessage(cause),
      );
    },
  );
  return Result.gen(async function* () {
    const bytes = yield* read;
    const typeFromBytes = yield* Result.await(
      settleCapturedPromise(
        Result.tryPromise({
          try: () => fileTypeFromBuffer(bytes),
          catch: captureGenerateFailure,
        }),
        (cause) => {
          if (Panic.is(cause)) return preserveToolPanic(cause);
          return generateFailure("unavailable", errorMessage(cause));
        },
      ),
    );

    if (typeFromBytes?.mime?.startsWith("image/")) {
      return Result.ok(bytes);
    }

    const mimeFromExtension = inferMimeTypeFromFilename(path);
    if (mimeFromExtension === "image/svg+xml" && looksLikeSvg(bytes)) {
      return Result.ok(bytes);
    }

    return Result.err(
      generateFailure("usage", `Input file '${displayPath}' is not a valid image file.`),
    );
  });
}

export async function buildVideoGenerationPrompt(
  cwd: string,
  input: {
    prompt: string;
    inputImage?: string;
  },
  context?: RequestContext,
): Promise<ResultType<GenerateVideoPrompt, ServerToolFailure>> {
  if (!input.inputImage) {
    return Result.ok(input.prompt);
  }

  return Result.gen(async function* () {
    const resolvedImage = yield* settleCapturedError(
      Result.try({
        try: () =>
          resolveToolPathForRequestContext({
            cwd,
            inputPath: input.inputImage!,
            context,
          }),
        catch: captureGenerateFailure,
      }),
      (cause) => {
        if (Panic.is(cause)) return preserveToolPanic(cause);
        return generateFailure("denied", errorMessage(cause));
      },
    );
    const image = yield* Result.await(
      readImageDataFromPath(
        resolvedImage,
        formatToolPathForRequestContext({ path: resolvedImage, context }),
      ),
    );
    return Result.ok({ text: input.prompt, image });
  });
}

async function writeFileWithUniqueName(
  targetPath: string,
  bytes: Uint8Array,
): Promise<ResultType<string, ServerToolFailure>> {
  const ext = extname(targetPath);
  const base = ext ? targetPath.slice(0, -ext.length) : targetPath;

  for (let i = 0; i < 10_000; i++) {
    const candidate = i === 0 ? targetPath : `${base} (${i})${ext}`;
    {
      const attempt = await Result.tryPromise({
        try: async () => {
          await fs.writeFile(candidate, bytes, { flag: "wx" });
          return Result.ok(candidate);
        },
        catch: captureError,
      });

      if (attempt.isErr()) {
        const error = attempt.error.cause;
        if (Panic.is(error)) return preserveToolPanic(error);
        const code =
          typeof error === "object" && error !== null && "code" in error
            ? (error.code as string | undefined)
            : undefined;
        if (code === "EEXIST") {
          continue;
        }
        return Result.err(generateFailure("unavailable", errorMessage(error)));
      }
      return attempt.value;
    }
  }

  return Result.err(
    generateFailure("conflict", `Failed to find an available filename for: ${targetPath}`),
  );
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

  private readonly tool = defineServerTool({
    id: this.id,
    callables: ({ callable }) => ({
      "generate.image": callable({
        name: "Generate Image",
        description: imageScriptDescription(),
        inputSchema: imageScriptInputSchema,
        validation: "zod",
        primaryPositional: "code",
        catalog: () => {
          const providers = configuredImageProviders();
          if (Object.keys(providers).length === 0) return false;
          return { description: imageScriptDescription(providers) };
        },
        run: (input, opts) => runImageScript(input, opts),
      }),
      "generate.video": callable({
        name: "Generate Video",
        description: "Generate a video with a configured provider and write it to a local file.",
        inputSchema: videoGenerateInputSchema,
        validation: "zod",
        catalog: () => {
          const videoModels = getAvailableVideoModels().ids;
          if (videoModels.length === 0) return false;
          return {
            description:
              "Generate a video with a configured provider and write it to a local file. " +
              `Available models: ${videoModels.join(", ")}`,
          };
        },
        run: (input, opts) => this.callGenerateVideo(input, opts),
      }),
    }),
  });

  async init(): Promise<void> {
    await this.tool.init();
  }

  async destroy(): Promise<void> {
    await this.tool.destroy();
  }

  async list() {
    return this.tool.list();
  }

  async call(
    callableId: string,
    input: Record<string, unknown>,
    opts?: ServerToolCallOptions,
  ): Promise<ServerToolResult> {
    return this.tool.call(callableId, input, opts);
  }

  private async callGenerateVideo(
    payload: VideoGenerateInput,
    opts?: ServerToolCallOptions,
  ): Promise<ServerToolResult> {
    return Result.gen(
      async function* (this: Generate) {
        const availableModels = getAvailableVideoModels();
        const picked = yield* pickModel(
          availableModels.available,
          payload.model,
          DEFAULT_VIDEO_MODEL_FALLBACK_ORDER,
          "video",
        );

        const descriptor = availableModels.byId.get(picked.id);
        if (!descriptor) {
          return Result.err(
            generateFailure("internal", `Model descriptor not found for '${picked.id}'.`),
          );
        }
        yield* descriptor.validateInput(payload);

        const cwd = opts?.context?.cwd ?? process.cwd();
        const resolvedTarget = yield* settleCapturedError(
          Result.try({
            try: () =>
              resolveToolPathForRequestContext({
                cwd,
                inputPath: payload.path,
                context: opts?.context,
              }),
            catch: captureGenerateFailure,
          }),
          (cause) => {
            if (Panic.is(cause)) return preserveToolPanic(cause);
            return generateFailure("denied", errorMessage(cause));
          },
        );

        const prompt = yield* Result.await(
          buildVideoGenerationPrompt(
            cwd,
            {
              prompt: payload.prompt,
              inputImage: payload.inputImage,
            },
            opts?.context,
          ),
        );

        const res = yield* Result.await(
          settleCapturedPromise(
            Result.tryPromise({
              try: () =>
                generateVideoWithModel(picked.model, prompt, {
                  abortSignal: opts?.signal,
                  aspectRatio: payload.aspectRatio as `${number}:${number}` | undefined,
                  resolution: payload.resolution as `${number}x${number}` | undefined,
                  duration: payload.duration,
                }),
              catch: captureGenerateFailure,
            }),
            (cause) => {
              if (Panic.is(cause)) return preserveToolPanic(cause);
              return generateFailure(
                opts?.signal?.aborted ? "cancelled" : "unavailable",
                errorMessage(cause),
              );
            },
          ),
        );

        const video = res.video;
        const originalExt = extname(resolvedTarget);
        const inferredExt = inferExtensionFromMimeType(video.mediaType) || ".mp4";
        const targetWithExt =
          originalExt.length > 0 ? resolvedTarget : `${resolvedTarget}${inferredExt}`;
        yield* Result.await(
          settleCapturedPromise(
            Result.tryPromise({
              try: () => fs.mkdir(dirname(targetWithExt), { recursive: true }),
              catch: captureGenerateFailure,
            }),
            (cause) => {
              if (Panic.is(cause)) return preserveToolPanic(cause);
              return generateFailure("unavailable", errorMessage(cause));
            },
          ),
        );
        const outPath = yield* Result.await(
          writeFileWithUniqueName(targetWithExt, video.uint8Array),
        );

        return Result.ok({
          ok: true as const,
          path: formatToolPathForRequestContext({ path: outPath, context: opts?.context }),
          bytes: video.uint8Array.byteLength,
          mimeType: video.mediaType,
          model: picked.id,
          warnings: res.warnings,
          providerMetadata: res.providerMetadata,
        });
      }.bind(this),
    );
  }
}
