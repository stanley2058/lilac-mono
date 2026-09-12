import { describe, expect, test } from "bun:test";
import { Result } from "better-result";
import { isNode, parseDocument } from "yaml";

import type {
  CodexOAuthLoginResult,
  StartCodexOAuthLoginOptions,
} from "../../../packages/utils/codex-oauth";
import type { JSONValue } from "../../../packages/utils/core-config/types";
import { canUseDiscordChannel, configureDiscord, discordInviteUrl } from "../src/discord";
import { configureProviders, PROVIDERS, validateProvider, type SetupFetch } from "../src/providers";
import type { Prompt, SetupDraft } from "../src/types";

type Answer = { kind: "text" | "select"; value?: string } | { kind: "confirm"; value: boolean };
class ScriptedPrompt implements Prompt {
  readonly notes: string[] = [];
  readonly messages: string[] = [];
  constructor(readonly answers: Answer[]) {}
  async text(options: { message: string; initial?: string; required?: boolean }): Promise<string> {
    this.messages.push(options.message);
    const answer = this.answers.shift();
    expect(answer?.kind).toBe("text");
    if (answer?.kind !== "text") throw new Error(`Missing text answer: ${options.message}`);
    return answer.value ?? options.initial ?? "";
  }
  async select<T extends string>(
    message: string,
    choices: readonly { value: T; label: string }[],
    initial?: T,
  ): Promise<T> {
    this.messages.push(message);
    const answer = this.answers.shift();
    expect(answer?.kind).toBe("select");
    if (answer?.kind !== "select") throw new Error(`Missing selection: ${message}`);
    const selected = choices.find((choice) => choice.value === (answer.value ?? initial));
    if (!selected) throw new Error(`Selection unavailable: ${answer.value} for ${message}`);
    return selected.value;
  }
  async confirm(message: string): Promise<boolean> {
    this.messages.push(message);
    const answer = this.answers.shift();
    expect(answer?.kind).toBe("confirm");
    if (answer?.kind !== "confirm") throw new Error(`Missing confirmation: ${message}`);
    return answer.value;
  }
  note(message: string): void {
    this.notes.push(message);
  }
  done(): void {
    expect(this.answers).toHaveLength(0);
  }
}

function draft(initial = "", existing: Record<string, string> = {}): SetupDraft {
  const document = parseDocument(initial);
  return {
    get: (path) => {
      const value = document.getIn(path, true);
      return (isNode(value) ? value.toJSON() : value) as JSONValue | undefined;
    },
    set: (path, value) => document.setIn(path, value),
    remove: (path) => {
      document.deleteIn(path);
    },
    secrets: {},
    files: [],
    stagingDir: "/unused-staging",
    computerEnabled: false,
    readExistingFile: async (path) => existing[path],
  };
}
const text = (value?: string): Answer => ({ kind: "text", value });
const select = (value?: string): Answer => ({ kind: "select", value });
const confirm = (value: boolean): Answer => ({ kind: "confirm", value });

