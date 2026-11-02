import { Result, TaggedError, type Result as ResultType } from "better-result";
import { z } from "zod";

import { cloneDefaultWorkingIndicators } from "../working-indicators";

import { collectUnknownConfigKeyPaths } from "./unknown-keys";

import type {
  ConfigParser,
  CoreConfigParseOptions,
  CoreConfigVersion,
  JSONObject,
  JSONValue,
  UniversalCoreConfig,
} from "./types";
import {
  defaultNativeSurfaceConfig,
  DEFAULT_DISCORD_ATTACHMENT_CACHE_TTL_MS,
  DEFAULT_TRANSCRIPT_RETENTION_MAX_AGE_MS,
  DEFAULT_TRANSCRIPT_RETENTION_MAX_REQUESTS,
} from "./types";

export const jsonValueSchema: z.ZodType<JSONValue> = z.lazy(() =>
  z.union([
    z.null(),
    z.string(),
    z.number(),
    z.boolean(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
);

export const jsonObjectSchema: z.ZodType<JSONObject> = z.record(z.string(), jsonValueSchema);

export const V1_CORE_CONFIG_VERSION = 1 satisfies CoreConfigVersion;

export const statsForNerdsSchema = z
  .union([
    z.boolean(),
    z.object({
      verbose: z
        .boolean()
        .default(false)
        .describe(
          "Include input-composition statistics in addition to model, duration, time-to-first-token, and tokens-per-second statistics. Defaults to false.",
        ),
    }),
  ])
  .default(false);

const reasoningDisplaySchema = z.enum(["none", "simple", "detailed"]).default("simple");

const discordAliasCommentSchema = z.string().trim().min(1).optional();

const discordUserAliasSchema = z.object({
  discord: z
    .string()
    .min(1)
    .describe(
      "Quoted Discord user ID. Keep snowflake IDs as strings to avoid numeric precision loss.",
    ),
  comment: discordAliasCommentSchema.describe(
    "Context about this user injected into the system prompt alongside the alias and raw ID.",
  ),
});

const discordSessionAliasSchema = z.union([
  z.string().min(1),
  z.object({
    discord: z
      .string()
      .min(1)
      .describe(
        "Quoted Discord channel ID. Keep snowflake IDs as strings to avoid numeric precision loss.",
      ),
    comment: discordAliasCommentSchema.describe(
      "Context about this channel injected into the system prompt alongside the alias and raw ID.",
    ),
  }),
]);

export const subagentProfileSchema = z
  .object({
    modelSlot: z
      .enum(["main", "fast"])
      .default("main")
      .describe(
        "Legacy profile model setting accepted for configuration compatibility. The current runtime ignores per-profile model selection, reasoning, options, and fallback fields. Select models per delegation or through models.main.",
      ),
    /** Optional direct model ref (provider/model or alias from models.def). */
    model: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Legacy profile model setting accepted for configuration compatibility. The current runtime ignores per-profile model selection, reasoning, options, and fallback fields. Select models per delegation or through models.main.",
      ),
    /** Optional providerOptions override merged onto models.def.<alias>.options. */
    options: jsonObjectSchema
      .optional()
      .describe(
        "Legacy profile model setting accepted for configuration compatibility. The current runtime ignores per-profile model selection, reasoning, options, and fallback fields. Select models per delegation or through models.main. Legacy validation still requires model when options is supplied.",
      ),
    promptOverlay: z
      .string()
      .min(1)
      .optional()
      .describe(
        'Additional instructions appended to the worker prompt for children using this permission profile. For example, "Cite file paths and avoid edits."',
      ),
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
    enabled: z.boolean().default(true).describe("Enable delegated child agents. Defaults to true."),
    maxDepth: z
      .number()
      .int()
      .min(0)
      .max(2)
      .default(2)
      .describe(
        "Maximum delegation depth, with the primary agent at 0. Allowed range: 0 to 2. Children also need `delegation: true` in their permission profile.\n\nDefault: `2`.",
      ),
    defaultTimeoutMs: z
      .number()
      .int()
      .positive()
      .default(3 * 60 * 1000)
      .describe(
        "Legacy timeout accepted for compatibility and validated against maxTimeoutMs, but ignored by the current runtime. V1 uses a fixed 15-minute primary idle timeout; child idle timeout is 10 minutes.",
      ),
    maxTimeoutMs: z
      .number()
      .int()
      .positive()
      .default(8 * 60 * 1000)
      .describe(
        "Legacy timeout ceiling accepted for compatibility, but ignored by the current runtime. V1 child idle timeout is 10 minutes, derived from the fixed primary idle timeout.",
      ),
    profiles: z
      .object({
        explore: subagentProfileSchema
          .default({ modelSlot: "main" })
          .describe(
            "Legacy explore role, mapped to the restricted permission profile. Per-profile model fields are ignored by the current runtime.",
          ),
        general: subagentProfileSchema
          .default({ modelSlot: "main" })
          .describe(
            "Legacy general role, mapped to the general permission profile. Per-profile model fields are ignored by the current runtime.",
          ),
        self: subagentProfileSchema
          .default({ modelSlot: "main" })
          .describe(
            "Legacy self role, mapped to the full permission profile. Per-profile model fields are ignored by the current runtime.",
          ),
      })
      .default({
        explore: { modelSlot: "main" },
        general: { modelSlot: "main" },
        self: { modelSlot: "main" },
      })
      .describe(
        "Legacy role profiles mapped to permission profiles: explore becomes restricted, self becomes full, and general keeps its name. Per-profile model fields are ignored by the current runtime. Version 3 configures permissions directly.",
      ),
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
    defaultMode: z
      .enum(["mention", "active"])
      .default("mention")
      .describe(
        "Default channel routing. `mention` responds to mentions or replies to the bot; `active` treats a channel like a DM and considers every message. Defaults to mention.",
      ),
    /** Per-session overrides. Discord guild keys provide fallback values for every option. */
    sessionModes: z
      .record(
        z.string().min(1),
        z.object({
          /** Optional per-session mode override (falls back to surface.router.defaultMode). */
          mode: z
            .enum(["mention", "active"])
            .optional()
            .describe(
              "Override mention/active routing for this session. Omit to inherit the broader routing mode.",
            ),
          /** Override activeGate.enabled for this session/channel (active mode only). */
          gate: z
            .boolean()
            .optional()
            .describe("Override activeGate.enabled for this session. Only affects active mode."),
          /** Optional per-session model override (alias from models.def or provider/model). */
          model: z
            .string()
            .trim()
            .min(1)
            .optional()
            .describe(
              "Model reference in `provider/model` format or an alias from `models.def`. For example, `openai/gpt-4o`. Overrides the request model for this session.",
            ),
          /** Optional per-session safety mode. Restricted mode is intended for public/untrusted channels. */
          safetyMode: z
            .enum(["trusted", "restricted"])
            .optional()
            .describe(
              "`trusted` uses host tools; `restricted` uses restricted Bash with an overlay filesystem. Writes outside /tmp are discarded after the request; /tmp persists under /tmp/lilac-restricted/<sessionId>. Use for public or untrusted channels.",
            ),
          /**
           * Optional extra session memo entries appended to the system prompt.
           *
           * Each entry can be literal text or a file:// URL.
           */
          additionalPrompts: z
            .array(z.string())
            .optional()
            .describe(
              "Extra session memo entries appended to the system prompt. Each entry is literal text or a `file://` URL, such as `file:///abs/path/session-memo.md`. An empty list stops inheritance from broader sessions.",
            ),
        }),
      )
      .default({})
      .describe(
        "Overrides keyed by session/channel ID or Discord guild ID. Each option inherits independently: thread/channel, parent channel, guild, then global default. An explicit empty `additionalPrompts: []` stops broader prompt inheritance. Reserved keys `__heartbeat__` and `heartbeat` address the internal heartbeat lane.",
      ),
    /** Debounce window (ms) for active mode initial prompt batching. */
    activeDebounceMs: z
      .number()
      .int()
      .positive()
      .default(3000)
      .describe(
        "Milliseconds to batch initial prompts in active mode. Defaults to 3000; must be positive.",
      ),

    /** Active channel gate to prevent replying to everything. */
    activeGate: z
      .object({
        enabled: z
          .boolean()
          .default(false)
          .describe(
            "Run the active-channel decision gate. Defaults to false; individual sessions may override it.",
          ),
        timeoutMs: z
          .number()
          .int()
          .positive()
          .default(2500)
          .describe("Gate timeout in milliseconds. Defaults to 2500; must be positive."),
      })
      .default({ enabled: false, timeoutMs: 2500 })
      .describe(
        "Optional lightweight model gate before forwarding active-mode messages, to avoid replying to every message.",
      ),
  })
  .default({
    defaultMode: "mention",
    sessionModes: {},
    activeDebounceMs: 3000,
    activeGate: { enabled: false, timeoutMs: 2500 },
  });

export const discordMarkdownTableRenderSchema = z
  .object({
    enabled: z
      .boolean()
      .default(false)
      .describe(
        "Render Markdown tables for Discord. When disabled, tables remain ordinary Markdown.\n\nDefault: `false`.",
      ),
    style: z
      .enum(["unicode", "ascii", "image"])
      .default("unicode")
      .describe(
        '`unicode` and `ascii` render text tables. `image` renders top-level tables as PNG attachments in preview/plain/flat final output. Other output modes, streaming previews, and image failures fall back to unicode.\n\nDefault: `"unicode"`.',
      ),
    maxWidth: z
      .number()
      .int()
      .min(40)
      .max(240)
      .default(80)
      .describe(
        "Maximum text-table width in display cells, not bytes. Also applies to image fallback. Allowed range: 40 to 240.\n\nDefault: `80`.",
      ),
    fallbackMode: z
      .enum(["list", "passthrough"])
      .default("list")
      .describe(
        'When a table cannot fit maxWidth, `list` renders wrapped row/key-value text in a code block; `passthrough` preserves the original Markdown table.\n\nDefault: `"list"`.',
      ),
  })
  .default({
    enabled: false,
    style: "unicode",
    maxWidth: 80,
    fallbackMode: "list",
  });

const discordExperimentalSchema = z
  .object({
    markdownTableRender: discordMarkdownTableRenderSchema.describe(
      "Discord Markdown table rendering and overflow behavior.",
    ),
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
    tokenEnv: z
      .string()
      .min(1)
      .default("DISCORD_TOKEN")
      .describe(
        "Name of the environment variable containing the Discord bot token. Defaults to DISCORD_TOKEN. Do not put the token itself here.",
      ),
    allowedChannelIds: z
      .array(z.string().min(1))
      .default([])
      .describe(
        "Quoted Discord channel IDs allowed to reach the bot. If both channel and guild allowlists are empty, all Discord traffic is ignored.",
      ),
    allowedGuildIds: z
      .array(z.string().min(1))
      .default([])
      .describe(
        "Quoted Discord guild/server IDs allowed to reach the bot. If both channel and guild allowlists are empty, all Discord traffic is ignored.",
      ),
    dbPath: z
      .string()
      .min(1)
      .optional()
      .describe("Optional Discord surface database path. Defaults to DATA_DIR/discord-surface.db."),
    botName: z
      .string()
      .min(1)
      .refine((s) => !/\s/u.test(s), "botName must not contain spaces")
      .describe(
        "Bot display name used for attribution and mention stripping. Must not contain whitespace.",
      ),
    statusMessage: z.string().optional().describe("Optional custom Discord presence/status text."),
    memberPresence: z
      .boolean()
      .optional()
      .describe(
        "Enable the Discord member-presence intent. Requires the matching privileged intent in the Discord application settings.",
      ),

    /** Output rendering mode for Discord reply streams. */
    outputMode: z
      .enum(["inline", "preview"])
      .default("inline")
      .describe(
        '`inline` streams into the final reply embed. `preview` streams into a temporary preview, posts the full final reply, then deletes the preview.\n\nDefault: `"inline"`.',
      ),

    /** Final reply style used after Discord preview mode finishes. */
    previewFinalOutputStyle: z
      .enum(["embed", "plain"])
      .default("embed")
      .describe(
        'Final answer rendering after preview mode: Discord embeds or normal text messages.\n\nDefault: `"embed"`.',
      ),

    /**
     * Optional global override for Discord output notifications.
     * true = allow reply ping + @mentions, false = suppress by default.
     */
    outputNotification: z
      .boolean()
      .optional()
      .describe(
        "Allow reply pings and @user mention notifications when true. False suppresses output notifications by default.",
      ),

    /** Streaming embed title phrases rotated while a request is in-progress. */
    workingIndicators: z
      .array(z.string().trim().min(1))
      .min(1)
      .default(cloneDefaultWorkingIndicators())
      .describe(
        "Non-empty streaming title phrases rotated while a request runs. Overrides surface.workingIndicators for Discord only.",
      ),

    /** Experimental Discord-only output features. */
    experimental: discordExperimentalSchema.describe(
      "Legacy Discord experimental output settings.",
    ),
  })
  .default({
    tokenEnv: "DISCORD_TOKEN",
    allowedChannelIds: [],
    allowedGuildIds: [],
    botName: "lilac",
    outputMode: "inline",
    previewFinalOutputStyle: "embed",
    workingIndicators: cloneDefaultWorkingIndicators(),
    experimental: {
      markdownTableRender: {
        enabled: false,
        style: "unicode",
        maxWidth: 80,
        fallbackMode: "list",
      },
    },
  });

export const webExtractProviderSchema = z.enum(["tavily", "exa", "firecrawl"]);
export const webFetchModeSchema = z
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

export const webExtractProvidersSchema = z
  .array(webExtractProviderSchema)
  .min(1)
  .transform((providers) => uniqueItems(providers))
  .default(["tavily"]);

export function migrateWebExtractConfigValue(value: unknown): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return value;
  const providers = Reflect.get(value, "providers");
  const provider = Reflect.get(value, "provider");
  if (providers !== undefined || provider === undefined) return value;
  return { ...value, providers: [provider] };
}

export const webExtractConfigValueSchema = z.preprocess(
  migrateWebExtractConfigValue,
  z.object({
    providers: webExtractProvidersSchema.describe(
      "Non-empty ordered extraction-provider list: tavily, exa, or firecrawl. Duplicate entries are removed. Default: [tavily]. Configure the selected providers' credentials in the environment.",
    ),
  }),
);

export function migrateWebConfigValue(value: unknown): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return value;
  const extract = Reflect.get(value, "extract");
  const search = Reflect.get(value, "search");
  if (extract !== undefined || search === undefined) return value;
  return { ...value, extract: search };
}

