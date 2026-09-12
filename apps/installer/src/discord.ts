import { Result, TaggedError, type Result as ResultType } from "better-result";
import { z } from "zod";

import type { SetupFetch } from "./providers";
import type { Prompt, SetupDraft } from "./types";
import { setSetupSecret } from "./setup-draft";

const DISCORD_API = "https://discord.com/api/v10";
const INVITE_PERMISSIONS = 1024n | 2048n | 65536n | 16384n | 32768n | 64n | 262144n | 274877906944n;
const CHANNEL_PERMISSIONS = 1024n | 2048n | 65536n | 16384n | 32768n;
const botSchema = z.object({ id: z.string(), username: z.string(), bot: z.literal(true) });
const applicationSchema = z.object({ id: z.string(), flags: z.number().optional() });
const guildSchema = z.object({ id: z.string(), name: z.string() });
const rolesSchema = z.array(z.object({ id: z.string(), permissions: z.string().regex(/^\d+$/) }));
const memberSchema = z.object({ roles: z.array(z.string()) });
const overwriteSchema = z.object({
  id: z.string(),
  type: z.number(),
  allow: z.string().regex(/^\d+$/),
  deny: z.string().regex(/^\d+$/),
});
const channelSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.number(),
  permission_overwrites: z.array(overwriteSchema).optional(),
});
type DiscordChannel = z.infer<typeof channelSchema>;
type DiscordRole = z.infer<typeof rolesSchema>[number];
type DiscordIdentity = {
  bot: z.infer<typeof botSchema>;
  application: z.infer<typeof applicationSchema>;
};

export class DiscordCheckFailed extends TaggedError("DiscordCheckFailed")<{ message: string }> {}

async function requestDiscord<T>(
  token: string,
  route: string,
  schema: z.ZodType<T>,
  fetchFn: SetupFetch,
): Promise<ResultType<T, DiscordCheckFailed>> {
  const requested = await Result.tryPromise({
    try: () =>
      fetchFn(`${DISCORD_API}${route}`, {
        headers: { Authorization: `Bot ${token}` },
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
      }),
    catch: () =>
      new DiscordCheckFailed({
        message: "Could not reach Discord. Check your network connection and retry.",
      }),
  });
  const response = requested.match<Response | DiscordCheckFailed>({
    ok: (value) => value,
    err: (error) => error,
  });
  if (DiscordCheckFailed.is(response)) return Result.err(response);
  if (response.status === 401)
    return Result.err(
      new DiscordCheckFailed({
        message: "Discord rejected this bot token. Copy the token from the application's Bot page.",
      }),
    );
  if (response.status === 403)
    return Result.err(
      new DiscordCheckFailed({
        message: "Discord denied access. Check the bot's server membership and permissions.",
      }),
    );
  if (!response.ok)
    return Result.err(
      new DiscordCheckFailed({
        message: `Discord returned HTTP ${response.status}. Retry after checking its service status and the bot's permissions.`,
      }),
    );
  const decoded = await Result.tryPromise({
    try: () => response.json() as Promise<unknown>,
    catch: () =>
      new DiscordCheckFailed({
        message: "Discord returned an unreadable response. Retry the request.",
      }),
  });
  return decoded.andThen((value) => {
    const parsed = schema.safeParse(value);
    return parsed.success
      ? Result.ok(parsed.data)
      : Result.err(
          new DiscordCheckFailed({
            message: "Discord returned an unexpected response. Retry or update the installer.",
          }),
        );
  });
}

export function discordInviteUrl(applicationId: string): string {
  const query = new URLSearchParams({
    client_id: applicationId,
    scope: "bot applications.commands",
    permissions: INVITE_PERMISSIONS.toString(),
  });
  return `https://discord.com/oauth2/authorize?${query}`;
}

export function canUseDiscordChannel(
  guildId: string,
  botId: string,
  memberRoles: readonly string[],
  roles: readonly DiscordRole[],
  channel: DiscordChannel,
): boolean {
  const roleIds = new Set([guildId, ...memberRoles]);
  let permissions = roles
    .filter((role) => roleIds.has(role.id))
    .reduce((value, role) => value | BigInt(role.permissions), 0n);
  if ((permissions & 8n) !== 0n) return true;
  const overwrites = channel.permission_overwrites ?? [];
  const everyone = overwrites.find((entry) => entry.type === 0 && entry.id === guildId);
  if (everyone) permissions = (permissions & ~BigInt(everyone.deny)) | BigInt(everyone.allow);
  const matching = overwrites.filter(
    (entry) => entry.type === 0 && entry.id !== guildId && roleIds.has(entry.id),
  );
  const denied = matching.reduce((value, entry) => value | BigInt(entry.deny), 0n);
  const allowed = matching.reduce((value, entry) => value | BigInt(entry.allow), 0n);
  permissions = (permissions & ~denied) | allowed;
  const member = overwrites.find((entry) => entry.type === 1 && entry.id === botId);
  if (member) permissions = (permissions & ~BigInt(member.deny)) | BigInt(member.allow);
  return (permissions & CHANNEL_PERMISSIONS) === CHANNEL_PERMISSIONS;
}