describe("provider setup", () => {
  for (const provider of PROVIDERS.filter((entry) => entry.id !== "codex")) {
    test(`configures ${provider.id} with separate model and reasoning fields`, async () => {
      const state = draft();
      const custom = !provider.main;
      const answers: Answer[] = [select(provider.id)];
      if (provider.id === "openai-compatible") answers.push(text("http://provider:8080/v1"));
      answers.push(
        text("fixture-key"),
        text(custom ? "custom-model" : undefined),
        select(),
        text(),
        ...(custom ? [] : [select()]),
        select("done"),
      );
      const prompt = new ScriptedPrompt(answers);
      const requests: { url: string; authorization: string | null; anthropicKey: string | null }[] =
        [];
      await configureProviders(prompt, state, {
        fetch: async (url, init) => {
          const headers = new Headers(init?.headers);
          requests.push({
            url,
            authorization: headers.get("Authorization"),
            anthropicKey: headers.get("x-api-key"),
          });
          return Response.json({ data: [] });
        },
      });
      prompt.done();
      expect(state.get(["models", "main", "model"])).toBe(
        `${provider.id}/${provider.main || "custom-model"}`,
      );
      expect(state.get(["models", "main", "reasoning"])).toBe(provider.mainReasoning);
      expect(state.get(["models", "fast", "model"])).toBe(
        `${provider.id}/${provider.fast || "custom-model"}`,
      );
      expect(state.get(["models", "fast", "reasoning"])).toBe(
        custom ? provider.mainReasoning : provider.fastReasoning,
      );
      expect(state.secrets[provider.key]).toBe("fixture-key");
      expect(requests).toHaveLength(1);
      expect(
        provider.id === "anthropic" ? requests[0]?.anthropicKey : requests[0]?.authorization,
      ).toBe(provider.id === "anthropic" ? "fixture-key" : "Bearer fixture-key");
      expect(prompt.notes.join("\n")).not.toContain("fixture-key");
    });
  }

  test("rejects failed credentials and retains the previous key for retry", async () => {
    const state = draft();
    const prompt = new ScriptedPrompt([
      select("openai"),
      text("bad-key"),
      confirm(true),
      text("good-key"),
      text(),
      select(),
      text(),
      select(),
      select("done"),
    ]);
    let calls = 0;
    await configureProviders(prompt, state, {
      fetch: async () => new Response("", { status: ++calls === 1 ? 401 : 200 }),
    });
    expect(calls).toBe(2);
    expect(state.secrets.OPENAI_API_KEY).toBe("good-key");
    expect(prompt.notes.join("\n")).toContain("rejected these credentials");
    prompt.done();
  });

  test("chooses different configured providers for main and fast", async () => {
    const state = draft();
    const prompt = new ScriptedPrompt([
      select("openai"),
      text("openai-key"),
      text(),
      select(),
      text(),
      select(),
      select("anthropic"),
      text("anthropic-key"),
      text(),
      select(),
      text(),
      select(),
      select("done"),
      select("anthropic"),
      select("openai"),
    ]);
    await configureProviders(prompt, state, { fetch: async () => Response.json({}) });
    expect(state.get(["models", "main", "model"])).toBe("anthropic/opus-5");
    expect(state.get(["models", "fast", "model"])).toBe("openai/gpt-5.6-luna");
    expect(Object.keys(state.secrets)).toEqual(["OPENAI_API_KEY", "ANTHROPIC_API_KEY"]);
    prompt.done();
  });

  test("retains existing model options and custom defaults", async () => {
    const state = draft(
      "models:\n  main:\n    model: openai/custom\n    reasoning: high\n    options:\n      temperature: 0.5\n  fast:\n    model: openai/custom-fast\n    reasoning: none\n",
    );
    const prompt = new ScriptedPrompt([
      select("openai"),
      text("key"),
      text(),
      select(),
      text(),
      select(),
      select("done"),
    ]);
    await configureProviders(prompt, state, { fetch: async () => Response.json({}) });
    expect(state.get(["models", "main", "model"])).toBe("openai/custom");
    expect(state.get(["models", "main", "options", "temperature"])).toBe(0.5);
    expect(state.get(["models", "fast", "reasoning"])).toBe("none");
    prompt.done();
  });

  test("stages Codex credentials until installation is confirmed", async () => {
    const state = draft();
    const prompt = new ScriptedPrompt([
      select("codex"),
      text("http://localhost:1455/auth/callback?code=fixture&state=fixture"),
      text(),
      select(),
      text(),
      select(),
      select("done"),
    ]);
    let closes = 0;
    let options: StartCodexOAuthLoginOptions | undefined;
    await configureProviders(prompt, state, {
      startOAuth: async (input) => {
        options = input;
        const deferred = Promise.withResolvers<CodexOAuthLoginResult>();
        const exchange = async () => {
          await input.writeTokens!({
            type: "oauth",
            access: "fixture-access",
            refresh: "fixture-refresh",
            expires: 12345,
          });
          const result = { ok: true as const, storagePath: input.storagePath!, expires: 12345 };
          deferred.resolve(result);
          return result;
        };
        return {
          authorizeUrl: "https://auth.example/authorize",
          redirectUri: "http://localhost:1455/auth/callback",
          port: 1455,
          state: "fixture",
          pkce: { verifier: "fixture", challenge: "fixture" },
          storagePath: input.storagePath!,
          result: deferred.promise,
          exchange,
          exchangeResult: async () => Result.ok(await exchange()),
          close: async () => {
            closes++;
          },
        };
      },
    });
    expect(options?.callbackServer).toBe("optional");
    expect(state.files).toHaveLength(1);
    expect(state.files[0]?.relativePath).toBe("secret/codex.json");
    expect(state.files[0]?.mode).toBe(0o600);
    expect(JSON.parse(state.files[0]!.content).refresh).toBe("fixture-refresh");
    expect(closes).toBe(1);
    expect(prompt.notes.join("\n")).not.toContain("fixture-refresh");
    prompt.done();
  });

  test("keeps an existing Codex login without starting OAuth", async () => {
    const state = draft("", {
      "secret/codex.json": JSON.stringify({
        type: "oauth",
        access: "fixture-access",
        refresh: "fixture-refresh",
        expires: 12345,
      }),
    });
    const prompt = new ScriptedPrompt([
      select("codex"),
      confirm(true),
      text(),
      select(),
      text(),
      select(),
      select("done"),
    ]);
    await configureProviders(prompt, state, {
      startOAuth: async () => {
        throw new Error("must not start OAuth");
      },
    });
    expect(state.files).toHaveLength(0);
    prompt.done();
  });

  test("reopening provider setup recognizes a staged Codex login", async () => {
    const state = draft(
      "models:\n  main:\n    model: codex/custom-main\n  fast:\n    model: codex/custom-fast\n",
    );
    state.files.push({
      relativePath: "secret/codex.json",
      content: JSON.stringify({
        type: "oauth",
        access: "fixture-access",
        refresh: "fixture-refresh",
        expires: 12345,
      }),
      mode: 0o600,
    });
    const keepPrompt = new ScriptedPrompt([select("done")]);
    await configureProviders(keepPrompt, state, {
      startOAuth: async () => {
        throw new Error("must not start OAuth");
      },
    });
    keepPrompt.done();
    const editPrompt = new ScriptedPrompt([
      select("codex"),
      confirm(true),
      text(),
      select(),
      text(),
      select(),
      select("done"),
    ]);
    await configureProviders(editPrompt, state, {
      startOAuth: async () => {
        throw new Error("must not start OAuth");
      },
    });
    editPrompt.done();
    expect(state.files).toHaveLength(1);
    expect(state.get(["models", "main", "model"])).toBe("codex/custom-main");
  });

  test("rejects credential-bearing URLs before sending a request", async () => {
    const result = await validateProvider(
      "openai-compatible",
      "key",
      "http://user:password@provider/v1",
      async () => {
        throw new Error("must not fetch");
      },
    );
    expect(result.isErr()).toBe(true);
  });

  test("checks host.docker.internal through localhost while preserving the container URL", async () => {
    const state = draft();
    const prompt = new ScriptedPrompt([
      select("openai-compatible"),
      text("http://host.docker.internal:8080/v1"),
      text(""),
      text("local-model"),
      select(),
      text(),
      select("done"),
    ]);
    let requested = "";
    await configureProviders(prompt, state, {
      fetch: async (url) => {
        requested = url;
        return Response.json({ data: [] });
      },
    });
    expect(requested).toBe("http://localhost:8080/v1/models");
    expect(state.secrets.OPENAI_COMPATIBLE_BASE_URL).toBe("http://host.docker.internal:8080/v1");
    prompt.done();
  });

  test("keeps unchanged model aliases and their inherited settings on rerun", async () => {
    const state = draft(
      "models:\n  def:\n    custom:\n      model: openai/custom-model\n      reasoning: high\n      fallback: ['openai/fallback-model']\n  main:\n    model: custom\n  fast:\n    model: custom\n",
    );
    const prompt = new ScriptedPrompt([
      select("openai"),
      text("key"),
      text(),
      select(),
      text(),
      select(),
      select("done"),
    ]);
    await configureProviders(prompt, state, { fetch: async () => Response.json({}) });
    expect(state.get(["models", "main", "model"])).toBe("custom");
    expect(state.get(["models", "main", "reasoning"])).toBe("high");
    expect(state.get(["models", "def", "custom", "fallback"])).toEqual(["openai/fallback-model"]);
    prompt.done();
  });

  test("asks before clearing custom slot settings when the selected provider changes", async () => {
    const state = draft(
      "models:\n  main:\n    model: anthropic/old-model\n    options:\n      anthropic:\n        thinking:\n          type: adaptive\n    fallback: ['anthropic/old-fallback']\n",
    );
    const prompt = new ScriptedPrompt([
      select("openai"),
      text("key"),
      text(),
      select(),
      text(),
      select(),
      select("done"),
      confirm(false),
    ]);
    await configureProviders(prompt, state, { fetch: async () => Response.json({}) });
    expect(state.get(["models", "main", "model"])).toBe("openai/gpt-5.6-sol");
    expect(state.get(["models", "main", "options"])).toBeUndefined();
    expect(state.get(["models", "main", "fallback"])).toBeUndefined();
    prompt.done();
  });

  test("updating one provider preserves other configured slot providers and alias defaults", async () => {
    const state = draft(
      "models:\n  def:\n    primary:\n      model: anthropic/custom-main\n      reasoning: high\n  main:\n    model: primary\n  fast:\n    model: openai/custom-fast\n    reasoning: low\n",
    );
    state.secrets.ANTHROPIC_API_KEY = "old-anthropic-key";
    state.secrets.OPENAI_API_KEY = "existing-openai-key";
    const prompt = new ScriptedPrompt([
      select("anthropic"),
      text("new-anthropic-key"),
      text(),
      select(),
      text(),
      select(),
      select("done"),
      select(),
      select(),
    ]);
    await configureProviders(prompt, state, { fetch: async () => Response.json({}) });
    expect(state.secrets.ANTHROPIC_API_KEY).toBe("new-anthropic-key");
    expect(state.get(["models", "main", "model"])).toBe("primary");
    expect(state.get(["models", "main", "reasoning"])).toBe("high");
    expect(state.get(["models", "fast", "model"])).toBe("openai/custom-fast");
    expect(state.secrets.OPENAI_API_KEY).toBe("existing-openai-key");
    prompt.done();
  });
});

