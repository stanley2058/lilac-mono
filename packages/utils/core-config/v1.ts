import { z } from "zod";

import { cloneDefaultDiscordWorkingIndicators } from "../discord-working-indicators";

import type {
  ConfigParser,
  CoreConfigVersion,
  JSONObject,
  JSONValue,
  UniversalCoreConfig,
} from "./types";

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

const jsonObjectSchema: z.ZodType<JSONObject> = z.record(z.string(), jsonValueSchema);

export const V1_CORE_CONFIG_VERSION = 1 satisfies CoreConfigVersion;

export const statsForNerdsSchema = z
  .union([
    z.boolean(),
    z.object({
      verbose: z.boolean().default(false),
    }),
  ])
  .default(false);

const reasoningDisplaySchema = z.enum(["none", "simple", "detailed"]).default("simple");

const discordAliasCommentSchema = z.string().trim().min(1).optional();

const discordUserAliasSchema = z.object({
  discord: z.string().min(1),
  comment: discordAliasCommentSchema,
});

const discordSessionAliasSchema = z.union([
  z.string().min(1),
  z.object({
    discord: z.string().min(1),
    comment: discordAliasCommentSchema,
  }),
]);

export const subagentProfileSchema = z
  .object({
    modelSlot: z.enum(["main", "fast"]).default("main"),
    /** Optional direct model ref (provider/model or alias from models.def). */
    model: z.string().min(1).optional(),
    /** Optional providerOptions override merged onto models.def.<alias>.options. */
    options: jsonObjectSchema.optional(),
    promptOverlay: z.string().min(1).optional(),
  })
  .superRefine((input, ctx) => {
    if (input.options && !input.model) {
      ctx.addIssue({
        code: "custom",
        path: ["options"],
        message: "options requires model to be set",
      });
    }
  });

