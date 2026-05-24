import { z } from "zod";

import { cloneDefaultDiscordWorkingIndicators } from "../discord-working-indicators";

import {
  coreConfigInputSchemaV1,
  heartbeatSchema,
  pluginsSchema,
  routerSchema,
  statsForNerdsSchema,
  subagentProfileSchema,
  webExtractConfigSchema,
} from "./v1";

import type { ConfigParser, CoreConfigVersion, UniversalCoreConfig } from "./types";

export const V2_CORE_CONFIG_VERSION = 2 satisfies CoreConfigVersion;
export const CURRENT_CORE_CONFIG_VERSION = V2_CORE_CONFIG_VERSION;
export const DEFAULT_CORE_CONFIG_VERSION = 1 satisfies CoreConfigVersion;
export const SUPPORTED_CORE_CONFIG_VERSIONS = [
  1, 2,
] as const satisfies readonly CoreConfigVersion[];

const configVersionSchema = z.literal(V2_CORE_CONFIG_VERSION).default(V2_CORE_CONFIG_VERSION);

const reasoningDisplaySchema = z.enum(["none", "simple", "detailed"]).default("detailed");

const subagentsSchemaV2 = z
  .object({
    enabled: z.boolean().default(true),
    maxDepth: z.number().int().min(0).max(2).default(2),
    defaultTimeoutMs: z
      .number()
      .int()
      .positive()
      .default(10 * 60 * 1000),
    maxTimeoutMs: z
      .number()
      .int()
      .positive()
      .default(20 * 60 * 1000),
    profiles: z
      .object({
        explore: subagentProfileSchema.default({ modelSlot: "main" }),
        general: subagentProfileSchema.default({ modelSlot: "main" }),
        self: subagentProfileSchema.default({ modelSlot: "main" }),
      })
      .default({
        explore: { modelSlot: "main" },
        general: { modelSlot: "main" },
        self: { modelSlot: "main" },
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

const discordMarkdownTableRenderSchema = z
  .object({
    enabled: z.boolean().default(true),
    style: z.enum(["unicode", "ascii"]).default("unicode"),
    maxWidth: z.number().int().min(40).max(240).default(50),
    fallbackMode: z.enum(["list", "passthrough"]).default("list"),
  })
  .default({
    enabled: true,
    style: "unicode",
    maxWidth: 50,
    fallbackMode: "list",
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
      .refine((s) => !/\s/u.test(s), "botName must not contain spaces")
      .default("lilac"),
    statusMessage: z.string().optional(),
    memberPresence: z.boolean().optional(),
    outputMode: z.enum(["inline", "preview"]).default("preview"),
    outputPreviewModeFinalStyle: z.enum(["embed", "plain"]).default("plain"),
    outputNotification: z.boolean().default(true),
    workingIndicators: z
      .array(z.string().trim().min(1))
      .min(1)
      .default(cloneDefaultDiscordWorkingIndicators()),
    markdownTableRender: discordMarkdownTableRenderSchema,
  })
  .default({
    tokenEnv: "DISCORD_TOKEN",
    allowedChannelIds: [],
    allowedGuildIds: [],
    botName: "lilac",
    outputMode: "preview",
    outputPreviewModeFinalStyle: "plain",
    outputNotification: true,
    workingIndicators: cloneDefaultDiscordWorkingIndicators(),
    markdownTableRender: {
      enabled: true,
      style: "unicode",
      maxWidth: 50,
      fallbackMode: "list",
    },
  });

const toolsSchema = z
  .object({
    web: webExtractConfigSchema,
    editFile: z
      .object({
        hashline: z.boolean().default(true),
      })
      .default({
        hashline: true,
      }),
  })
  .default({
    web: {
      extract: {
        providers: ["tavily"],
      },
      fetch: {
        mode: "auto",
      },
    },
    editFile: {
      hashline: true,
    },
  });

export const coreConfigInputSchemaV2 = z.object({
  configVersion: configVersionSchema,

  tools: toolsSchema,
  plugins: pluginsSchema,

  surface: z
    .object({
      router: routerSchema,
      discord: discordSurfaceSchema,
      heartbeat: heartbeatSchema,
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
        outputMode: "preview",
        outputPreviewModeFinalStyle: "plain",
        outputNotification: true,
        workingIndicators: cloneDefaultDiscordWorkingIndicators(),
        markdownTableRender: {
          enabled: true,
          style: "unicode",
          maxWidth: 50,
          fallbackMode: "list",
        },
      },
      heartbeat: {
        enabled: false,
        cron: "*/30 * * * *",
        quietAfterActivityMs: 5 * 60 * 1000,
        retryBusyMs: 60 * 1000,
        defaultOutputSession: undefined,
        softQuietHours: undefined,
      },
    }),

  agent: z
    .object({
      statsForNerds: statsForNerdsSchema,
      reasoningDisplay: reasoningDisplaySchema,
      subagents: subagentsSchemaV2.default({
        enabled: true,
        maxDepth: 2,
        defaultTimeoutMs: 10 * 60 * 1000,
        maxTimeoutMs: 20 * 60 * 1000,
        profiles: {
          explore: { modelSlot: "main" },
          general: { modelSlot: "main" },
          self: { modelSlot: "main" },
        },
      }),
    })
    .default({
      statsForNerds: false,
      reasoningDisplay: "detailed",
      subagents: {
        enabled: true,
        maxDepth: 2,
        defaultTimeoutMs: 10 * 60 * 1000,
        maxTimeoutMs: 20 * 60 * 1000,
        profiles: {
          explore: { modelSlot: "main" },
          general: { modelSlot: "main" },
          self: { modelSlot: "main" },
        },
      },
    }),

  models: coreConfigInputSchemaV1.shape.models,
  entity: coreConfigInputSchemaV1.shape.entity,
  basePrompt: z.string().optional(),
});

export type ParsedCoreConfigV2 = z.infer<typeof coreConfigInputSchemaV2>;

export function parseCoreConfigV2(raw: unknown): ParsedCoreConfigV2 {
  return coreConfigInputSchemaV2.parse(raw);
}

export function parseCoreConfigV2ToUniversal(raw: unknown): UniversalCoreConfig {
  const parsed = parseCoreConfigV2(raw);

  return {
    ...parsed,
    agent: {
      ...parsed.agent,
      systemPrompt: "",
    },
  };
}

export class V2CoreConfigParser implements ConfigParser {
  readonly version = V2_CORE_CONFIG_VERSION;

  async parse(input: object): Promise<UniversalCoreConfig> {
    return parseCoreConfigV2ToUniversal(input);
  }
}