const ALL_CHANNEL_PERMISSIONS = "117760";
function discordFixture(): { fetch: SetupFetch; requests: string[] } {
  const requests: string[] = [];
  return {
    requests,
    fetch: async (url, init) => {
      expect(init?.method ?? "GET").toBe("GET");
      expect(new Headers(init?.headers).get("Authorization")).toBe("Bot fixture-token");
      const route = new URL(url).pathname.replace("/api/v10", "");
      requests.push(route);
      switch (route) {
        case "/users/@me":
          return Response.json({ id: "123", username: "Fixture", bot: true });
        case "/oauth2/applications/@me":
          return Response.json({ id: "456", flags: 0 });
        case "/users/@me/guilds":
          return Response.json([{ id: "789", name: "Fixture server" }]);
        case "/guilds/789/channels":
          return Response.json([
            { id: "111", name: "allowed", type: 0 },
            {
              id: "222",
              name: "denied",
              type: 0,
              permission_overwrites: [{ id: "123", type: 1, allow: "0", deny: "2048" }],
            },
          ]);
        case "/guilds/789/roles":
          return Response.json([{ id: "789", permissions: ALL_CHANNEL_PERMISSIONS }]);
        case "/guilds/789/members/123":
          return Response.json({ roles: [] });
        default:
          throw new Error(`Unexpected request: ${route}`);
      }
    },
  };
}

