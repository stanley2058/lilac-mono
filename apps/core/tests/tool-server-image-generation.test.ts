import { describe, expect, it } from "bun:test";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildImageGenerationPrompt,
  imageGenerateInputSchema,
  resolveImageEditInputs,
} from "../src/tool-server/tools/image-generation";

const ONE_BY_ONE_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7+9n0AAAAASUVORK5CYII=";

describe("tool-server image generation", () => {
  it("normalizes a single inputImages value into an array", () => {
    const parsed = imageGenerateInputSchema.parse({
      path: "output.png",
      prompt: "Make this brighter",
      inputImages: "input.png",
    });

    expect(parsed.inputImages).toStrictEqual(["input.png"]);
  });

  it("requires inputImages when maskImage is provided", () => {
    expect(() =>
      imageGenerateInputSchema.parse({
        path: "output.png",
        prompt: "Edit this image",
        maskImage: "mask.png",
      }),
    ).toThrow("maskImage requires inputImages.");
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
});
