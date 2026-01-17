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
        })
        .default({
          tokenEnv: "DISCORD_TOKEN",
          allowedChannelIds: [],
          allowedGuildIds: [],
          botName: "lilac",
        }),
    })
    .default({
      discord: {
        tokenEnv: "DISCORD_TOKEN",
        allowedChannelIds: [],
        allowedGuildIds: [],
        botName: "lilac",
      },
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