describe("Discord setup", () => {
  test("selects permitted channels and stages mention-only configuration", async () => {
    const state = draft();
    const prompt = new ScriptedPrompt([
      text("fixture-token"),
      confirm(false),
      text(),
      select("789"),
      select("channels"),
      select("111"),
      select("done"),
      confirm(false),
      select(),
      confirm(false),
    ]);
    const fixture = discordFixture();
    await configureDiscord(prompt, state, fixture);
    expect(state.secrets.DISCORD_TOKEN).toBe("fixture-token");
    expect(state.get(["surface", "discord", "allowedChannelIds"])).toEqual(["111"]);
    expect(state.get(["surface", "discord", "allowedGuildIds"])).toEqual([]);
    expect(state.get(["surface", "router", "defaultMode"])).toBe("mention");
    expect(state.get(["surface", "discord", "memberPresence"])).toBe(false);
    expect(prompt.notes.join("\n")).toContain("Enable Message Content Intent");
    expect(prompt.notes.join("\n")).not.toContain("fixture-token");
    prompt.done();
  });

  test("preserves existing admission rules and custom token variable", async () => {
    const state = draft(
      "surface:\n  discord:\n    tokenEnv: MY_BOT_TOKEN\n    allowedChannelIds: ['111']\n    allowedGuildIds: ['999']\n  router:\n    defaultMode: active\n",
    );
    state.secrets.MY_BOT_TOKEN = "fixture-token";
    const prompt = new ScriptedPrompt([
      text(),
      confirm(true),
      text(),
      confirm(true),
      select(),
      confirm(false),
    ]);
    const fixture = discordFixture();
    await configureDiscord(prompt, state, fixture);
    expect(state.get(["surface", "discord", "allowedGuildIds"])).toEqual(["999"]);
    expect(state.get(["surface", "router", "defaultMode"])).toBe("active");
    expect(state.secrets.DISCORD_TOKEN).toBeUndefined();
    expect(fixture.requests).toHaveLength(2);
    expect(prompt.notes.join("\n")).toContain(
      "Also enable Server Members Intent and Presence Intent",
    );
    prompt.done();
  });

  test("applies member overwrites after role permissions", () => {
    const roles = [{ id: "guild", permissions: ALL_CHANNEL_PERMISSIONS }];
    expect(
      canUseDiscordChannel("guild", "bot", [], roles, { id: "channel", name: "test", type: 0 }),
    ).toBe(true);
    expect(
      canUseDiscordChannel("guild", "bot", [], roles, {
        id: "channel",
        name: "test",
        type: 0,
        permission_overwrites: [{ id: "bot", type: 1, allow: "0", deny: "2048" }],
      }),
    ).toBe(false);
    expect(
      canUseDiscordChannel(
        "guild",
        "bot",
        ["admin"],
        [...roles, { id: "admin", permissions: "8" }],
        {
          id: "channel",
          name: "test",
          type: 0,
          permission_overwrites: [{ id: "bot", type: 1, allow: "0", deny: "2048" }],
        },
      ),
    ).toBe(true);
  });

  test("clears an existing Discord status through an explicit choice", async () => {
    const state = draft(
      "surface:\n  discord:\n    allowedChannelIds: ['111']\n    statusMessage: busy\n",
    );
    const prompt = new ScriptedPrompt([
      text("fixture-token"),
      confirm(false),
      text(),
      confirm(true),
      select(),
      confirm(true),
      text(),
      select("clear"),
    ]);
    await configureDiscord(prompt, state, discordFixture());
    expect(state.get(["surface", "discord", "statusMessage"])).toBeUndefined();
    prompt.done();
  });

  test("invite grants messaging permissions without pretending to enable intents", () => {
    const url = new URL(discordInviteUrl("123"));
    expect(url.searchParams.get("client_id")).toBe("123");
    expect(url.searchParams.get("scope")).toBe("bot applications.commands");
    expect(url.searchParams.has("intents")).toBe(false);
    expect(BigInt(url.searchParams.get("permissions")!) & 8n).toBe(0n);
  });
});
