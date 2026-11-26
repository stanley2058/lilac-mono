import { describe, expect, it } from "bun:test";
import type { SurfaceAttachment } from "../../../../src/surface/types";
import { DiscordOutputStream } from "../../../../src/surface/discord/output/discord-output-stream";
import {
  resultValue,
  createFakeDiscordClient,
  hasFiles,
  contentFromOptions,
  filesCount,
  allUploadedFileNames,
  makeAttachment,
} from "./discord-output-stream-fixture";

describe("attachment finalization", () => {
  it("inline mode edits attachments onto the final split message", async () => {
    const { client, operations } = createFakeDiscordClient();

    const out = new DiscordOutputStream({
      client,
      sessionRef: { platform: "discord", channelId: "chan" },
      useSmartSplitting: false,
      outputMode: "inline",
      reasoningDisplayMode: "none",
      workingIndicators: ["Working"],
    });

    await out.push({ type: "text.delta", delta: "a".repeat(9000) });
    await out.push({ type: "attachment.add", attachment: makeAttachment(1) });
    const res = resultValue(await out.finish());

    expect(res.created.length).toBeGreaterThan(1);

    const editsWithFiles = operations.filter((op) => op.kind === "edit" && hasFiles(op.options));
    expect(editsWithFiles.length).toBe(1);
    expect(editsWithFiles[0]?.messageId).toBe(res.last.messageId);
    expect(allUploadedFileNames(operations)).toEqual(["image-1.png"]);

    const replyWithFiles = operations.filter((op) => op.kind === "reply" && hasFiles(op.options));
    expect(replyWithFiles.length).toBe(0);
  });

  const MIB = 1024 * 1024;
  const sizedAttachment = (index: number, mib: number): SurfaceAttachment => ({
    ...makeAttachment(index),
    bytes: new Uint8Array(mib * MIB),
  });
  const finishWithAttachments = async (tier: number | undefined, sizesMib: readonly number[]) => {
    const { client, operations } = createFakeDiscordClient({ guildPremiumTier: tier });
    const out = new DiscordOutputStream({
      client,
      sessionRef: { platform: "discord", channelId: "chan" },
      useSmartSplitting: false,
      outputMode: "preview",
      outputPreviewModeFinalStyle: "plain",
      outputPreviewModeFinalText: "reply-chain",
      reasoningDisplayMode: "none",
      workingIndicators: ["Working"],
    });

    await out.push({ type: "text.delta", delta: "files" });
    for (const [index, mib] of sizesMib.entries()) {
      await out.push({ type: "attachment.add", attachment: sizedAttachment(index, mib) });
    }
    const result = resultValue(await out.finish());
    const finalOps = operations.filter((op) =>
      result.created.some((ref) => ref.messageId === op.messageId),
    );
    return {
      uploads: finalOps.filter((op) => hasFiles(op.options)).map((op) => filesCount(op.options)),
      contents: finalOps.flatMap((op) => contentFromOptions(op.options) ?? []),
    };
  };

  it.each([
    ["a DM", undefined],
    ["a tier 2 guild", 2],
    ["a tier 3 guild", 3],
  ] as const)("keeps each upload request within the request byte budget in %s", async (_, tier) => {
    const { uploads } = await finishWithAttachments(tier, [12, 12, 12]);
    expect(uploads).toEqual([2, 1]);
  });

  it.each([
    ["a tier 2 guild", 2, [40, 12]],
    ["a tier 3 guild", 3, [90, 12]],
  ] as const)(
    "sends a file over the request budget alone when %s allows its size",
    async (_, tier, sizesMib) => {
      const { uploads, contents } = await finishWithAttachments(tier, sizesMib);
      expect(uploads).toEqual([1, 1]);
      expect(contents.some((content) => content.includes("Skipped attachment"))).toBe(false);
    },
  );

  it.each([
    ["a DM", undefined, 21, "20 MiB"],
    ["a tier 2 guild", 2, 51, "50 MiB"],
  ] as const)(
    "skips a file over the per-file limit in %s with a notice",
    async (_, tier, mib, limit) => {
      const { uploads, contents } = await finishWithAttachments(tier, [mib, 1]);
      expect(uploads).toEqual([1]);
      expect(contents).toContain(
        `Skipped attachment \`image-0.png\` (${mib} MiB): over the ${limit} Discord upload limit for this channel.`,
      );
    },
  );

  it("preview mode posts attachments on the final reposted split message", async () => {
    const { client, operations } = createFakeDiscordClient();

    const out = new DiscordOutputStream({
      client,
      sessionRef: { platform: "discord", channelId: "chan" },
      useSmartSplitting: false,
      outputMode: "preview",
      reasoningDisplayMode: "none",
      workingIndicators: ["Working"],
    });

    await out.push({ type: "text.delta", delta: "b".repeat(9000) });
    await out.push({ type: "attachment.add", attachment: makeAttachment(1) });
    const res = resultValue(await out.finish());

    expect(res.created.length).toBeGreaterThan(1);

    const sentWithFiles = operations.filter(
      (op) => (op.kind === "send" || op.kind === "reply") && hasFiles(op.options),
    );
    expect(sentWithFiles.length).toBe(1);
    expect(sentWithFiles[0]?.messageId).toBe(res.last.messageId);
    expect(allUploadedFileNames(operations)).toEqual(["image-1.png"]);

    const editsWithFiles = operations.filter((op) => op.kind === "edit" && hasFiles(op.options));
    expect(editsWithFiles.length).toBe(0);
  });

  it("falls back to follow-up attachment messages when final edit fails", async () => {
    const { client, operations } = createFakeDiscordClient({ failEditWithFiles: true });

    const out = new DiscordOutputStream({
      client,
      sessionRef: { platform: "discord", channelId: "chan" },
      useSmartSplitting: false,
      outputMode: "inline",
      reasoningDisplayMode: "none",
      workingIndicators: ["Working"],
    });

    await out.push({ type: "text.delta", delta: "hello" });
    await out.push({ type: "attachment.add", attachment: makeAttachment(1) });
    const res = resultValue(await out.finish());

    const replyWithFiles = operations.filter((op) => op.kind === "reply" && hasFiles(op.options));
    expect(replyWithFiles.length).toBe(1);
    const replyFileMsg = replyWithFiles[0];
    if (!replyFileMsg) {
      throw new Error("expected reply message with files");
    }
    expect(res.last.messageId).toBe(replyFileMsg.messageId);
  });

  it("keeps first 10 attachments on final message and overflows remainder", async () => {
    const { client, operations } = createFakeDiscordClient();

    const out = new DiscordOutputStream({
      client,
      sessionRef: { platform: "discord", channelId: "chan" },
      useSmartSplitting: false,
      outputMode: "inline",
      reasoningDisplayMode: "none",
      workingIndicators: ["Working"],
    });

    await out.push({ type: "text.delta", delta: "hello" });
    for (let i = 0; i < 11; i++) {
      await out.push({ type: "attachment.add", attachment: makeAttachment(i) });
    }

    const res = resultValue(await out.finish());

    const editsWithFiles = operations.filter((op) => op.kind === "edit" && hasFiles(op.options));
    expect(editsWithFiles.length).toBe(1);
    expect(filesCount(editsWithFiles[0]?.options)).toBe(10);

    const replyWithFiles = operations.filter((op) => op.kind === "reply" && hasFiles(op.options));
    expect(replyWithFiles.length).toBe(1);
    expect(filesCount(replyWithFiles[0]?.options)).toBe(1);
    const replyFileMsg = replyWithFiles[0];
    if (!replyFileMsg) {
      throw new Error("expected overflow reply message with files");
    }
    expect(res.last.messageId).toBe(replyFileMsg.messageId);
  });
});