async function validatedToken(
  prompt: Prompt,
  draft: SetupDraft,
  fetchFn: SetupFetch,
): Promise<{ token: string; identity: DiscordIdentity }> {
  const tokenEnv = draft.get(["surface", "discord", "tokenEnv"]);
  const key = typeof tokenEnv === "string" ? tokenEnv : "DISCORD_TOKEN";
  let token = draft.secrets[key] ?? "";
  while (true) {
    token = await prompt.text({
      message: "Discord bot token",
      initial: token,
      required: true,
      secret: true,
    });
    const botResult = await requestDiscord(token, "/users/@me", botSchema, fetchFn);
    const bot = botResult.match<z.infer<typeof botSchema> | DiscordCheckFailed>({
      ok: (value) => value,
      err: (error) => error,
    });
    if (DiscordCheckFailed.is(bot)) {
      prompt.note(bot.message);
      continue;
    }
    const applicationResult = await requestDiscord(
      token,
      "/oauth2/applications/@me",
      applicationSchema,
      fetchFn,
    );
    const application = applicationResult.match<
      z.infer<typeof applicationSchema> | DiscordCheckFailed
    >({ ok: (value) => value, err: (error) => error });
    if (DiscordCheckFailed.is(application)) {
      prompt.note(application.message);
      continue;
    }
    setSetupSecret(draft, key, token);
    draft.set(["surface", "discord", "tokenEnv"], key);
    prompt.note(`Connected as ${bot.username}.`);
    return { token, identity: { bot, application } };
  }
}

async function selectGuild(
  prompt: Prompt,
  token: string,
  fetchFn: SetupFetch,
): Promise<z.infer<typeof guildSchema>> {
  while (true) {
    const guilds: z.infer<typeof guildSchema>[] = [];
    let after = "";
    let failed = false;
    while (true) {
      const response = await requestDiscord(
        token,
        `/users/@me/guilds?limit=200${after ? `&after=${after}` : ""}`,
        z.array(guildSchema),
        fetchFn,
      );
      const page = response.match<z.infer<typeof guildSchema>[] | DiscordCheckFailed>({
        ok: (value) => value,
        err: (error) => error,
      });
      if (DiscordCheckFailed.is(page)) {
        prompt.note(page.message);
        failed = true;
        break;
      }
      guilds.push(...page);
      if (page.length < 200) break;
      after = page[page.length - 1]!.id;
    }
    if (failed || !guilds.length) {
      if (!failed)
        prompt.note(
          "The bot has not joined any servers. Complete the invite flow above, then retry.",
        );
      await prompt.text({ message: "Press Enter to refresh Discord servers" });
      continue;
    }
    const selected = await prompt.select(
      "Discord server",
      guilds.map((guild) => ({ value: guild.id, label: `${guild.name} (${guild.id})` })),
    );
    return guilds.find((guild) => guild.id === selected)!;
  }
}

async function selectChannels(
  prompt: Prompt,
  token: string,
  botId: string,
  guildId: string,
  fetchFn: SetupFetch,
): Promise<string[]> {
  while (true) {
    const channelsResult = await requestDiscord(
      token,
      `/guilds/${guildId}/channels`,
      z.array(channelSchema),
      fetchFn,
    );
    const channels = channelsResult.match<DiscordChannel[] | DiscordCheckFailed>({
      ok: (value) => value,
      err: (error) => error,
    });
    if (DiscordCheckFailed.is(channels)) {
      prompt.note(channels.message);
      await prompt.text({ message: "Press Enter to retry channels" });
      continue;
    }
    const rolesResult = await requestDiscord(
      token,
      `/guilds/${guildId}/roles`,
      rolesSchema,
      fetchFn,
    );
    const roles = rolesResult.match<DiscordRole[] | DiscordCheckFailed>({
      ok: (value) => value,
      err: (error) => error,
    });
    if (DiscordCheckFailed.is(roles)) {
      prompt.note(roles.message);
      await prompt.text({ message: "Press Enter to retry permissions" });
      continue;
    }
    const memberResult = await requestDiscord(
      token,
      `/guilds/${guildId}/members/${botId}`,
      memberSchema,
      fetchFn,
    );
    const member = memberResult.match<z.infer<typeof memberSchema> | DiscordCheckFailed>({
      ok: (value) => value,
      err: (error) => error,
    });
    if (DiscordCheckFailed.is(member)) {
      prompt.note(member.message);
      await prompt.text({ message: "Press Enter to retry membership" });
      continue;
    }
    const available = channels.filter(
      (channel) =>
        (channel.type === 0 || channel.type === 5) &&
        canUseDiscordChannel(guildId, botId, member.roles, roles, channel),
    );
    if (!available.length) {
      prompt.note(
        "No usable text channels found. Grant View Channel, Send Messages, Read Message History, Embed Links, and Attach Files, then retry.",
      );
      await prompt.text({ message: "Press Enter to refresh channel permissions" });
      continue;
    }
    const selected: string[] = [];
    while (true) {
      const choices = available
        .filter((channel) => !selected.includes(channel.id))
        .map((channel) => ({ value: channel.id, label: `#${channel.name} (${channel.id})` }));
      if (selected.length)
        choices.push({ value: "done", label: "Continue with selected channels" });
      const choice = await prompt.select(
        "Allow Lilac in channel",
        choices,
        selected.length ? "done" : undefined,
      );
      if (choice === "done") return selected;
      selected.push(choice);
    }
  }
}

