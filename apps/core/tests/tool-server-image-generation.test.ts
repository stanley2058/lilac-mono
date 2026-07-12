import { describe, expect, it } from "bun:test";
import type { CoreConfig } from "@stanley2058/lilac-utils";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildImageGenerationPrompt,
  buildVideoGenerationPrompt,
  canRequestImageModel,
  createExplicitProviderImageModel,
  imageGenerateInputSchema,
  normalizeImageGenerationParametersForModel,
  resolveConfiguredImageModelSpecs,
  resolveImageGenerationParameters,
  resolveImageEditInputs,
  videoGenerateInputSchema,
} from "../src/tool-server/tools/generate";
import { resolveRestrictedSessionTmpDir } from "../src/shared/attachment-utils";

const ONE_BY_ONE_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7+9n0AAAAASUVORK5CYII=";

const REQUIRED_TOOL_POLICY_CONFIG = {
  output: {
    maxPreviewBytes: 40 * 1024,
    artifactTtlMs: 7 * 24 * 60 * 60 * 1000,
    artifactMaxBytesPerSession: 50 * 1024 * 1024,
  },
  historicalResultPruning: {
    enabled: false,
    protectTokens: 40_000,
    minimumTokens: 20_000,
  },
  batch: {
    maxCalls: 8,
  },
  media: {
    maxInlineBytesPerPart: 10 * 1024 * 1024,
    maxInlineBytesTotal: 20 * 1024 * 1024,
  },
} satisfies Pick<CoreConfig["tools"], "output" | "historicalResultPruning" | "batch" | "media">;