export const webExtractConfigSchema = z
  .preprocess(
    migrateWebConfigValue,
    z.object({
      extract: webExtractConfigValueSchema
        .default({
          providers: ["tavily"],
        })
        .describe(
          "Provider-backed web extraction settings. Configure the ordered provider list under providers.",
        ),
      fetch: z
        .object({
          mode: webFetchModeSchema.describe(
            "Fetch strategy: `auto`, direct `fetch`, `browser`, `extract`, or `provider-only`. Default: auto. Provider modes use the configured extraction providers.",
          ),
        })
        .default({
          mode: "auto",
        })
        .describe("Web page retrieval strategy."),
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

export const modelCapabilityModalitySchema = z.enum(["text", "image", "audio", "video", "pdf"]);

export const modelCapabilityOver200kCostPatchSchema = z.object({
  input: z.number().nonnegative().describe("Estimated input cost in USD per million tokens."),
  output: z.number().nonnegative().describe("Estimated output cost in USD per million tokens."),
  cache_read: z
    .number()
    .nonnegative()
    .optional()
    .describe("Estimated cached-input read cost in USD per million tokens."),
  cache_write: z
    .number()
    .nonnegative()
    .optional()
    .describe("Estimated cache-write cost in USD per million tokens."),
});

export const modelCapabilityCostPatchSchema = z.object({
  input: z
    .number()
    .nonnegative()
    .optional()
    .describe("Estimated input cost in USD per million tokens."),
  output: z
    .number()
    .nonnegative()
    .optional()
    .describe("Estimated output cost in USD per million tokens."),
  cache_read: z
    .number()
    .nonnegative()
    .optional()
    .describe("Estimated cached-input read cost in USD per million tokens."),
  cache_write: z
    .number()
    .nonnegative()
    .optional()
    .describe("Estimated cache-write cost in USD per million tokens."),
  input_audio: z
    .number()
    .nonnegative()
    .optional()
    .describe("Estimated input-audio cost in USD per million tokens."),
  output_audio: z
    .number()
    .nonnegative()
    .optional()
    .describe("Estimated output-audio cost in USD per million tokens."),
  context_over_200k: modelCapabilityOver200kCostPatchSchema
    .optional()
    .describe(
      "Pricing overrides for the over-200k context tier. Affects cost estimation only; does not change limit.context.",
    ),
});

export const modelCapabilityLimitPatchSchema = z.object({
  context: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Model context-window size in tokens. Must be positive."),
  output: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe("Maximum output tokens. Must be a non-negative integer."),
});

export const modelCapabilityModalitiesPatchSchema = z.object({
  input: z
    .array(modelCapabilityModalitySchema)
    .optional()
    .describe("Supported input modalities: text, image, audio, video, pdf."),
  output: z
    .array(modelCapabilityModalitySchema)
    .optional()
    .describe("Supported output modalities: text, image, audio, video, pdf."),
});

const modelCapabilityOverrideSchema = z
  .object({
    /** Optional base model capability spec to inherit from (provider/model). */
    inherit: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe(
        "Base capability reference in provider/model format. Omit for a manual capability definition; then limit.context is required, cost patches need input and output, and modality patches need input.",
      ),
    /** Optional partial cost patch merged onto inherited/base cost. */
    cost: modelCapabilityCostPatchSchema
      .optional()
      .describe(
        "Partial token-price overrides merged onto inherited/base costs. Used for estimation; does not change provider billing.",
      ),
    /** Optional partial limit patch merged onto inherited/base limits. */
    limit: modelCapabilityLimitPatchSchema
      .optional()
      .describe(
        "Token-limit overrides merged onto inherited/base limits. A manual definition without inherit must include context.",
      ),
    /** Optional partial modalities patch merged onto inherited/base modalities. */
    modalities: modelCapabilityModalitiesPatchSchema
      .optional()
      .describe(
        "Input and output modality overrides. For a manual definition without inherit, specify input when supplying this object.",
      ),
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
    forceUnknownProviders: z
      .array(z.string().trim().min(1))
      .default(["openai-compatible"])
      .describe(
        "Provider IDs whose models.dev capability metadata should always be treated as unresolved. Default: [openai-compatible], useful for upstreams with unstable metadata.",
      ),
    /** Optional capability overrides keyed by provider/model spec. */
    overrides: z
      .record(z.string().trim().min(1), modelCapabilityOverrideSchema)
      .default({})
      .describe(
        "Manual capability overrides keyed by provider/model. Useful when catalog metadata is missing or stale. Inherit another model and patch selected fields, or provide a manual definition with limit.context.",
      ),
  })
  .default({
    forceUnknownProviders: ["openai-compatible"],
    overrides: {},
  });

const toolsSchema = z
  .object({
    fsBackend: z
      .enum(["fff", "node-rg"])
      .default("node-rg")
      .describe("Filesystem search backend: `fff` or `node-rg`. Version 2 and 3 default to fff."),
    web: webExtractConfigSchema.describe("Web fetching and extraction providers."),
    experimental_hashline_edit: z
      .boolean()
      .default(false)
      .describe("Enable legacy hashline-based file editing.\n\nDefault: `false`."),
  })
  .default({
    fsBackend: "node-rg",
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
    disabled: z
      .array(z.string().min(1))
      .default([])
      .describe(
        "Plugin IDs to disable globally. Empty by default. Disabled contributions are also unavailable to subagent allowlists.",
      ),
    config: z
      .record(z.string(), z.unknown())
      .default({})
      .describe(
        "Plugin-specific values keyed by plugin ID. Each plugin owns its settings and validation; arbitrary values are accepted here.",
      ),
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
  .regex(/^(discord|github|native)\/.+$/u, "expected <client>/<sessionIdOrAlias>");

export const heartbeatSchema = z
  .object({
    enabled: z
      .boolean()
      .default(false)
      .describe(
        "Enable the autonomous heartbeat lane. Defaults to false. Override its model at surface.router.sessionModes.__heartbeat__.model.",
      ),
    cron: cronExpr5Schema
      .default("*/30 * * * *")
      .describe(
        "Five-field, minute-precision cron schedule. Defaults to `*/30 * * * *` (every 30 minutes).",
      ),
    every: z
      .never({ error: "surface.heartbeat.every has been removed; use surface.heartbeat.cron" })
      .optional(),
    quietAfterActivityMs: z
      .number()
      .int()
      .nonnegative()
      .default(5 * 60 * 1000)
      .describe(
        "Suppress heartbeat for this many milliseconds after non-heartbeat request activity. Defaults to 300000 (5 minutes); zero disables this quiet interval.",
      ),
    retryBusyMs: z
      .number()
      .int()
      .positive()
      .default(60 * 1000)
      .describe(
        "Delay in milliseconds before retrying a suppressed wake. Defaults to 60000; must be positive.",
      ),
    defaultOutputSession: heartbeatOutputSessionSchema
      .optional()
      .describe(
        "Default heartbeat destination in `<client>/<sessionIdOrAlias>` form, for example `discord/ops`. Prefer concrete IDs. Per-watch thread destinations override this value; native is optional.",
      ),
    softQuietHours: z
      .object({
        start: hhmmSchema.describe(
          "Start of quiet hours in 24-hour HH:MM format, for example 23:00.",
        ),
        end: hhmmSchema.describe("End of quiet hours in 24-hour HH:MM format, for example 08:00."),
        timezone: z
          .string()
          .trim()
          .min(1)
          .optional()
          .describe("Optional timezone for the quiet-hours hint, for example Asia/Taipei."),
      })
      .optional()
      .describe(
        "Quiet-hours hint included in heartbeat instructions. This is guidance for the agent, not a hard scheduling block.",
      ),
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

export const agentRetrySchema = z
  .object({
    enabled: z
      .boolean()
      .default(true)
      .describe(
        "Retry transient upstream failures and replay-safe primary-agent idle timeouts.\n\nDefault: `true`.",
      ),
    maxRetries: z
      .number()
      .int()
      .min(0)
      .default(3)
      .describe(
        "Maximum retry attempts after the initial attempt. Defaults to 3; zero disables retries.",
      ),
    baseDelayMs: z
      .number()
      .int()
      .nonnegative()
      .default(2_000)
      .describe("Initial retry delay in milliseconds. Defaults to 2000; accepts zero."),
    maxDelayMs: z
      .number()
      .int()
      .nonnegative()
      .default(30_000)
      .describe("Maximum retry backoff in milliseconds. Defaults to 30000; accepts zero."),
  })
  .default({
    enabled: true,
    maxRetries: 3,
    baseDelayMs: 2_000,
    maxDelayMs: 30_000,
  });

const DEFAULT_AGENT_RETRY = {
  enabled: false,
  maxRetries: 0,
  baseDelayMs: 2_000,
  maxDelayMs: 30_000,
};

export const coreConfigInputSchemaV1 = z.object({
  configVersion: configVersionSchema.describe(
    "Configuration format version. New files use 3. An omitted version is parsed as version 1; set this explicitly before using newer fields. See docs/core-config-migrations.md for upgrades.",
  ),

  tools: toolsSchema.describe(
    "File, web, media, and tool-result settings. Omitted options use the defaults shown on their fields.",
  ),
  plugins: pluginsSchema.describe(
    "Enablement and plugin-specific configuration for built-in and external plugins.",
  ),

  surface: z
    .object({
      router: routerSchema.describe(
        "Surface-wide request routing, with per-session and Discord guild overrides.",
      ),
      discord: discordSurfaceSchema.describe(
        "Discord credentials, ingress allowlists, attachment caching, and output rendering.",
      ),
      heartbeat: heartbeatSchema.describe(
        "Autonomous heartbeat lane. Disabled by default; configure its model through `surface.router.sessionModes.__heartbeat__.model`.",
      ),
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
        workingIndicators: cloneDefaultWorkingIndicators(),
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
    })
    .describe("Communication surfaces, request routing, and autonomous heartbeat settings."),

  agent: z
    .object({
      statsForNerds: statsForNerdsSchema.describe(
        "Response metadata statistics: false disables them, true includes model/timing/throughput, and `{verbose: true}` also includes input composition.",
      ),
      reasoningDisplay: reasoningDisplaySchema.describe(
        "Discord streaming reasoning display. `none` hides it; `simple` shows the working title and elapsed timer; `detailed` also shows blockquoted reasoning, clamped to 500 characters.",
      ),
      subagents: subagentsSchema
        .default({
          enabled: true,
          maxDepth: 2,
          defaultTimeoutMs: 3 * 60 * 1000,
          maxTimeoutMs: 8 * 60 * 1000,
          profiles: {
            explore: { modelSlot: "main" },
            general: { modelSlot: "main" },
            self: { modelSlot: "main" },
          },
        })
        .describe(
          "Delegated child-agent execution and permission-profile mapping. V1 uses a fixed 15-minute primary idle timeout and a 10-minute child idle timeout.",
        ),
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
    })
    .describe("Agent execution, retry, transcript retention, display, and delegation settings."),

  models: z
    .object({
      /** Optional registry of reusable model presets, referenced by alias. */
      def: z
        .record(
          z.string().min(1),
          z.object({
            /** Canonical model spec in provider/model format. */
            model: z
              .string()
              .min(1)
              .describe(
                "Canonical provider/model reference. An alias cannot point to another alias. Example: openai/gpt-4o.",
              ),
            /** AI SDK providerOptions-style object (nested JSON allowed). */
            options: jsonObjectSchema
              .optional()
              .describe(
                "Provider-specific options merged onto inherited model settings. Accepts shorthand such as `{temperature: 0.2}` or nested provider namespaces such as `{openai: {parallelToolCalls: false}}. OpenAI-compatible options use `openaiCompatible`.\n\nLilac options include `response_commentary` for direct OpenAI/Codex channel guidance, `openai_server_compaction` to opt into server compaction, and `anthropic_prompt_cache` to opt into system/latest-user cache control. Cache writes can increase cost and interact poorly with tool-result pruning.",
              ),
          }),
        )
        .default({})
        .describe(
          "Reusable model aliases. Each alias names a canonical provider/model. Example: `assistant: {model: openai/gpt-4o}`. Version 1 aliases accept model and options; upgrade the config to use newer alias fields.",
        ),

      main: z
        .object({
          /**
           * Model spec in provider/model format OR an alias from models.def.
           *
           * If no '/' is present, the value is treated as an alias.
           */
          model: z
            .string()
            .min(1)
            .default("openrouter/openai/gpt-4o")
            .describe(
              'Model reference in `provider/model` format or an alias from `models.def`. For example, `openai/gpt-4o`.\n\nDefault: `"openrouter/openai/gpt-4o"`.',
            ),
          /**
           * Provider-specific model options.
           *
           * Supports either:
           * - shorthand: { temperature: 0.2 }
           * - providerOptions map: { openai: { temperature: 0.2 }, gateway: { order: [...] } }
           */
          options: jsonObjectSchema
            .optional()
            .describe(
              "Provider-specific options merged onto inherited model settings. Accepts shorthand such as `{temperature: 0.2}` or nested provider namespaces such as `{openai: {parallelToolCalls: false}}. OpenAI-compatible options use `openaiCompatible`.\n\nLilac options include `response_commentary` for direct OpenAI/Codex channel guidance, `openai_server_compaction` to opt into server compaction, and `anthropic_prompt_cache` to opt into system/latest-user cache control. Cache writes can increase cost and interact poorly with tool-result pruning.",
            ),
        })
        .default({
          model: "openrouter/openai/gpt-4o",
        })
        .describe(
          "Primary request model and optional reasoning, options, and fallback overrides. Defaults to openrouter/openai/gpt-4o.",
        ),

      /**
       * Fast/cheap model for lightweight features (router gate, etc.).
       *
       * This is intentionally separate from `models.main`.
       */
      fast: z
        .object({
          model: z
            .string()
            .min(1)
            .default("openrouter/openai/gpt-4o-mini")
            .describe(
              'Model reference in `provider/model` format or an alias from `models.def`. For example, `openai/gpt-4o`.\n\nDefault: `"openrouter/openai/gpt-4o-mini"`.',
            ),
          options: jsonObjectSchema
            .optional()
            .describe(
              "Provider-specific options merged onto inherited model settings. Accepts shorthand such as `{temperature: 0.2}` or nested provider namespaces such as `{openai: {parallelToolCalls: false}}. OpenAI-compatible options use `openaiCompatible`.\n\nLilac options include `response_commentary` for direct OpenAI/Codex channel guidance, `openai_server_compaction` to opt into server compaction, and `anthropic_prompt_cache` to opt into system/latest-user cache control. Cache writes can increase cost and interact poorly with tool-result pruning.",
            ),
        })
        .default({
          model: "openrouter/openai/gpt-4o-mini",
        })
        .describe(
          "Lightweight model used by features such as the router gate. Defaults to openrouter/openai/gpt-4o-mini.",
        ),

      capability: modelCapabilitySchema.describe(
        "Manual model metadata and provider exclusions used when resolving model capabilities.",
      ),
    })
    .default({
      def: {},
      main: { model: "openrouter/openai/gpt-4o" },
      fast: { model: "openrouter/openai/gpt-4o-mini" },
      capability: {
        forceUnknownProviders: ["openai-compatible"],
        overrides: {},
      },
    })
    .describe(
      "Model slots, reusable aliases, capability overrides, catalog visibility, and ordered option rules. Local Claude subscription models use `claude-code/<model>`; see docs/claude-code.md for authentication, persistent storage, and continuation limits.",
    ),

  entity: z
    .object({
      users: z
        .record(z.string().min(1), discordUserAliasSchema)
        .default({})
        .describe(
          'Map a user alias to `{discord: "USER_ID", comment: "optional context"}`. Example: `Stanley: {discord: "123456789012345678"}`.',
        ),

      sessions: z
        .object({
          discord: z
            .record(z.string().min(1), discordSessionAliasSchema)
            .default({})
            .describe(
              'Map a channel alias to a quoted Discord ID or `{discord: "CHANNEL_ID", comment: "optional context"}`. For example, `ops: "234567890123456789"`.',
            ),
        })
        .default({ discord: {} })
        .describe("Session aliases grouped by surface."),
    })
    .default({ users: {}, sessions: { discord: {} } })
    .optional()
    .describe(
      "Discord aliases for users and channels. Rewrites outbound @name/#name to Discord mentions and inbound mentions to aliases. Matching is case-insensitive; configured casing is preserved. Whitespace becomes underscores and leading @/# is stripped. Optional comments accompany aliases in the system prompt.",
    ),

  basePrompt: z
    .string()
    .optional()
    .describe(
      "Base instructions. Codex uses this as Responses instructions when `codex_instructions` is absent. Other providers prepend it to the prompt files under DATA_DIR/prompts. Omit to use the provider's normal prompt assembly.",
    ),
});

export const coreConfigSchema = coreConfigInputSchemaV1;

export type ParsedCoreConfigV1 = z.infer<typeof coreConfigInputSchemaV1>;

export class CoreConfigV1Invalid extends TaggedError("CoreConfigV1Invalid")<{
  readonly cause: z.ZodError;
  readonly message: string;
}> {}

export function decodeCoreConfigV1(
  raw: unknown,
): ResultType<ParsedCoreConfigV1, CoreConfigV1Invalid> {
  const parsed = coreConfigInputSchemaV1.safeParse(raw);
  return parsed.success
    ? Result.ok(parsed.data)
    : Result.err(
        new CoreConfigV1Invalid({
          cause: parsed.error,
          message: parsed.error.issues.map((issue) => issue.message).join("; "),
        }),
      );
}

export function parseCoreConfigV1(raw: unknown): ParsedCoreConfigV1 {
  return coreConfigInputSchemaV1.parse(raw);
}

function coreConfigV1ToUniversal(
  parsed: ParsedCoreConfigV1,
  raw: unknown,
  options?: CoreConfigParseOptions,
): UniversalCoreConfig {
  if (options?.onUnknownKey) {
    for (const path of collectUnknownConfigKeyPaths(raw, parsed)) {
      options.onUnknownKey(path);
    }
  }
  const { experimental_hashline_edit: hashline, ...toolsRest } = parsed.tools;
  const { previewFinalOutputStyle, experimental, ...discordRest } = parsed.surface.discord;
  const { subagents, ...agentRest } = parsed.agent;

  return {
    ...parsed,
    blobStorage: { kind: "local" },
    plugins: parsed.plugins,
    tools: {
      ...toolsRest,
      fsBackend: parsed.tools.fsBackend,
      editFile: {
        hashline,
      },
      output: {
        maxPreviewBytes: 40 * 1024,
        artifactTtlMs: 7 * 24 * 60 * 60 * 1000,
        artifactMaxBytesPerSession: 50 * 1024 * 1024,
      },
      historicalResultPruning: {
        enabled: false,
        protectTokens: 40_000,
        minimumTokens: 20_000,
      },
      batch: {
        maxCalls: 8,
      },
      media: {
        maxInlineBytesPerPart: 10 * 1024 * 1024,
        maxInlineBytesTotal: 20 * 1024 * 1024,
      },
    },
    conversation: {
      thread: {
        summarization: {
          enabled: false,
          model: "fast",
          concurrency: 1,
          batchSize: 32,
          includePromptContext: false,
        },
        embedding: {
          enabled: false,
          model: "openai/text-embedding-3-small",
        },
        autoInject: {
          enabled: false,
          minTextUnits: 10,
          followUpMinTextUnits: 10,
          limit: 3,
          minScore: 0.1,
          expansionMinConfidence: 0.65,
          mode: "hybrid",
          filterCurrentParticipants: false,
        },
        autoInjectMode: "llm",
        decisionAutoInject: {
          model: ["typesafe/jev-1.13.0"],
          limit: 3,
          candidateLimit: 40,
          semanticFallback: true,
          jev: {
            recallMinProbability: 0,
            durableSubjectMinProbability: 0.6,
            casualMaxProbability: 0.6,
            relevanceMinProbability: 0.2,
          },
          luna: {
            recallMinProbability: 0,
            durableSubjectMinProbability: 0.5,
            casualMaxProbability: 0.3,
            relevanceMinProbability: 0.1,
          },
        },
      },
    },
    workflows: {
      maxActiveRuns: 64,
    },
    surface: {
      ...parsed.surface,
      workingIndicators: cloneDefaultWorkingIndicators(),
      native: defaultNativeSurfaceConfig(),
      discord: {
        ...discordRest,
        attachmentCache: {
          ttlMs: { kind: "bounded", value: DEFAULT_DISCORD_ATTACHMENT_CACHE_TTL_MS },
        },
        outputPreviewModeFinalStyle: previewFinalOutputStyle,
        outputPreviewModeFinalText: "reply-chain",
        markdownTableRender: experimental.markdownTableRender,
        markdownMathRender: {
          enabled: false,
          maxWidth: 50,
          fallbackMode: "source",
        },
      },
    },
    agent: {
      ...agentRest,
      systemPrompt: "",
      workerSystemPrompt: "",
      idleTimeoutMs: 15 * 60 * 1000,
      transcriptRetention: {
        maxAgeMs: { kind: "bounded", value: DEFAULT_TRANSCRIPT_RETENTION_MAX_AGE_MS },
        maxRequests: {
          kind: "bounded",
          value: DEFAULT_TRANSCRIPT_RETENTION_MAX_REQUESTS,
        },
      },
      retry: { ...DEFAULT_AGENT_RETRY },
      subagents: {
        enabled: subagents.enabled,
        maxDepth: subagents.maxDepth,
        // Frozen v1 profiles map onto the universal permission profiles. Their
        // model fields have no universal equivalent and are ignored.
        defaultPermissions: "restricted",
        permissions: {
          restricted: {
            ...(subagents.profiles.explore.promptOverlay
              ? { promptOverlay: subagents.profiles.explore.promptOverlay }
              : {}),
            level1: {
              tools: ["read", "glob", "grep", "fuzzy_search", "batch"],
              plugins: ["builtin-local-tools"],
            },
            level2: {
              callables: [
                "fetch",
                "search",
                "skills.list",
                "skills.read",
                "discovery.search",
                "conversation.thread.search",
                "surface.help",
                "surface.sessions.listParticipants",
                "surface.messages.list",
                "surface.messages.read",
                "surface.reactions.list",
                "surface.reactions.listDetailed",
              ],
              plugins: ["web", "skills", "discovery", "conversation.thread", "surface"],
            },
            network: true,
            workspaceWrites: false,
            execution: false,
            delegation: false,
          },
          general: {
            ...(subagents.profiles.general.promptOverlay
              ? { promptOverlay: subagents.profiles.general.promptOverlay }
              : {}),
            level1: { tools: ["*"], plugins: ["*"] },
            level2: { callables: ["*"], plugins: ["*"] },
            network: true,
            workspaceWrites: true,
            execution: "native",
            delegation: false,
          },
          full: {
            ...(subagents.profiles.self.promptOverlay
              ? { promptOverlay: subagents.profiles.self.promptOverlay }
              : {}),
            level1: { tools: ["*"], plugins: ["*"] },
            level2: { callables: ["*"], plugins: ["*"] },
            network: true,
            workspaceWrites: true,
            execution: "native",
            delegation: true,
          },
        },
      },
    },
    models: {
      ...parsed.models,
      def: Object.fromEntries(
        Object.entries(parsed.models.def).map(([alias, preset]) => [
          alias,
          { ...preset, agentCanSelect: false },
        ]),
      ),
    },
  };
}

export function decodeCoreConfigV1ToUniversal(
  raw: unknown,
  options?: CoreConfigParseOptions,
): ResultType<UniversalCoreConfig, CoreConfigV1Invalid> {
  const parsed = decodeCoreConfigV1(raw);
  const continueDecode = parsed.match<() => ResultType<UniversalCoreConfig, CoreConfigV1Invalid>>({
    ok: (value) => () => Result.ok(coreConfigV1ToUniversal(value, raw, options)),
    err: (error) => () => Result.err(error),
  });
  return continueDecode();
}

export function parseCoreConfigV1ToUniversal(
  raw: unknown,
  options?: CoreConfigParseOptions,
): UniversalCoreConfig {
  const result = decodeCoreConfigV1ToUniversal(raw, options);
  const resolved = result.match<
    { readonly value: UniversalCoreConfig } | { readonly error: CoreConfigV1Invalid }
  >({
    ok: (value) => ({ value }),
    err: (error) => ({ error }),
  });
  if ("error" in resolved) throw resolved.error.cause;
  return resolved.value;
}

export class V1CoreConfigParser implements ConfigParser {
  readonly version = V1_CORE_CONFIG_VERSION;

  async parse(input: object, options?: CoreConfigParseOptions): Promise<UniversalCoreConfig> {
    return parseCoreConfigV1ToUniversal(input, options);
  }
}
