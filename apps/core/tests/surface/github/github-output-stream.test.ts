import { describe, expect, it } from "bun:test";
import { Result } from "better-result";

import type { SurfaceOutputPart, SurfaceOutputPartDisposition } from "../../../src/surface/adapter";
import { GithubOutputStream } from "../../../src/surface/github/output/github-output-stream";

type StreamApi = ConstructorParameters<typeof GithubOutputStream>[1];

function createApi(comments: string[], overrides: Partial<StreamApi> = {}): StreamApi {
  return {
    createComment: async (body) => {
      comments.push(body);
      return Result.ok({ id: 1 });
    },
    resolveWebBaseUrl: async () => "https://github.com",
    ...overrides,
  };
}

describe("GithubOutputStream", () => {
  it("distinguishes visible, terminal-only, and ignored presentation parts", async () => {
    const stream = new GithubOutputStream(
      { platform: "github", channelId: "octo/repo#1" },
      createApi([]),
    );
    const optionalParts = [
      { type: "text.delta", delta: "Visible text" },
      {
        type: "reasoning.status",
        update: { startedAtMs: 1, frozenAtMs: 2, detailText: "thinking" },
      },
      {
        type: "tool.status",
        update: { toolCallId: "tool", display: "bash pwd", status: "start" },
      },
      { type: "meta.stats", line: "stats" },
      {
        type: "attachment.add",
        attachment: {
          kind: "file",
          mimeType: "text/plain",
          filename: "result.txt",
          bytes: new Uint8Array([1]),
        },
      },
    ] satisfies readonly SurfaceOutputPart[];

    const dispositions: SurfaceOutputPartDisposition[] = [];
    for (const part of optionalParts) {
      const result = await stream.push(part);
      if (result.status === "error") throw result.error;
      dispositions.push(result.value);
    }
    expect(dispositions).toEqual(["visible", "ignored", "terminal", "ignored", "terminal"]);
    await expect(stream.abort("test")).resolves.toEqual(Result.ok(undefined));
  });

  it("does not resolve the web host without a reply target", async () => {
    const comments: string[] = [];
    const stream = new GithubOutputStream(
      { platform: "github", channelId: "octo/repo#47" },
      createApi(comments, {
        resolveWebBaseUrl: async () => {
          throw new Error("no reply target, the host must not be resolved");
        },
      }),
    );
    await stream.push({ type: "text.set", text: "plain" });

    const finished = await stream.finish();

    expect(finished.status).toBe("ok");
    expect(comments[0]).not.toContain("In reply to");
  });
});

it("splits large final output within GitHub's comment limit", async () => {
  const comments: string[] = [];
  const stream = new GithubOutputStream(
    { platform: "github", channelId: "owner/repo#1" },
    createApi(comments),
  );
  await stream.push({ type: "text.set", text: "x".repeat(140_000) });
  const result = await stream.finish();
  expect(result.isOk()).toBe(true);
  expect(comments).toHaveLength(3);
  expect(comments.every((comment) => comment.length <= 65_536)).toBe(true);
});
