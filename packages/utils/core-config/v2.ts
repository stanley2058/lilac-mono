import { z } from "zod";

import { cloneDefaultDiscordWorkingIndicators } from "../discord-working-indicators";

import {
  coreConfigInputSchemaV1,
  agentRetrySchema,
  heartbeatSchema,
  jsonObjectSchema,
  modelCapabilityCostPatchSchema,
  modelCapabilityLimitPatchSchema,
  modelCapabilityModalitiesPatchSchema,
  pluginsSchema,
  routerSchema,
  statsForNerdsSchema,
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

const modelReasoningEffortSchema = z.enum([
  "provider-default",
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
]);

const subagentProfileSchemaV2 = z
  .object({
    modelSlot: z.enum(["main", "fast"]).default("main"),
    /** Optional direct model ref (provider/model or alias from models.def). */
    model: z.string().min(1).optional(),
    /** Optional portable AI SDK reasoning effort. */
    reasoning: modelReasoningEffortSchema.optional(),
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

const modelCapabilityOverrideSchemaV2 = z
  .object({
    /** Optional base model capability spec to inherit from (provider/model). */
    inherit: z.string().trim().min(1).optional(),
    /** Optional partial cost patch merged onto inherited/base cost. */
    cost: modelCapabilityCostPatchSchema.optional(),
    /** Optional partial limit patch merged onto inherited/base limits. */
    limit: modelCapabilityLimitPatchSchema.optional(),
    /** Optional attachment input support patch merged onto inherited/base capability. */
    attachment: z.boolean().optional(),
    /** Optional partial modalities patch merged onto inherited/base modalities. */
    modalities: modelCapabilityModalitiesPatchSchema.optional(),
  })
  .superRefine((input, ctx) => {
    if (
      !input.inherit &&
      !input.cost &&
      !input.limit &&
      input.attachment === undefined &&
      !input.modalities
    ) {
      ctx.addIssue({
        code: "custom",
        message:
          "override must set at least one of inherit, cost, limit, attachment, or modalities",
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

const modelCapabilitySchemaV2 = z
  .object({
    /** Providers to always treat as unknown/unresolved capability. */
    forceUnknownProviders: z.array(z.string().trim().min(1)).default(["openai-compatible"]),
    /** Optional capability overrides keyed by provider/model spec. */
    overrides: z.record(z.string().trim().min(1), modelCapabilityOverrideSchemaV2).default({}),
  })
  .default({
    forceUnknownProviders: ["openai-compatible"],
    overrides: {},
  });

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
        explore: subagentProfileSchemaV2.default({ modelSlot: "main" }),
        general: subagentProfileSchemaV2.default({ modelSlot: "main" }),
        self: subagentProfileSchemaV2.default({ modelSlot: "main" }),
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
    fsBackend: z.enum(["fff", "node-rg"]).default("fff"),
    web: webExtractConfigSchema,
    inspect: z
      .object({
        model: z.string().trim().min(1).default("google/gemini-3.5-flash"),
      })
      .default({
        model: "google/gemini-3.5-flash",
      }),
    editFile: z
      .object({
        hashline: z.boolean().default(true),
      })
      .default({
        hashline: true,
      }),
  })
  .default({
    fsBackend: "fff",
    web: {
      extract: {
        providers: ["tavily"],
      },
      fetch: {
        mode: "auto",
      },
    },
    inspect: {
      model: "google/gemini-3.5-flash",
    },
    editFile: {
      hashline: true,
    },
  });

const conversationSchemaV2 = z
  .object({
    thread: z
      .object({
        summarization: z
          .object({
            enabled: z.boolean().default(false),
            model: z.string().trim().min(1).default("fast"),
            concurrency: z.number().int().min(1).max(128).default(1),
            includePromptContext: z.boolean().default(false),
          })
          .default({
            enabled: false,
            model: "fast",
            concurrency: 1,
            includePromptContext: false,
          }),
        embedding: z
          .object({
            enabled: z.boolean().default(false),
            model: z.string().trim().min(1).default("openai/text-embedding-3-small"),
          })
          .default({ enabled: false, model: "openai/text-embedding-3-small" }),
        autoInject: z
          .object({
            enabled: z.boolean().default(false),
            plannerModel: z.string().trim().min(1).optional(),
            minTextUnits: z.number().int().positive().default(80),
            followUpMinTextUnits: z.number().int().positive().default(110),
            limit: z.number().int().positive().max(10).default(3),
            mode: z.enum(["hybrid", "semantic", "lexical"]).default("hybrid"),
            filterCurrentParticipants: z.boolean().default(false),
          })
          .default({
            enabled: false,
            minTextUnits: 80,
            followUpMinTextUnits: 110,
            limit: 3,
            mode: "hybrid",
            filterCurrentParticipants: false,
          }),
      })
      .default({
        summarization: {
          enabled: false,
          model: "fast",
          concurrency: 1,
          includePromptContext: false,
        },
        embedding: { enabled: false, model: "openai/text-embedding-3-small" },
        autoInject: {
          enabled: false,
          minTextUnits: 80,
          followUpMinTextUnits: 110,
          limit: 3,
          mode: "hybrid",
          filterCurrentParticipants: false,
        },
      }),
  })
  .default({
    thread: {
      summarization: {
        enabled: false,
        model: "fast",
        concurrency: 1,
        includePromptContext: false,
      },
      embedding: { enabled: false, model: "openai/text-embedding-3-small" },
      autoInject: {
        enabled: false,
        minTextUnits: 80,
        followUpMinTextUnits: 110,
        limit: 3,
        mode: "hybrid",
        filterCurrentParticipants: false,
      },
    },
  });

const modelsSchemaV2 = z
  .object({
    /** Optional registry of reusable model presets, referenced by alias. */
    def: z
      .record(
        z.string().min(1),
        z.object({
          /** Canonical model spec in provider/model format. */
          model: z.string().min(1),
          /** Portable AI SDK reasoning effort. */
          reasoning: modelReasoningEffortSchema.optional(),
          /** AI SDK providerOptions-style object (nested JSON allowed). */
          options: jsonObjectSchema.optional(),
        }),
      )
      .default({}),

    main: z
      .object({
        /** Model spec in provider/model format OR an alias from models.def. */
        model: z.string().min(1).default("openrouter/openai/gpt-4o"),
        /** Portable AI SDK reasoning effort. */
        reasoning: modelReasoningEffortSchema.optional(),
        /** Provider-specific model options. */
        options: jsonObjectSchema.optional(),
      })
      .default({
        model: "openrouter/openai/gpt-4o",
      }),

    /** Fast/cheap model for lightweight features (router gate, etc.). */
    fast: z
      .object({
        model: z.string().min(1).default("openrouter/openai/gpt-4o-mini"),
        reasoning: modelReasoningEffortSchema.optional(),
        options: jsonObjectSchema.optional(),
      })
      .default({
        model: "openrouter/openai/gpt-4o-mini",
      }),

    capability: modelCapabilitySchemaV2,
  })
  .default({
    def: {},
    main: { model: "openrouter/openai/gpt-4o" },
    fast: { model: "openrouter/openai/gpt-4o-mini" },
    capability: {
      forceUnknownProviders: ["openai-compatible"],
      overrides: {},
    },
  });

export const coreConfigInputSchemaV2 = z.object({
  configVersion: configVersionSchema,

  tools: toolsSchema,
  plugins: pluginsSchema,
  conversation: conversationSchemaV2,

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
      retry: agentRetrySchema,
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
      retry: {
        enabled: true,
        maxRetries: 3,
        baseDelayMs: 2_000,
        maxDelayMs: 30_000,
      },
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

  models: modelsSchemaV2,
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