function stringList(value: ReturnType<SetupDraft["get"]>): string[] {
  const parsed = z.array(z.string()).safeParse(value);
  return parsed.data ?? [];
}

async function configureRules(
  prompt: Prompt,
  draft: SetupDraft,
  token: string,
  botId: string,
  fetchFn: SetupFetch,
): Promise<void> {
  const currentChannels = stringList(draft.get(["surface", "discord", "allowedChannelIds"]));
  const currentGuilds = stringList(draft.get(["surface", "discord", "allowedGuildIds"]));
  if (
    (currentChannels.length || currentGuilds.length) &&
    (await prompt.confirm("Keep the existing Discord channel and server rules?", true))
  )
    return;
  const channelIds: string[] = [];
  const guildIds: string[] = [];
  while (true) {
    const guild = await selectGuild(prompt, token, fetchFn);
    const scope = await prompt.select(
      "Where should Lilac respond in this server?",
      [
        { value: "channels", label: "Choose specific channels" },
        { value: "guild", label: "All accessible channels in this server" },
      ],
      "channels",
    );
    if (scope === "guild") guildIds.push(guild.id);
    else channelIds.push(...(await selectChannels(prompt, token, botId, guild.id, fetchFn)));
    if (!(await prompt.confirm("Add rules for another server?", false))) break;
  }
  draft.set(["surface", "discord", "allowedChannelIds"], [...new Set(channelIds)]);
  draft.set(["surface", "discord", "allowedGuildIds"], [...new Set(guildIds)]);
}

export async function configureDiscord(
  prompt: Prompt,
  draft: SetupDraft,
  dependencies: { fetch?: SetupFetch } = {},
): Promise<void> {
  const fetchFn = dependencies.fetch ?? fetch;
  const { token, identity } = await validatedToken(prompt, draft, fetchFn);
  const presence = await prompt.confirm(
    "Enable member presence? Requires extra Discord intents",
    draft.get(["surface", "discord", "memberPresence"]) === true,
  );
  draft.set(["surface", "discord", "memberPresence"], presence);
  prompt.note(
    `Invite Lilac to your server:\n${discordInviteUrl(identity.application.id)}\nBot settings:\nhttps://discord.com/developers/applications/${identity.application.id}/bot\nEnable Message Content Intent.${presence ? " Also enable Server Members Intent and Presence Intent." : " Server Members and Presence intents are optional and remain disabled in Lilac."}\nInvite URLs grant permissions. Privileged intents must be enabled in Bot settings.`,
  );
  await prompt.text({ message: "Press Enter after checking intents and inviting the bot" });
  await configureRules(prompt, draft, token, identity.bot.id, fetchFn);
  const currentMode = draft.get(["surface", "router", "defaultMode"]);
  const mode = await prompt.select(
    "When should Lilac respond?",
    [
      { value: "mention", label: "Only when mentioned or replied to" },
      { value: "active", label: "Every message in allowed channels" },
    ],
    currentMode === "active" ? "active" : "mention",
  );
  draft.set(["surface", "router", "defaultMode"], mode);
  if (!(await prompt.confirm("Customize bot name and status message?", false))) return;
  const currentName = draft.get(["surface", "discord", "botName"]);
  while (true) {
    const name = await prompt.text({
      message: "Bot name used by Lilac (no spaces)",
      initial: typeof currentName === "string" ? currentName : "lilac",
      required: true,
    });
    if (/\s/.test(name)) {
      prompt.note("The bot name must not contain spaces.");
      continue;
    }
    draft.set(["surface", "discord", "botName"], name);
    break;
  }
  const currentStatus = draft.get(["surface", "discord", "statusMessage"]);
  if (typeof currentStatus === "string" && currentStatus) {
    const action = await prompt.select(
      "Existing status message",
      [
        { value: "keep", label: `Keep: ${currentStatus}` },
        { value: "change", label: "Change status message" },
        { value: "clear", label: "Clear status message" },
      ],
      "keep",
    );
    if (action === "keep") return;
    if (action === "clear") {
      draft.remove(["surface", "discord", "statusMessage"]);
      return;
    }
  }
  const status = await prompt.text({
    message: "Status message (optional)",
  });
  if (status) draft.set(["surface", "discord", "statusMessage"], status);
  else draft.remove(["surface", "discord", "statusMessage"]);
}
