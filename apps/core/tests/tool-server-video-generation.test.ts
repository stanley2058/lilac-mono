import { describe, expect, it } from "bun:test";
import type { ServerToolFailure } from "@stanley2058/lilac-plugin-runtime";
import type { Result as ResultType } from "better-result";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildVideoGenerationPrompt,
  videoGenerateInputSchema,
} from "../src/tool-server/tools/generate";

const ONE_BY_ONE_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7+9n0AAAAASUVORK5CYII=";

function value<T>(result: ResultType<T, ServerToolFailure>): T {
  if (result.status === "error") throw new Error(result.error.message);
  return result.value;
}

describe("tool-server video generation", () => {
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
    const prompt = value(
      await buildVideoGenerationPrompt(process.cwd(), {
        prompt: "A cinematic drone shot of mountain cliffs",
      }),
    );

    expect(prompt).toBe("A cinematic drone shot of mountain cliffs");
  });

  it("builds image-to-video prompt with local input image", async () => {
    const tmp = await fs.mkdtemp(join(tmpdir(), "lilac-video-generate-"));
    const imagePath = join(tmp, "input.png");

    try {
      const pngBytes = Buffer.from(ONE_BY_ONE_PNG_BASE64, "base64");
      await fs.writeFile(imagePath, pngBytes);

      const prompt = value(
        await buildVideoGenerationPrompt(tmp, {
          prompt: "The camera slowly zooms in",
          inputImage: "input.png",
        }),
      );

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

      expect(
        await buildVideoGenerationPrompt(tmp, {
          prompt: "Animate this",
          inputImage: "note.txt",
        }),
      ).toMatchObject({
        status: "error",
        error: { kind: "usage", message: expect.stringContaining("not a valid image file") },
      });
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });
});
