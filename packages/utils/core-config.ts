import path from "node:path";
import fs from "node:fs/promises";
import { z } from "zod";

import { env } from "./env";
import { findWorkspaceRoot } from "./find-root";
import {
  buildAgentSystemPrompt,
  promptWorkspaceSignature,
} from "./agent-prompts";

export type JSONValue =
  | null
  | string
  | number
  | boolean
  | JSONObject
  | JSONArray;
export type JSONArray = JSONValue[];
export type JSONObject = {
  [key: string]: JSONValue | undefined;
};

const jsonValueSchema: z.ZodType<JSONValue> = z.lazy(() =>
  z.union([
    z.null(),
    z.string(),
    z.number(),
    z.boolean(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
);

const jsonObjectSchema: z.ZodType<JSONObject> = z.record(
  z.string(),
  jsonValueSchema,
);

type AgentConfig = {
  systemPrompt: string;
  statsForNerds?: boolean | { verbose: boolean };
  subagents?: {
    enabled: boolean;
    maxDepth: number;
    defaultTimeoutMs: number;
    maxTimeoutMs: number;
    profiles: {
      explore: {
        modelSlot: "main" | "fast";
        promptOverlay?: string;
      };
    };
  };
};

const statsForNerdsSchema = z
  .union([
    z.boolean(),
    z.object({
      verbose: z.boolean().default(false),
    }),
  ])
  .default(false);

const subagentProfileSchema = z.object({
  modelSlot: z.enum(["main", "fast"]).default("main"),
  promptOverlay: z.string().min(1).optional(),
});

const subagentsSchema = z
  .object({
    enabled: z.boolean().default(true),
    maxDepth: z.number().int().min(0).max(1).default(1),
    defaultTimeoutMs: z
      .number()
      .int()
      .positive()
      .max(8 * 60 * 1000)
      .default(3 * 60 * 1000),
    maxTimeoutMs: z
      .number()
      .int()
      .positive()
      .max(8 * 60 * 1000)
      .default(8 * 60 * 1000),
    profiles: z
      .object({
        explore: subagentProfileSchema.default({ modelSlot: "main" }),
      })
      .default({
        explore: { modelSlot: "main" },
      }),
  })
  .superRefine((input, ctx) => {
    if (input.defaultTimeoutMs > input.maxTimeoutMs) {
      ctx.addIssue({
        code: "custom",
        path: ["defaultTimeoutMs"],
        message: "defaultTimeoutMs must be <= maxTimeoutMs",
      });
    }
  });

const routerSchema = z
  .object({
    /** Default behavior for channels unless overridden by sessionModes. */
    defaultMode: z.enum(["mention", "active"]).default("mention"),
    /** Per-session routing mode overrides. Key is session/channel id. */
    sessionModes: z
      .record(
        z.string().min(1),
        z.object({
          mode: z.enum(["mention", "active"]),
          /** Override activeGate.enabled for this session/channel (active mode only). */
          gate: z.boolean().optional(),
        }),
      )
      .default({}),
    /** Debounce window (ms) for active mode initial prompt batching. */
    activeDebounceMs: z.number().int().positive().default(3000),

    /** Active channel gate to prevent replying to everything. */
    activeGate: z
      .object({
        enabled: z.boolean().default(false),
        timeoutMs: z.number().int().positive().default(2500),
      })
      .default({ enabled: false, timeoutMs: 2500 }),
  })
  .default({
    defaultMode: "mention",
    sessionModes: {},
    activeDebounceMs: 3000,
    activeGate: { enabled: false, timeoutMs: 2500 },
  });

const discordSurfaceSchema = z
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

    /** Optional mention notification behavior for bot-authored messages. */
    mentionNotifications: z
      .object({
        /** If true, send a dedicated mention-only ping message in active-mode sessions. */
        enabled: z.boolean().default(false),
        /** Max distinct users to ping per response. */
        maxUsers: z.number().int().positive().max(25).default(5),
      })
      .default({ enabled: false, maxUsers: 5 }),
  })
  .default({
    tokenEnv: "DISCORD_TOKEN",
    allowedChannelIds: [],
    allowedGuildIds: [],
    botName: "lilac",
    mentionNotifications: { enabled: false, maxUsers: 5 },
  });

export const coreConfigSchema = z.object({
  surface: z
    .object({
      router: routerSchema,
      discord: discordSurfaceSchema,
    })
    .default({
      router: {
        defaultMode: "mention",
        sessionModes: {},
        activeDebounceMs: 3000,
        activeGate: { enabled: false, timeoutMs: 2500 },
      },
      discord: {
        tokenEnv: "DISCORD_TOKEN",
        allowedChannelIds: [],
        allowedGuildIds: [],
        botName: "lilac",
        mentionNotifications: { enabled: false, maxUsers: 5 },
      },
    }),

  agent: z
    .object({
      statsForNerds: statsForNerdsSchema,
      subagents: subagentsSchema.default({
        enabled: true,
        maxDepth: 1,
        defaultTimeoutMs: 3 * 60 * 1000,
        maxTimeoutMs: 8 * 60 * 1000,
        profiles: {
          explore: { modelSlot: "main" },
        },
      }),
    })
    .default({
      statsForNerds: false,
      subagents: {
        enabled: true,
        maxDepth: 1,
        defaultTimeoutMs: 3 * 60 * 1000,
        maxTimeoutMs: 8 * 60 * 1000,
        profiles: {
          explore: { modelSlot: "main" },
        },
      },
    }),

  models: z
    .object({
      /** Optional registry of reusable model presets, referenced by alias. */
      def: z
        .record(
          z.string().min(1),
          z.object({
            /** Canonical model spec in provider/model format. */
            model: z.string().min(1),
            /** AI SDK providerOptions-style object (nested JSON allowed). */
            options: jsonObjectSchema.optional(),
          }),
        )
        .default({}),

      main: z
        .object({
          /**
           * Model spec in provider/model format OR an alias from models.def.
           *
           * If no '/' is present, the value is treated as an alias.
           */
          model: z.string().min(1).default("openrouter/openai/gpt-4o"),
          /**
           * Provider-specific model options.
           *
           * Supports either:
           * - shorthand: { temperature: 0.2 }
           * - providerOptions map: { openai: { temperature: 0.2 }, gateway: { order: [...] } }
           */
          options: jsonObjectSchema.optional(),
        })
        .default({
          model: "openrouter/openai/gpt-4o",
        }),

      /**
       * Fast/cheap model for lightweight features (router gate, etc.).
       *
       * This is intentionally separate from `models.main`.
       */
      fast: z
        .object({
          model: z.string().min(1).default("openrouter/openai/gpt-4o-mini"),
          options: jsonObjectSchema.optional(),
        })
        .default({
          model: "openrouter/openai/gpt-4o-mini",
        }),
    })
    .default({
      def: {},
      main: { model: "openrouter/openai/gpt-4o" },
      fast: { model: "openrouter/openai/gpt-4o-mini" },
    }),

  entity: z
    .object({
      users: z
        .record(z.string().min(1), z.object({ discord: z.string().min(1) }))
        .default({}),

      sessions: z
        .object({
          discord: z.record(z.string().min(1), z.string().min(1)).default({}),
        })
        .default({ discord: {} }),
    })
    .default({ users: {}, sessions: { discord: {} } })
    .optional(),

  basePrompt: z.string().optional(),
});

export type CoreConfig = Omit<z.infer<typeof coreConfigSchema>, "agent"> & {
  agent: AgentConfig;
};

let cached: CoreConfig | null = null;
let cachedMtimeMs: number | null = null;
let cachedPromptMaxMtimeMs: number | null = null;

export function resolveCoreConfigPath(options?: { dataDir?: string }): string {
  const dataDir = options?.dataDir ?? env.dataDir;
  return path.join(dataDir, "core-config.yaml");
}

async function resolveCoreConfigTemplatePath(): Promise<string> {
  // Prefer an internal template so docker volume mounts can't hide it.
  const internal = path.join(
    import.meta.dir,
    "config-templates",
    "core-config.example.yaml",
  );
  if (await Bun.file(internal).exists()) return internal;

  // Back-compat for older layouts.
  return path.resolve(findWorkspaceRoot(), "data", "core-config.example.yaml");
}

export async function seedCoreConfig(options?: {
  dataDir?: string;
  overwrite?: boolean;
}): Promise<{
  dataDir: string;
  configPath: string;
  created: boolean;
  overwritten: boolean;
}> {
  const dataDir = options?.dataDir ?? env.dataDir;
  const overwrite = options?.overwrite ?? false;

  await fs.mkdir(dataDir, { recursive: true });
  // Keep: helps empty dirs survive in git checkouts; harmless in docker.
  await Bun.write(path.join(dataDir, ".gitkeep"), "");

  const configPath = resolveCoreConfigPath({ dataDir });
  const existed = await Bun.file(configPath).exists();

  if (!existed || overwrite) {
    const templatePath = await resolveCoreConfigTemplatePath();
    const template = await Bun.file(templatePath).text();
    await Bun.write(configPath, template);
  }

  return {
    dataDir,
    configPath,
    created: !existed,
    overwritten: existed && overwrite,
  };
}

async function ensureDataDirSeeded() {
  await seedCoreConfig({ overwrite: false });
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

  await ensureDataDirSeeded();

  const filePath = resolveCoreConfigPath();

  if (!forceReload && cached) {
    try {
      const stat = await Bun.file(filePath).stat();
      const promptSig = await promptWorkspaceSignature();

      if (
        cachedMtimeMs !== null &&
        stat.mtimeMs === cachedMtimeMs &&
        cachedPromptMaxMtimeMs !== null &&
        promptSig.maxMtimeMs === cachedPromptMaxMtimeMs
      ) {
        return cached;
      }
    } catch {
      // If stat/signature fails, fall through to re-read to produce a better error.
    }
  }

  const raw = await Bun.file(filePath).text();
  const parsed = safeParseYaml(raw);
  const cfg = coreConfigSchema.parse(parsed);

  // Always use file-based system prompt (data/prompts/*).
  // This also ensures missing files are created from templates.
  const built = await buildAgentSystemPrompt({ basePrompt: cfg.basePrompt });
  const nextCfg: CoreConfig = {
    ...cfg,
    agent: {
      ...cfg.agent,
      systemPrompt: built.systemPrompt,
    },
  };

  cached = nextCfg;
  try {
    const stat = await Bun.file(filePath).stat();
    cachedMtimeMs = stat.mtimeMs;
  } catch {
    cachedMtimeMs = null;
  }

  try {
    const sig = await promptWorkspaceSignature();
    cachedPromptMaxMtimeMs = sig.maxMtimeMs;
  } catch {
    cachedPromptMaxMtimeMs = null;
  }

  return nextCfg;
}

export function resolveDiscordDbPath(cfg: CoreConfig): string {
  return (
    cfg.surface.discord.dbPath ?? path.join(env.dataDir, "discord-surface.db")
  );
}

export function resolveTranscriptDbPath(): string {
  return path.join(env.dataDir, "agent-transcripts.db");
}

export function resolveDiscordSearchDbPath(): string {
  return path.join(env.dataDir, "discord-search.db");
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