export const subagentsSchema = z
  .object({
    enabled: z.boolean().default(true),
    maxDepth: z.number().int().min(0).max(2).default(2),
    defaultTimeoutMs: z
      .number()
      .int()
      .positive()
      .default(3 * 60 * 1000),
    maxTimeoutMs: z
      .number()
      .int()
      .positive()
      .default(8 * 60 * 1000),
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

export const routerSchema = z
  .object({
    /** Default behavior for channels unless overridden by sessionModes. */
    defaultMode: z.enum(["mention", "active"]).default("mention"),
    /** Per-session routing mode overrides. Key is session/channel id. */
    sessionModes: z
      .record(
        z.string().min(1),
        z.object({
          /** Optional per-session mode override (falls back to surface.router.defaultMode). */
          mode: z.enum(["mention", "active"]).optional(),
          /** Override activeGate.enabled for this session/channel (active mode only). */
          gate: z.boolean().optional(),
          /** Optional per-session model override (alias from models.def or provider/model). */
          model: z.string().trim().min(1).optional(),
          /** Optional per-session safety mode. Restricted mode is intended for public/untrusted channels. */
          safetyMode: z.enum(["trusted", "restricted"]).optional(),
          /**
           * Optional extra session memo entries appended to the system prompt.
           *
           * Each entry can be literal text or a file:// URL.
           */
          additionalPrompts: z.array(z.string()).optional(),
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

export const discordMarkdownTableRenderSchema = z
  .object({
    enabled: z.boolean().default(false),
    style: z.enum(["unicode", "ascii"]).default("unicode"),
    maxWidth: z.number().int().min(40).max(240).default(80),
    fallbackMode: z.enum(["list", "passthrough"]).default("list"),
  })
  .default({
    enabled: false,
    style: "unicode",
    maxWidth: 80,
    fallbackMode: "list",
  });

const discordExperimentalSchema = z
  .object({
    markdownTableRender: discordMarkdownTableRenderSchema,
  })
  .default({
    markdownTableRender: {
      enabled: false,
      style: "unicode",
      maxWidth: 80,
      fallbackMode: "list",
    },
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
    memberPresence: z.boolean().optional(),

    /** Output rendering mode for Discord reply streams. */
    outputMode: z.enum(["inline", "preview"]).default("inline"),

    /** Final reply style used after Discord preview mode finishes. */
    previewFinalOutputStyle: z.enum(["embed", "plain"]).default("embed"),

    /**
     * Optional global override for Discord output notifications.
     * true = allow reply ping + @mentions, false = suppress by default.
     */
    outputNotification: z.boolean().optional(),

    /** Streaming embed title phrases rotated while a request is in-progress. */
    workingIndicators: z
      .array(z.string().trim().min(1))
      .min(1)
      .default(cloneDefaultDiscordWorkingIndicators()),

    /** Experimental Discord-only output features. */
    experimental: discordExperimentalSchema,
  })
  .default({
    tokenEnv: "DISCORD_TOKEN",
    allowedChannelIds: [],
    allowedGuildIds: [],
    botName: "lilac",
    outputMode: "inline",
    previewFinalOutputStyle: "embed",
    workingIndicators: cloneDefaultDiscordWorkingIndicators(),
    experimental: {
      markdownTableRender: {
        enabled: false,
        style: "unicode",
        maxWidth: 80,
        fallbackMode: "list",
      },
    },
  });

const webExtractProviderSchema = z.enum(["tavily", "exa", "firecrawl"]);
const webFetchModeSchema = z
  .enum(["auto", "fetch", "browser", "extract", "provider-only"])
  .default("auto");

function uniqueItems<T>(items: readonly T[]): T[] {
  const seen = new Set<T>();
  const unique: T[] = [];
  for (const item of items) {
    if (seen.has(item)) continue;
    seen.add(item);
    unique.push(item);
  }
  return unique;
}

const webExtractProvidersSchema = z
  .array(webExtractProviderSchema)
  .min(1)
  .transform((providers) => uniqueItems(providers))
  .default(["tavily"]);

const webExtractConfigValueSchema = z.preprocess(
  (value) => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return value;
    }

    const extractConfig = value as {
      provider?: unknown;
      providers?: unknown;
    };

    if (extractConfig.providers !== undefined || extractConfig.provider === undefined) {
      return value;
    }

    return {
      ...extractConfig,
      providers: [extractConfig.provider],
    };
  },
  z.object({
    providers: webExtractProvidersSchema,
  }),
);

export const webExtractConfigSchema = z
  .preprocess(
    (value) => {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return value;
      }

      const webConfig = value as {
        extract?: unknown;
        search?: unknown;
      };

      if (webConfig.extract !== undefined || webConfig.search === undefined) {
        return value;
      }

      return {
        ...webConfig,
        extract: webConfig.search,
      };
    },
    z.object({
      extract: webExtractConfigValueSchema.default({
        providers: ["tavily"],
      }),
      fetch: z
        .object({
          mode: webFetchModeSchema,
        })
        .default({
          mode: "auto",
        }),
    }),
  )
  .default({
    extract: {
      providers: ["tavily"],
    },
    fetch: {
      mode: "auto",
    },
  });

const modelCapabilityModalitySchema = z.enum(["text", "image", "audio", "video", "pdf"]);

const modelCapabilityOver200kCostPatchSchema = z.object({
  input: z.number().nonnegative(),
  output: z.number().nonnegative(),
  cache_read: z.number().nonnegative().optional(),
  cache_write: z.number().nonnegative().optional(),
});

const modelCapabilityCostPatchSchema = z.object({
  input: z.number().nonnegative().optional(),
  output: z.number().nonnegative().optional(),
  cache_read: z.number().nonnegative().optional(),
  cache_write: z.number().nonnegative().optional(),
  input_audio: z.number().nonnegative().optional(),
  output_audio: z.number().nonnegative().optional(),
  context_over_200k: modelCapabilityOver200kCostPatchSchema.optional(),
});

const modelCapabilityLimitPatchSchema = z.object({
  context: z.number().int().positive().optional(),
  output: z.number().int().nonnegative().optional(),
});

const modelCapabilityModalitiesPatchSchema = z.object({
  input: z.array(modelCapabilityModalitySchema).optional(),
  output: z.array(modelCapabilityModalitySchema).optional(),
});

const modelCapabilityOverrideSchema = z
  .object({
    /** Optional base model capability spec to inherit from (provider/model). */
    inherit: z.string().trim().min(1).optional(),
    /** Optional partial cost patch merged onto inherited/base cost. */
    cost: modelCapabilityCostPatchSchema.optional(),
    /** Optional partial limit patch merged onto inherited/base limits. */
    limit: modelCapabilityLimitPatchSchema.optional(),
    /** Optional partial modalities patch merged onto inherited/base modalities. */
    modalities: modelCapabilityModalitiesPatchSchema.optional(),
  })
  .superRefine((input, ctx) => {
    if (!input.inherit && !input.cost && !input.limit && !input.modalities) {
      ctx.addIssue({
        code: "custom",
        message: "override must set at least one of inherit, cost, limit, or modalities",
      });
    }

    if (!input.inherit) {
      if (input.limit?.context === undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["limit", "context"],
          message: "limit.context is required when inherit is not set",
        });
      }

      if (input.cost && (input.cost.input === undefined || input.cost.output === undefined)) {
        ctx.addIssue({
          code: "custom",
          path: ["cost"],
          message: "cost.input and cost.output are required when inherit is not set",
        });
      }

      if (input.modalities && input.modalities.input === undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["modalities", "input"],
          message: "modalities.input is required when inherit is not set",
        });
      }
    }
  });

