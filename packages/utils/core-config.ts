import path from "node:path";
import { z } from "zod";

import { env } from "./env";

export const coreConfigSchema = z.object({
  surface: z
    .object({
      discord: z
        .object({
          tokenEnv: z.string().min(1).default("DISCORD_TOKEN"),
          allowedChannelIds: z.array(z.string().min(1)).default([]),
          allowedGuildIds: z.array(z.string().min(1)).default([]),
          dbPath: z.string().min(1).optional(),
          botName: z
            .string()
            .min(1)
            .refine((s) => !/\s/u.test(s), "botName must not contain spaces"),
          statusMessage: z.string().optional(),

          router: z
            .object({
              /** Default behavior for channels unless overridden by sessionModes. */
              defaultMode: z.enum(["mention", "active"]).default("mention"),
              /** Per-session routing mode overrides. Key is session/channel id. */
              sessionModes: z
                .record(
                  z.string().min(1),
                  z.object({ mode: z.enum(["mention", "active"]) }),
                )
                .default({}),
              /** Debounce window (ms) for active mode initial prompt batching. */
              activeDebounceMs: z.number().int().positive().default(3000),
            })
            .default({
              defaultMode: "mention",
              sessionModes: {},
              activeDebounceMs: 3000,
            }),
        })
        .default({
          tokenEnv: "DISCORD_TOKEN",
          allowedChannelIds: [],
          allowedGuildIds: [],
          botName: "lilac",
          router: {
            defaultMode: "mention",
            sessionModes: {},
            activeDebounceMs: 3000,
          },
        }),
    })
    .default({
      discord: {
        tokenEnv: "DISCORD_TOKEN",
        allowedChannelIds: [],
        allowedGuildIds: [],
        botName: "lilac",
        router: {
          defaultMode: "mention",
          sessionModes: {},
          activeDebounceMs: 3000,
        },
      },
    }),

  agent: z
    .object({
      systemPrompt: z.string().min(1).default("You are lilac."),
    })
    .default({
      systemPrompt: "You are lilac.",
    }),

  models: z
    .object({
      main: z
        .object({
          model: z.string().min(1).default("openrouter/openai/gpt-4o"),
          options: z
            .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
            .optional(),
        })
        .default({
          model: "openrouter/openai/gpt-4o",
        }),
    })
    .default({
      main: { model: "openrouter/openai/gpt-4o" },
    }),
});

export type CoreConfig = z.infer<typeof coreConfigSchema>;

let cached: CoreConfig | null = null;
let cachedMtimeMs: number | null = null;

function configPath(): string {
  return path.join(env.dataDir, "core-config.yaml");
}

function safeParseYaml(raw: string): unknown {
  try {
    return Bun.YAML.parse(raw) as unknown;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`Failed to parse core-config.yaml: ${msg}`);
  }
}

export async function getCoreConfig(options?: {
  /** Bypass cache and re-read from disk. */
  forceReload?: boolean;
}): Promise<CoreConfig> {
  const forceReload = options?.forceReload ?? false;
  const filePath = configPath();

  if (!forceReload && cached) {
    try {
      const stat = await Bun.file(filePath).stat();
      if (cachedMtimeMs !== null && stat.mtimeMs === cachedMtimeMs) {
        return cached;
      }
    } catch {
      // If stat fails, fall through to re-read to produce a better error.
    }
  }

  const raw = await Bun.file(filePath).text();
  const parsed = safeParseYaml(raw);
  const cfg = coreConfigSchema.parse(parsed);

  cached = cfg;
  try {
    const stat = await Bun.file(filePath).stat();
    cachedMtimeMs = stat.mtimeMs;
  } catch {
    cachedMtimeMs = null;
  }

  return cfg;
}

export function resolveDiscordDbPath(cfg: CoreConfig): string {
  return (
    cfg.surface.discord.dbPath ?? path.join(env.dataDir, "discord-surface.db")
  );
}

export function resolveDiscordToken(cfg: CoreConfig): string {
  const key = cfg.surface.discord.tokenEnv;
  const value = process.env[key];
  if (!value) {
    throw new Error(
      `Discord token missing: env var ${key} is not set (set it or change surface.discord.tokenEnv in core-config.yaml)`,
    );
  }
  return value;
}
