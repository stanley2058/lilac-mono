import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, open } from "node:fs/promises";
import path from "node:path";
import type { APIMessage } from "discord.js";
import { DISCORD_LIMITS, DISCORD_TOKEN, FakeDiscord } from "./harness/fake-discord";
import { startE2E, type E2E } from "./harness";

const CHANNELS = [
  "mention",
  "long",
  "blocked-probe",
  "deleted-preview",
  "deleted-trigger",
  "steer",
  "follow-up",
] as const;

let discord: FakeDiscord;
let e2e: E2E;
beforeAll(async () => {
  discord = new FakeDiscord(CHANNELS).start();
  e2e = await startE2E({
    config: { surface: { discord: discord.coreConfig() } },
    env: discord.coreEnv(),
  });
  await discord.identifiedClient();
}, 60_000);
afterAll(async () => {
  await e2e?.[Symbol.asyncDispose]();
  await discord?.stop();
  expect(e2e?.model.unhandled ?? []).toEqual([]);
  expect(discord?.unhandled ?? []).toEqual([]);
  // Every request carried the bot token and stayed within Discord's documented limits.
  expect(discord?.calls.filter((call) => call.authorization !== `Bot ${DISCORD_TOKEN}`)).toEqual(
    [],
  );
  expect(discord?.calls.filter((call) => call.violation)).toEqual([]);
}, 60_000);

/** A FIFO the agent's bash command blocks on until the test writes to it. */
async function barrier() {
  const directory = await mkdtemp(path.join(e2e.layout.directory, "barrier-"));
  const fifo = path.join(directory, "go");
  const made = Bun.spawnSync(["mkfifo", fifo]);
  if (made.exitCode !== 0) throw new Error("mkfifo failed");
  return {
    command: `read line < ${fifo}; echo "released:$line"`,
    async release(value = "ok") {
      const handle = await open(fifo, "w");
      await handle.write(`${value}\n`);
      await handle.close();
    },
  };
}

/** Preview mode freezes a superseded preview with this text when a steer re-anchors the reply. */
const FROZEN_PREVIEW = "*Steering...*";

const isLivePreview = (message: APIMessage) =>
  message.embeds.length > 0 && message.embeds[0]?.description !== FROZEN_PREVIEW;

/**
 * Waits until the reply text is visible in the channel and the run's streaming preview is gone,
 * which is the relay's last step in preview mode. Returns the plain final messages.
 */
async function settledReply(channelId: string, text: string): Promise<APIMessage[]> {
  return discord.waitFor(() => {
    const messages = discord.botMessages(channelId);
    const final = messages.filter((message) => message.embeds.length === 0);
    if (messages.some(isLivePreview)) return undefined;
    if (
      !final
        .map((message) => message.content)
        .join("\n")
        .includes(text.slice(-40))
    )
      return undefined;
    return final;
  }, `settled reply in ${channelId}`);
}

/** Bot message creations whose plain content contains the text; previews use embeds instead. */
const postsContaining = (channelId: string, text: string) =>
  discord
    .callsTo("POST", new RegExp(`^/channels/${channelId}/messages$`, "u"))
    .filter((call) => (call.body as { content?: string }).content?.includes(text));

/** The id of the message a create request replied to, if any. */
const replyTarget = (body: unknown) =>
  (body as { message_reference?: { message_id?: string } }).message_reference?.message_id;

/** Resolves once the run's streaming preview shows the tool call. */
const previewShowing = (channelId: string, needle: string) =>
  discord.waitFor(
    () =>
      discord
        .botMessages(channelId)
        .find(
          (message) => isLivePreview(message) && JSON.stringify(message.embeds).includes(needle),
        ),
    `preview showing ${needle}`,
  );

test("a mention in an allowed channel runs a tool and replies to the trigger once", async () => {
  const channelId = discord.channel("mention");
  const since = discord.calls.length;
  const tag = e2e.model.script("discord-mention", (_request, model) => {
    if (model.step === 0)
      return { toolCalls: [{ name: "bash", args: { command: "echo discord-tool-ran" } }] };
    return { text: `Tool said ${model.json<{ stdout: string }>("bash").stdout.trim()}.` };
  });
  const trigger = discord.userMessage({
    channelId,
    content: `${tag} Run the tool.`,
    mentionBot: true,
  });
  const reply = "Tool said discord-tool-ran.";

  const final = await settledReply(channelId, reply);

  expect(final.map((message) => message.content)).toEqual([reply]);
  const posts = postsContaining(channelId, reply);
  expect(posts.map((call) => [call.path, replyTarget(call.body)])).toEqual([
    [`/channels/${channelId}/messages`, trigger.id],
  ]);
  expect(e2e.model.forScenario("discord-mention").map((entry) => entry.request.tools)).toEqual([
    expect.arrayContaining(["bash"]),
    expect.arrayContaining(["bash"]),
  ]);
  // Typing, the preview and the reply all target the trigger's channel.
  expect(
    discord.calls
      .slice(since)
      .filter(
        (call) =>
          call.path.startsWith("/channels/") && !call.path.startsWith(`/channels/${channelId}`),
      ),
  ).toEqual([]);
}, 60_000);