export const modelCapabilitySchema = z
  .object({
    /** Providers to always treat as unknown/unresolved capability. */
    forceUnknownProviders: z.array(z.string().trim().min(1)).default(["openai-compatible"]),
    /** Optional capability overrides keyed by provider/model spec. */
    overrides: z.record(z.string().trim().min(1), modelCapabilityOverrideSchema).default({}),
  })
  .default({
    forceUnknownProviders: ["openai-compatible"],
    overrides: {},
  });

const toolsSchema = z
  .object({
    web: webExtractConfigSchema,
    experimental_hashline_edit: z.boolean().default(false),
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
    experimental_hashline_edit: false,
  });

export const pluginsSchema = z
  .object({
    disabled: z.array(z.string().min(1)).default([]),
    config: z.record(z.string(), z.unknown()).default({}),
  })
  .default({
    disabled: [],
    config: {},
  });

const hhmmSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/u, "expected HH:MM");
const cronExpr5Schema = z
  .string()
  .trim()
  .refine((s) => s.split(/\s+/g).filter(Boolean).length === 5, "cron expr must be 5 fields");
const heartbeatOutputSessionSchema = z
  .string()
  .trim()
  .regex(/^(discord|github)\/.+$/u, "expected <client>/<sessionIdOrAlias>");

export const heartbeatSchema = z
  .object({
    enabled: z.boolean().default(false),
    cron: cronExpr5Schema.default("*/30 * * * *"),
    every: z.unknown().optional(),
    quietAfterActivityMs: z
      .number()
      .int()
      .nonnegative()
      .default(5 * 60 * 1000),
    retryBusyMs: z
      .number()
      .int()
      .positive()
      .default(60 * 1000),
    defaultOutputSession: heartbeatOutputSessionSchema.optional(),
    softQuietHours: z
      .object({
        start: hhmmSchema,
        end: hhmmSchema,
        timezone: z.string().trim().min(1).optional(),
      })
      .optional(),
  })
  .superRefine((value, ctx) => {
    if (value.every !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["every"],
        message: "surface.heartbeat.every has been removed; use surface.heartbeat.cron",
      });
    }
  })
  .transform((value) => ({
    enabled: value.enabled,
    cron: value.cron,
    quietAfterActivityMs: value.quietAfterActivityMs,
    retryBusyMs: value.retryBusyMs,
    defaultOutputSession: value.defaultOutputSession,
    softQuietHours: value.softQuietHours,
  }))
  .default({
    enabled: false,
    cron: "*/30 * * * *",
    quietAfterActivityMs: 5 * 60 * 1000,
    retryBusyMs: 60 * 1000,
    defaultOutputSession: undefined,
    softQuietHours: undefined,
  });