describe("attachment single-event safety", () => {
  it("does not reattach one queued attachment across reanchor and finish", async () => {
    const { client, operations } = createFakeDiscordClient();

    const out = new DiscordOutputStream({
      client,
      sessionRef: { platform: "discord", channelId: "chan" },
      useSmartSplitting: false,
      outputMode: "inline",
      reasoningDisplayMode: "none",
      workingIndicators: ["Working"],
    });

    await out.push({ type: "text.delta", delta: "before reanchor" });
    await out.push({ type: "attachment.add", attachment: makeAttachment(9) });
    await out.abort("reanchor");

    await out.push({ type: "text.delta", delta: "after reanchor" });
    await out.finish();

    expect(allUploadedFileNames(operations)).toEqual(["image-9.png"]);
  });

  it("attaches one queued attachment exactly once on cancel", async () => {
    const { client, operations } = createFakeDiscordClient();

    const out = new DiscordOutputStream({
      client,
      sessionRef: { platform: "discord", channelId: "chan" },
      useSmartSplitting: false,
      outputMode: "inline",
      reasoningDisplayMode: "none",
      workingIndicators: ["Working"],
    });

    await out.push({ type: "text.delta", delta: "hello" });
    await out.push({ type: "attachment.add", attachment: makeAttachment(10) });
    await out.abort("cancel");

    expect(allUploadedFileNames(operations)).toEqual(["image-10.png"]);
  });

  it("attaches attachment-only cancel output once", async () => {
    const { client, operations, createdMessageIds } = createFakeDiscordClient();

    const out = new DiscordOutputStream({
      client,
      sessionRef: { platform: "discord", channelId: "chan" },
      useSmartSplitting: false,
      outputMode: "inline",
      reasoningDisplayMode: "none",
      workingIndicators: ["Working"],
    });

    await out.push({ type: "attachment.add", attachment: makeAttachment(11) });
    await out.abort("cancel");

    expect(createdMessageIds.length).toBeGreaterThan(0);
    expect(allUploadedFileNames(operations)).toEqual(["image-11.png"]);
  });
});