describe("tool-server image generation", () => {
  it("normalizes a single inputImages value into an array", () => {
    const parsed = imageGenerateInputSchema.parse({
      outputDir: "outputs",
      prompt: "Make this brighter",
      inputImages: "input.png",
    });

    expect(parsed.inputImages).toStrictEqual(["input.png"]);
  });

  it("requires inputImages when maskImage is provided", () => {
    expect(() =>
      imageGenerateInputSchema.parse({
        outputDir: "outputs",
        prompt: "Edit this image",
        maskImage: "mask.png",
      }),
    ).toThrow("maskImage requires inputImages.");
  });

  it("accepts omitted outputDir and defaults to cwd at execution time", () => {
    const parsed = imageGenerateInputSchema.parse({
      prompt: "Create a landscape photo",
    });

    expect(parsed.outputDir).toBeUndefined();
  });

  it("rejects deprecated path input for image output", () => {
    expect(() =>
      imageGenerateInputSchema.parse({
        path: "legacy-output.png",
        prompt: "Generate a portrait",
      }),
    ).toThrow("Unrecognized key");
  });

  it("uses built-in image model defaults when config does not specify models", () => {
    expect(resolveConfiguredImageModelSpecs(undefined)).toEqual([
      "nanobanana-2",
      "nanobanana-pro",
      "gpt-5-image",
      "grok-imagine-image-pro",
      "grok-imagine-image",
      "nanobanana",
    ]);
  });

  it("uses configured image model specs as the default order", () => {
    const config = {
      tools: {
        ...REQUIRED_TOOL_POLICY_CONFIG,
        fsBackend: "fff",
        web: {
          extract: {
            providers: ["tavily"],
          },
          fetch: {
            mode: "auto",
          },
        },
        inspect: {
          model: "google/gemini-3.5-flash",
        },
        editFile: {
          hashline: true,
        },
        generate: {
          image: {
            models: ["openai-compatible/acme-image-model"],
            defaults: {},
            profiles: {},
          },
        },
      },
    } satisfies Pick<CoreConfig, "tools">;

    expect(resolveConfiguredImageModelSpecs(config)).toEqual([
      "openai-compatible/acme-image-model",
    ]);
  });

  it("creates explicit OpenAI-compatible image models from provider/model specs", () => {
    const requestedModelIds: string[] = [];
    const model = createExplicitProviderImageModel({
      spec: "openai-compatible/acme/image-model",
      configuredProviderIds: ["openai-compatible"],
      providers: {
        "openai-compatible": {
          imageModel(modelId: string) {
            requestedModelIds.push(modelId);
            return `image:${modelId}`;
          },
        },
      },
    });

    expect(model).toBe("image:acme/image-model");
    expect(requestedModelIds).toEqual(["acme/image-model"]);
  });

  it("creates explicit image models from function-shaped AI SDK providers", () => {
    const requestedModelIds: string[] = [];
    const provider = Object.assign(() => undefined, {
      imageModel(modelId: string) {
        requestedModelIds.push(modelId);
        return `image:${modelId}`;
      },
    });

    const model = createExplicitProviderImageModel({
      spec: "openai-compatible/gpt-image-2",
      configuredProviderIds: ["openai-compatible"],
      providers: {
        "openai-compatible": provider,
      },
    });

    expect(model).toBe("image:gpt-image-2");
    expect(requestedModelIds).toEqual(["gpt-image-2"]);
  });

  it("does not create explicit image models for unconfigured providers", () => {
    const model = createExplicitProviderImageModel({
      spec: "openai-compatible/acme/image-model",
      configuredProviderIds: [],
      providers: {
        "openai-compatible": {
          imageModel(modelId: string) {
            return `image:${modelId}`;
          },
        },
      },
    });

    expect(model).toBeUndefined();
  });

  it("treats configured image models as the explicit request allowlist", () => {
    expect(
      canRequestImageModel({
        configuredModelSpecs: ["openai-compatible/gpt-image-2"],
        requested: "openai-compatible/gpt-image-2",
      }),
    ).toBe(true);

    expect(
      canRequestImageModel({
        configuredModelSpecs: ["openai-compatible/gpt-image-2"],
        requested: "openai-compatible/nanobanana-pro",
      }),
    ).toBe(false);

    expect(
      canRequestImageModel({
        configuredModelSpecs: [],
        requested: "openai-compatible/nanobanana-pro",
      }),
    ).toBe(true);
  });

  it("normalizes gpt-image-2 sizes before sending them to the provider", () => {
    const normalized = normalizeImageGenerationParametersForModel({
      modelId: "openai-compatible/gpt-image-2",
      parameters: {
        size: "2304x4096",
      },
    });

    expect(normalized.parameters.size).toBe("2160x3840");
    expect(normalized.warnings).toEqual([
      {
        type: "parameter-adjusted",
        parameter: "size",
        from: "2304x4096",
        to: "2160x3840",
        reason:
          "gpt-image-2 image sizes must use 16-pixel multiples and stay within the provider pixel limit.",
      },
    ]);
  });

  it("accepts the gpt-image-2 maximum dimension boundary", () => {
    const normalized = normalizeImageGenerationParametersForModel({
      modelId: "openai-compatible/gpt-image-2",
      parameters: {
        size: "4096x16",
      },
    });

    expect(normalized.parameters.size).toBe("4096x16");
    expect(normalized.warnings).toEqual([]);
  });

  it("rejects gpt-image-2 dimensions above 4096 pixels", () => {
    expect(() =>
      normalizeImageGenerationParametersForModel({
        modelId: "openai-compatible/gpt-image-2",
        parameters: {
          size: "4097x16",
        },
      }),
    ).toThrow("no larger than 4096px per side");
  });

  it("rejects extreme gpt-image-2 aspect ratios before provider execution", () => {
    expect(() =>
      normalizeImageGenerationParametersForModel({
        modelId: "openai-compatible/gpt-image-2",
        parameters: {
          aspectRatio: `${Number.MAX_SAFE_INTEGER}:1`,
        },
      }),
    ).toThrow("no larger than 4096px per side");
  });

  it("converts gpt-image-2 aspectRatio into a concrete provider size", () => {
    const normalized = normalizeImageGenerationParametersForModel({
      modelId: "openai-compatible/gpt-image-2",
      parameters: {
        aspectRatio: "3:4",
      },
    });

    expect(normalized.parameters).toMatchObject({
      size: "880x1184",
      aspectRatio: undefined,
    });
    expect(normalized.warnings[0]?.parameter).toBe("aspectRatio");
  });

  it("resolves image generation parameters from global defaults and model profiles", () => {
    const config = {
      tools: {
        ...REQUIRED_TOOL_POLICY_CONFIG,
        fsBackend: "fff",
        web: {
          extract: {
            providers: ["tavily"],
          },
          fetch: {
            mode: "auto",
          },
        },
        inspect: {
          model: "google/gemini-3.5-flash",
        },
        editFile: {
          hashline: true,
        },
        generate: {
          image: {
            models: ["openai-compatible/nanobanana", "openai-compatible/gpt-image-2"],
            defaults: {
              aspectRatio: "1:1",
              options: {
                quality: "standard",
              },
            },
            profiles: {
              "openai-compatible/nanobanana": {
                useWhen: "fast edits and drafts",
                defaults: {
                  size: "1024x1024",
                  options: {
                    quality: "high",
                    background: "transparent",
                  },
                },
              },
            },
          },
        },
      },
    } satisfies Pick<CoreConfig, "tools">;

    const params = resolveImageGenerationParameters({
      config,
      modelId: "openai-compatible/nanobanana",
      model: {
        specificationVersion: "v4",
        provider: "openaiCompatible.image",
        modelId: "nanobanana",
        maxImagesPerCall: 1,
        doGenerate() {
          throw new Error("not called");
        },
      },
      input: {},
    });

    expect(params).toEqual({
      size: "1024x1024",
      aspectRatio: undefined,
      providerOptions: {
        openaiCompatible: {
          quality: "high",
          background: "transparent",
        },
      },
    });
  });

  it("wraps nested shorthand provider options under the resolved namespace", () => {
    const config = {
      tools: {
        ...REQUIRED_TOOL_POLICY_CONFIG,
        fsBackend: "fff",
        web: {
          extract: {
            providers: ["tavily"],
          },
          fetch: {
            mode: "auto",
          },
        },
        inspect: {
          model: "google/gemini-3.5-flash",
        },
        editFile: {
          hashline: true,
        },
        generate: {
          image: {
            models: ["openai-compatible/nanobanana"],
            defaults: {
              options: {
                quality: {
                  mode: "high",
                },
              },
            },
            profiles: {},
          },
        },
      },
    } satisfies Pick<CoreConfig, "tools">;

    const params = resolveImageGenerationParameters({
      config,
      modelId: "openai-compatible/nanobanana",
      model: {
        specificationVersion: "v4",
        provider: "openaiCompatible.image",
        modelId: "nanobanana",
        maxImagesPerCall: 1,
        doGenerate() {
          throw new Error("not called");
        },
      },
      input: {},
    });

    expect(params.providerOptions).toEqual({
      openaiCompatible: {
        quality: {
          mode: "high",
        },
      },
    });
  });

  it("lets caller image parameters override configured defaults", () => {
    const config = {
      tools: {
        ...REQUIRED_TOOL_POLICY_CONFIG,
        fsBackend: "fff",
        web: {
          extract: {
            providers: ["tavily"],
          },
          fetch: {
            mode: "auto",
          },
        },
        inspect: {
          model: "google/gemini-3.5-flash",
        },
        editFile: {
          hashline: true,
        },
        generate: {
          image: {
            models: ["openai-compatible/gpt-image-2"],
            defaults: {
              aspectRatio: "1:1",
            },
            profiles: {},
          },
        },
      },
    } satisfies Pick<CoreConfig, "tools">;

    const params = resolveImageGenerationParameters({
      config,
      modelId: "openai-compatible/gpt-image-2",
      model: {
        specificationVersion: "v4",
        provider: "openaiCompatible.image",
        modelId: "gpt-image-2",
        maxImagesPerCall: 1,
        doGenerate() {
          throw new Error("not called");
        },
      },
      input: {
        size: "1536x1024",
      },
    });

    expect(params.size).toBe("1536x1024");
    expect(params.aspectRatio).toBeUndefined();
  });

  it("returns plain text prompt when inputImages are not provided", async () => {
    const prompt = await buildImageGenerationPrompt(process.cwd(), {
      prompt: "Generate a scenic mountain view",
    });

    expect(prompt).toBe("Generate a scenic mountain view");
  });

  it("builds an edit prompt with local input image and mask", async () => {
    const tmp = await fs.mkdtemp(join(tmpdir(), "lilac-image-generate-"));
    const basePath = join(tmp, "base.png");
    const maskPath = join(tmp, "mask.png");

    try {
      const pngBytes = Buffer.from(ONE_BY_ONE_PNG_BASE64, "base64");
      await fs.writeFile(basePath, pngBytes);
      await fs.writeFile(maskPath, pngBytes);

      const prompt = await buildImageGenerationPrompt(tmp, {
        prompt: "Replace the background with a sunset sky",
        inputImages: ["base.png"],
        maskImage: "mask.png",
      });

      expect(typeof prompt).toBe("object");
      if (typeof prompt === "string") return;

      expect(prompt.text).toBe("Replace the background with a sunset sky");
      expect(prompt.images.length).toBe(1);
      expect(prompt.images[0]).toBeInstanceOf(Uint8Array);
      expect(prompt.mask).toBeInstanceOf(Uint8Array);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it("allows restricted image inputs from sandbox /tmp", async () => {
    const sessionId = "restricted-image-test";
    const restrictedTmp = resolveRestrictedSessionTmpDir(sessionId);
    const imagePath = join(restrictedTmp, "input.png");

    try {
      await fs.mkdir(restrictedTmp, { recursive: true });
      await fs.writeFile(imagePath, Buffer.from(ONE_BY_ONE_PNG_BASE64, "base64"));

      const prompt = await buildImageGenerationPrompt(
        "/tmp",
        {
          prompt: "Make this brighter",
          inputImages: ["input.png"],
        },
        {
          sessionId,
          safetyMode: "restricted",
        },
      );

      expect(typeof prompt).toBe("object");
      if (typeof prompt === "string") return;
      expect(prompt.images[0]).toBeInstanceOf(Uint8Array);
    } finally {
      await fs.rm(restrictedTmp, { recursive: true, force: true });
    }
  });

  it("rejects restricted image inputs outside sandbox /tmp", async () => {
    await expect(
      buildImageGenerationPrompt(
        "/workspace",
        {
          prompt: "Edit this image",
          inputImages: ["private.png"],
        },
        {
          sessionId: "restricted-image-test",
          safetyMode: "restricted",
        },
      ),
    ).rejects.toThrow("Restricted mode only allows file paths under /tmp");
  });

  it("rejects non-image files in inputImages", async () => {
    const tmp = await fs.mkdtemp(join(tmpdir(), "lilac-image-generate-"));
    const textPath = join(tmp, "note.txt");

    try {
      await fs.writeFile(textPath, "not an image", "utf8");

      await expect(
        resolveImageEditInputs(tmp, {
          inputImages: ["note.txt"],
        }),
      ).rejects.toThrow("not a valid image file");
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it("rejects mislabeled image files when bytes are not an image", async () => {
    const tmp = await fs.mkdtemp(join(tmpdir(), "lilac-image-generate-"));
    const fakePngPath = join(tmp, "fake.png");

    try {
      await fs.writeFile(fakePngPath, "not an image", "utf8");

      await expect(
        resolveImageEditInputs(tmp, {
          inputImages: ["fake.png"],
        }),
      ).rejects.toThrow("not a valid image file");
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it("parses video generation input with optional image-to-video fields", () => {
    const parsed = videoGenerateInputSchema.parse({
      path: "output.mp4",
      prompt: "A fox running in the snow",
      inputImage: "frame.png",
      aspectRatio: "16:9",
      resolution: "1280x720",
      duration: 5,
    });

    expect(parsed.inputImage).toBe("frame.png");
    expect(parsed.aspectRatio).toBe("16:9");
    expect(parsed.resolution).toBe("1280x720");
    expect(parsed.duration).toBe(5);
  });

  it("coerces string duration for CLI flag inputs", () => {
    const parsed = videoGenerateInputSchema.parse({
      path: "output.mp4",
      prompt: "A fox running in the snow",
      duration: "5",
    });

    expect(parsed.duration).toBe(5);
  });

  it("returns plain text prompt when video inputImage is not provided", async () => {
    const prompt = await buildVideoGenerationPrompt(process.cwd(), {
      prompt: "A cinematic drone shot of mountain cliffs",
    });

    expect(prompt).toBe("A cinematic drone shot of mountain cliffs");
  });

  it("builds image-to-video prompt with local input image", async () => {
    const tmp = await fs.mkdtemp(join(tmpdir(), "lilac-video-generate-"));
    const imagePath = join(tmp, "input.png");

    try {
      const pngBytes = Buffer.from(ONE_BY_ONE_PNG_BASE64, "base64");
      await fs.writeFile(imagePath, pngBytes);

      const prompt = await buildVideoGenerationPrompt(tmp, {
        prompt: "The camera slowly zooms in",
        inputImage: "input.png",
      });

      expect(typeof prompt).toBe("object");
      if (typeof prompt === "string") return;

      expect(prompt.text).toBe("The camera slowly zooms in");
      expect(prompt.image).toBeInstanceOf(Uint8Array);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it("rejects non-image files for video inputImage", async () => {
    const tmp = await fs.mkdtemp(join(tmpdir(), "lilac-video-generate-"));
    const textPath = join(tmp, "note.txt");

    try {
      await fs.writeFile(textPath, "not an image", "utf8");

      await expect(
        buildVideoGenerationPrompt(tmp, {
          prompt: "Animate this",
          inputImage: "note.txt",
        }),
      ).rejects.toThrow("not a valid image file");
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });
});