const configVersionSchema = z.literal(V1_CORE_CONFIG_VERSION).default(V1_CORE_CONFIG_VERSION);

export const coreConfigInputSchemaV1 = z.object({
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
        outputMode: "inline",
        previewFinalOutputStyle: "embed",
        workingIndicators: cloneDefaultDiscordWorkingIndicators(),
        experimental: {
          markdownTableRender: {
            enabled: false,
            style: "unicode",
            maxWidth: 80,
            fallbackMode: "list",
          },
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
      subagents: subagentsSchema.default({
        enabled: true,
        maxDepth: 2,
        defaultTimeoutMs: 3 * 60 * 1000,
        maxTimeoutMs: 8 * 60 * 1000,
        profiles: {
          explore: { modelSlot: "main" },
          general: { modelSlot: "main" },
          self: { modelSlot: "main" },
        },
      }),
    })
    .default({
      statsForNerds: false,
      reasoningDisplay: "simple",
      subagents: {
        enabled: true,
        maxDepth: 2,
        defaultTimeoutMs: 3 * 60 * 1000,
        maxTimeoutMs: 8 * 60 * 1000,
        profiles: {
          explore: { modelSlot: "main" },
          general: { modelSlot: "main" },
          self: { modelSlot: "main" },
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

      capability: modelCapabilitySchema,
    })
    .default({
      def: {},
      main: { model: "openrouter/openai/gpt-4o" },
      fast: { model: "openrouter/openai/gpt-4o-mini" },
      capability: {
        forceUnknownProviders: ["openai-compatible"],
        overrides: {},
      },
    }),

  entity: z
    .object({
      users: z.record(z.string().min(1), discordUserAliasSchema).default({}),

      sessions: z
        .object({
          discord: z.record(z.string().min(1), discordSessionAliasSchema).default({}),
        })
        .default({ discord: {} }),
    })
    .default({ users: {}, sessions: { discord: {} } })
    .optional(),

  basePrompt: z.string().optional(),
});

export const coreConfigSchema = coreConfigInputSchemaV1;

export type ParsedCoreConfigV1 = z.infer<typeof coreConfigInputSchemaV1>;

export function parseCoreConfigV1(raw: unknown): ParsedCoreConfigV1 {
  return coreConfigInputSchemaV1.parse(raw);
}

export function parseCoreConfigV1ToUniversal(raw: unknown): UniversalCoreConfig {
  const parsed = parseCoreConfigV1(raw);
  const { experimental_hashline_edit: hashline, ...toolsRest } = parsed.tools;
  const { previewFinalOutputStyle, experimental, ...discordRest } = parsed.surface.discord;

  return {
    ...parsed,
    tools: {
      ...toolsRest,
      editFile: {
        hashline,
      },
    },
    surface: {
      ...parsed.surface,
      discord: {
        ...discordRest,
        outputPreviewModeFinalStyle: previewFinalOutputStyle,
        markdownTableRender: experimental.markdownTableRender,
      },
    },
    agent: {
      ...parsed.agent,
      systemPrompt: "",
    },
  };
}

export class V1CoreConfigParser implements ConfigParser {
  readonly version = V1_CORE_CONFIG_VERSION;

  async parse(input: object): Promise<UniversalCoreConfig> {
    return parseCoreConfigV1ToUniversal(input);
  }
}