test("a reply longer than 2000 characters is split into ordered messages within limits", async () => {
  const channelId = discord.channel("long");
  const words = (count: number, prefix: string) =>
    Array.from({ length: count }, (_, index) => `${prefix}${index}`).join(" ");
  // One unbroken 3000-character paragraph forces a split inside a paragraph.
  const reply = [
    `Opening ${words(150, "a")}`,
    words(700, "b"),
    `Closing ${words(150, "c")} end-of-reply`,
  ].join("\n\n");
  expect(reply.length).toBeGreaterThan(2 * DISCORD_LIMITS.content);
  const tag = e2e.model.script("discord-long", () => ({ text: reply }));
  const trigger = discord.userMessage({
    channelId,
    content: `${tag} Write a long answer.`,
    mentionBot: true,
  });

  const final = await settledReply(channelId, reply);

  expect(final.length).toBeGreaterThan(2);
  for (const message of final)
    expect(message.content.length).toBeLessThanOrEqual(DISCORD_LIMITS.content);
  // Chunks keep every word once, in order.
  expect(final.flatMap((message) => message.content.split(/\s+/u).filter(Boolean))).toEqual(
    reply.split(/\s+/u),
  );
  const creates = discord
    .callsTo("POST", new RegExp(`^/channels/${channelId}/messages$`, "u"))
    .filter((call) => typeof (call.body as { content?: unknown }).content === "string");
  expect(creates).toHaveLength(final.length);
  expect(replyTarget(creates[0]!.body)).toBe(trigger.id);
  // Every write to the channel, preview edits included, stayed within Discord's limits.
  expect(
    discord.calls.filter((call) => call.path.includes(channelId) && call.status >= 400),
  ).toEqual([]);
}, 60_000);

test("a mention in a channel outside the allowlist starts no run", async () => {
  const blockedTag = "[scenario:discord-blocked]";
  const blockedId = discord.blockedChannel.id;
  discord.userMessage({
    channelId: blockedId,
    content: `${blockedTag} Do something.`,
    mentionBot: true,
  });
  // A later run in an allowed channel shows the gateway events before it were processed.
  const channelId = discord.channel("blocked-probe");
  const tag = e2e.model.script("discord-blocked-probe", () => ({ text: "Probe done." }));
  discord.userMessage({ channelId, content: `${tag} Probe.`, mentionBot: true });
  await settledReply(channelId, "Probe done.");

  expect(
    e2e.model.requests.filter((entry) =>
      JSON.stringify(entry.request.messages).includes(blockedTag),
    ),
  ).toEqual([]);
  expect(discord.calls.filter((call) => call.path.includes(blockedId))).toEqual([]);
}, 60_000);

test("deleting the streaming preview mid-run moves output to a fresh message", async () => {
  const channelId = discord.channel("deleted-preview");
  const gate = await barrier();
  const tag = e2e.model.script("discord-deleted-preview", (_request, model) => {
    if (model.step === 0) return { toolCalls: [{ name: "bash", args: { command: gate.command } }] };
    return { text: `Recovered after ${model.json<{ stdout: string }>("bash").stdout.trim()}.` };
  });
  const trigger = discord.userMessage({
    channelId,
    content: `${tag} Run the long task.`,
    mentionBot: true,
  });
  const preview = await previewShowing(channelId, "read line");
  discord.deleteMessage(preview.id);
  await gate.release();
  const reply = "Recovered after released:ok.";

  const final = await settledReply(channelId, reply);

  expect(final.map((message) => message.content)).toEqual([reply]);
  expect(postsContaining(channelId, reply).map((call) => replyTarget(call.body))).toEqual([
    trigger.id,
  ]);
  // The relay hit the deleted message once, then streamed into a new preview it cleaned up.
  const deletedEdits = discord.callsTo("PATCH", new RegExp(`/messages/${preview.id}$`, "u"));
  expect(deletedEdits.map((call) => call.status)).toEqual([404]);
  const previews = discord
    .callsTo("POST", new RegExp(`^/channels/${channelId}/messages$`, "u"))
    .filter((call) => (call.body as { embeds?: unknown[] }).embeds?.length);
  expect(previews).toHaveLength(2);
}, 60_000);

test("deleting the trigger mid-run still posts the final answer", async () => {
  const channelId = discord.channel("deleted-trigger");
  const gate = await barrier();
  const tag = e2e.model.script("discord-deleted-trigger", (_request, model) => {
    if (model.step === 0) return { toolCalls: [{ name: "bash", args: { command: gate.command } }] };
    return { text: "Answer after the trigger was deleted." };
  });
  const trigger = discord.userMessage({
    channelId,
    content: `${tag} Run the long task.`,
    mentionBot: true,
  });
  await previewShowing(channelId, "read line");
  discord.deleteMessage(trigger.id);
  await gate.release();
  const reply = "Answer after the trigger was deleted.";

  const final = await settledReply(channelId, reply);

  // The reply target is gone, so Discord posts the answer as a plain message.
  expect(final.map((message) => [message.content, message.message_reference])).toEqual([
    [reply, undefined],
  ]);
  expect(postsContaining(channelId, reply).map((call) => call.status)).toEqual([200]);
}, 60_000);

/** The first user message text in a scenario's model requests that contains the needle. */
function userTextContaining(scenario: string, needle: string): string {
  for (const entry of e2e.model.forScenario(scenario))
    for (const message of entry.request.messages)
      if (message.role === "user" && message.text.includes(needle)) return message.text;
  throw new Error(`The model never saw "${needle}"`);
}

/** The LILAC_META header Core adds to a Discord user message for the model. */
function metaOf(text: string): { user_id?: string; message_id?: string } {
  const match = /<LILAC_META:v1>(.*?)<\/LILAC_META:v1>/su.exec(text);
  return match ? JSON.parse(match[1]!) : {};
}

test("a mention reply to the running output steers the run with the user's authority", async () => {
  const channelId = discord.channel("steer");
  const toolGate = await barrier();
  const jobGate = await barrier();
  const isJobEvent = (text: string) => text.includes('"tool":"job"') && text.includes("job-done");
  const tag = e2e.model.script("discord-steer", (request, model) => {
    const texts = request.messages.map((message) =>
      message.role === "tool" ? message.output : message.text,
    );
    if (texts.some(isJobEvent)) return { text: "Job finished." };
    if (model.lastToolResults.some((result) => result.name === "job"))
      return { text: "Steered reply about penguins." };
    if (model.userTexts.some((text) => text.includes("Also mention penguins")))
      return {
        toolCalls: [
          {
            name: "job",
            args: {
              action: "start",
              mode: "service",
              // The wake request is built from the transcript; the label routes it here.
              label: `${tag} penguins`,
              command: jobGate.command.replace("released:", "job-done:"),
            },
          },
        ],
      };
    if (model.step === 0)
      return { toolCalls: [{ name: "bash", args: { command: toolGate.command } }] };
    return { text: "Unsteered reply." };
  });
  discord.userMessage({ channelId, content: `${tag} Run the long task.`, mentionBot: true });
  const preview = await previewShowing(channelId, "read line");
  const steer = discord.userMessage({
    channelId,
    content: "Also mention penguins.",
    mentionBot: true,
    replyTo: preview.id,
  });
  // The router re-anchors the reply to the steer before it publishes the steer itself.
  await discord.waitFor(
    () =>
      discord.messages.get(preview.id)?.embeds[0]?.description === FROZEN_PREVIEW &&
      discord.botMessages(channelId).some(isLivePreview),
    "re-anchored preview",
  );
  await toolGate.release();

  const final = await settledReply(channelId, "Steered reply about penguins.");

  expect(final.map((message) => message.content)).toEqual(["Steered reply about penguins."]);
  // The answer replies to the steer message, the new anchor.
  expect(
    postsContaining(channelId, "Steered reply about penguins.").map((call) =>
      replyTarget(call.body),
    ),
  ).toEqual([steer.id]);
  expect(postsContaining(channelId, "Unsteered reply.")).toEqual([]);
  expect(metaOf(userTextContaining("discord-steer", "Also mention penguins"))).toMatchObject({
    user_id: discord.human.id,
    message_id: steer.id,
  });

  // A job started after the steer belongs to the steering user's turn. When it ends after the
  // run, its wake needs that user's authenticated origin and threads under the steer.
  await jobGate.release();
  await discord.waitFor(
    () => postsContaining(channelId, "Job finished.").length > 0,
    "job wake reply",
  );
  expect(postsContaining(channelId, "Job finished.").map((call) => replyTarget(call.body))).toEqual(
    [steer.id],
  );
}, 60_000);

test("a plain reply to the running output is answered as a follow-up after the run", async () => {
  const channelId = discord.channel("follow-up");
  const gate = await barrier();
  const tag = e2e.model.script("discord-follow-up", (_request, model) => {
    if (model.lastUserText.includes("And the weather?")) return { text: "Follow-up answered." };
    if (model.step === 0) return { toolCalls: [{ name: "bash", args: { command: gate.command } }] };
    return { text: "First answer." };
  });
  const trigger = discord.userMessage({
    channelId,
    content: `${tag} Run the long task.`,
    mentionBot: true,
  });
  const preview = await previewShowing(channelId, "read line");
  const followUp = discord.userMessage({
    channelId,
    content: "And the weather?",
    replyTo: preview.id,
  });
  await gate.release();

  await discord.waitFor(
    () => postsContaining(channelId, "Follow-up answered.").length > 0,
    "follow-up reply",
  );
  await settledReply(channelId, "Follow-up answered.");

  expect(
    ["First answer.", "Follow-up answered."].map((text) =>
      postsContaining(channelId, text).map((call) => replyTarget(call.body)),
    ),
  ).toEqual([[trigger.id], [followUp.id]]);
  expect(metaOf(userTextContaining("discord-follow-up", "And the weather?"))).toMatchObject({
    user_id: discord.human.id,
    message_id: followUp.id,
  });
}, 60_000);
