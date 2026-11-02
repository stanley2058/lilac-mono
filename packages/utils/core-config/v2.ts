import { Result, TaggedError, type Result as ResultType } from "better-result";
import path from "node:path";
import { z } from "zod";

import { cloneDefaultWorkingIndicators } from "../working-indicators";
import { parseFriendlyByteSize, parseFriendlyDurationMs } from "../friendly-units";

import {
  coreConfigInputSchemaV1,
  agentRetrySchema,
  heartbeatSchema,
  jsonObjectSchema,
  modelCapabilityCostPatchSchema,
  modelCapabilityLimitPatchSchema,
  modelCapabilityModalitiesPatchSchema,
  migrateWebConfigValue,
  routerSchema,
  statsForNerdsSchema,
  webExtractConfigValueSchema,
  webFetchModeSchema,
} from "./v1";
import { collectUnknownConfigKeyPaths } from "./unknown-keys";
import { defaultNativeSurfaceConfig } from "./types";

import type {
  ConfigParser,
  CoreConfigParseOptions,
  CoreConfigVersion,
  JSONObject,
  ModelReasoningEffort,
  SubagentPermissionProfileConfig,
  UniversalCoreConfig,
} from "./types";
import {
  DEFAULT_DISCORD_ATTACHMENT_CACHE_TTL_MS,
  DEFAULT_TRANSCRIPT_RETENTION_MAX_AGE_MS,
  DEFAULT_TRANSCRIPT_RETENTION_MAX_REQUESTS,
  type RetentionLimit,
} from "./types";

export const V2_CORE_CONFIG_VERSION = 2 satisfies CoreConfigVersion;

const configVersionSchema = z.literal(V2_CORE_CONFIG_VERSION).default(V2_CORE_CONFIG_VERSION);

const environmentVariableNameSchema = z
  .string()
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/u, "expected an environment variable name");

const blobStorageSchemaV2 = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z
        .literal("local")
        .describe("Storage backend: local filesystem or an existing private S3-compatible bucket."),
      root: z
        .string()
        .trim()
        .min(1)
        .refine((value) => path.isAbsolute(value), "root must be an absolute path")
        .describe(
          "Absolute local blob-storage directory, for example /var/lib/lilac/blobs. Required when explicitly configuring kind: local; omit the whole blobStorage section to use DATA_DIR defaults.",
        ),
    })
    .strict(),
  z
    .object({
      kind: z
        .literal("s3")
        .describe("Storage backend: local filesystem or an existing private S3-compatible bucket."),
      bucket: z.string().trim().min(1).describe("Existing private S3-compatible bucket name."),
      prefix: z
        .string()
        .trim()
        .min(1)
        .describe("Non-empty object-key prefix within the bucket, for example production/blobs."),
      endpoint: z
        .url()
        .superRefine((value, ctx) => {
          const endpoint = new URL(value);
          if (endpoint.protocol !== "http:" && endpoint.protocol !== "https:") {
            ctx.addIssue({ code: "custom", message: "endpoint must use http or https" });
          }
          if (endpoint.username || endpoint.password) {
            ctx.addIssue({ code: "custom", message: "endpoint must not contain credentials" });
          }
        })
        .describe(
          "HTTP(S) S3 API endpoint, for example https://s3.example.com. Must not embed credentials.",
        ),
      region: z.string().trim().min(1).describe("S3 signing region, for example us-east-1."),
      accessKeyIdEnv: environmentVariableNameSchema.describe(
        "Environment variable holding the S3 access key ID, for example LILAC_S3_ACCESS_KEY_ID. Supply the variable name, not the credential.",
      ),
      secretAccessKeyEnv: environmentVariableNameSchema.describe(
        "Environment variable holding the S3 secret access key, for example LILAC_S3_SECRET_ACCESS_KEY. Supply the variable name, not the credential.",
      ),
      sessionTokenEnv: environmentVariableNameSchema
        .optional()
        .describe(
          "Optional environment variable holding the S3 session token for temporary credentials.",
        ),
      forcePathStyle: z
        .boolean()
        .default(false)
        .describe(
          "Use path-style S3 bucket addressing. Defaults to false; enable when required by the S3-compatible endpoint.",
        ),
    })
    .strict(),
]);

const pluginsSchemaV2 = z
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
  .default({ disabled: [], config: {} });

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

const configuredModelChainEntrySchemaV2 = z.union([
  z.string().min(1),
  z.object({
    model: z
      .string()
      .min(1)
      .describe(
        "Model reference in `provider/model` format or an alias from `models.def`. For example, `openai/gpt-4o`.",
      ),
    reasoning: modelReasoningEffortSchema
      .optional()
      .describe(
        "Portable reasoning effort. `provider-default` leaves the choice to the provider. Supported effort levels depend on the selected model.",
      ),
    options: jsonObjectSchema
      .optional()
      .describe(
        "Provider-specific options merged onto inherited model settings. Accepts shorthand such as `{temperature: 0.2}` or nested provider namespaces such as `{openai: {parallelToolCalls: false}}. OpenAI-compatible options use `openaiCompatible`.\n\nLilac options include `response_commentary` for direct OpenAI/Codex channel guidance, `openai_server_compaction` to opt into server compaction, and `anthropic_prompt_cache` to opt into system/latest-user cache control. Cache writes can increase cost and interact poorly with tool-result pruning.",
      ),
  }),
]);

const modelFallbackSchemaV2 = z.array(configuredModelChainEntrySchemaV2).optional();

type SubagentProfileConfigV2 = SubagentPermissionProfileConfig & {
  modelSlot: "main" | "fast";
  model?: string;
  reasoning?: Exclude<ModelReasoningEffort, "max">;
  options?: JSONObject;
  fallback?: z.output<typeof modelFallbackSchemaV2>;
};

const profileNamesSchema = z.array(z.string().trim().min(1)).default([]);

export const profileLevel1Schema = z.object({
  tools: profileNamesSchema.describe(
    "Allowed direct tool names. `*` includes every globally enabled tool contribution. Examples: bash, read, glob, grep, fuzzy_search.",
  ),
  plugins: profileNamesSchema.describe(
    "Allowed direct-tool plugin IDs. `*` includes every globally enabled plugin; MCP servers also require allowSubagents: true.",
  ),
});

export const profileLevel2Schema = z.object({
  callables: profileNamesSchema.describe(
    "Allowed Core tool-server callable names, such as fetch, search, or skills.read. `*` includes every globally enabled callable.",
  ),
  plugins: profileNamesSchema.describe(
    "Allowed Core tool-server plugin IDs. `*` includes every globally enabled plugin.",
  ),
});

const EXPLORE_PROFILE_DEFAULT: SubagentProfileConfigV2 = {
  modelSlot: "main",
  level1: {
    tools: ["bash", "read", "glob", "grep", "fuzzy_search", "batch"],
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
  execution: "native",
  delegation: false,
};

const GENERAL_PROFILE_DEFAULT: SubagentProfileConfigV2 = {
  modelSlot: "main",
  level1: { tools: ["*"], plugins: ["*"] },
  level2: { callables: ["*"], plugins: ["*"] },
  network: true,
  workspaceWrites: true,
  execution: "native",
  delegation: false,
};

const SELF_PROFILE_DEFAULT: SubagentProfileConfigV2 = {
  ...GENERAL_PROFILE_DEFAULT,
  delegation: true,
};

export function normalizeProfileToolNames<T extends SubagentPermissionProfileConfig>(
  profile: T,
): T {
  return {
    ...profile,
    level1: {
      ...profile.level1,
      tools: profile.level1.tools.map((name) => {
        switch (name) {
          case "read_file":
            return "read";
          case "edit_file":
            return "edit";
          case "apply_patch":
            return "patch";
          default:
            return name;
        }
      }),
    },
  };
}

function subagentProfileSchemaV2(defaults: SubagentProfileConfigV2) {
  return z
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
      /** Optional portable AI SDK reasoning effort. */
      reasoning: modelReasoningEffortSchema
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
      /** Optional ordered model fallback chain. */
      fallback: modelFallbackSchemaV2.describe(
        "Legacy profile model setting accepted for configuration compatibility. The current runtime ignores per-profile model selection, reasoning, options, and fallback fields. Select models per delegation or through models.main.",
      ),
      promptOverlay: z
        .string()
        .min(1)
        .optional()
        .describe(
          'Additional instructions appended to the worker prompt for children using this permission profile. For example, "Cite file paths and avoid edits."',
        ),
      level1: profileLevel1Schema
        .default(defaults.level1)
        .describe(
          "Direct model-callable tool and plugin allowlists. Entries must also be globally enabled; MCP servers additionally require `allowSubagents: true` in mcp-config.yaml.",
        ),
      level2: profileLevel2Schema
        .default(defaults.level2)
        .describe(
          "Core tool-server callable and plugin allowlists. These control functions reached through the tools CLI.",
        ),
      network: z
        .boolean()
        .default(defaults.network)
        .describe(
          "Allow network-capable tool behavior. This is a behavioral guardrail; native host execution is not an OS network sandbox.",
        ),
      workspaceWrites: z
        .boolean()
        .default(defaults.workspaceWrites)
        .describe(
          "Allow workspace-writing tools. Native Bash still runs with the Core service user's authority; use restricted execution or OS isolation for filesystem isolation.",
        ),
      execution: z
        .union([z.literal(false), z.enum(["restricted", "native"])])
        .default(defaults.execution)
        .describe(
          "Bash execution policy: `false` disables execution, `restricted` uses virtual restricted Bash, and `native` uses trusted host Bash unless the surface is restricted.",
        ),
      delegation: z
        .boolean()
        .default(defaults.delegation)
        .describe(
          "Allow this child to delegate again, subject to `maxDepth`. A child can request only permission profiles within its own authority.",
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
}

const modelCapabilityOverrideSchemaV2 = z
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
    /** Optional attachment input support patch merged onto inherited/base capability. */
    attachment: z.boolean().optional().describe("Override attachment input support."),
    /** Optional partial modalities patch merged onto inherited/base modalities. */
    modalities: modelCapabilityModalitiesPatchSchema
      .optional()
      .describe(
        "Input and output modality overrides. For a manual definition without inherit, specify input when supplying this object.",
      ),
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
    forceUnknownProviders: z
      .array(z.string().trim().min(1))
      .default(["openai-compatible"])
      .describe(
        "Provider IDs whose models.dev capability metadata should always be treated as unresolved. Default: [openai-compatible], useful for upstreams with unstable metadata.",
      ),
    /** Optional capability overrides keyed by provider/model spec. */
    overrides: z
      .record(z.string().trim().min(1), modelCapabilityOverrideSchemaV2)
      .default({})
      .describe(
        "Manual capability overrides keyed by provider/model. Useful when catalog metadata is missing or stale. Inherit another model and patch selected fields, or provide a manual definition with limit.context.",
      ),
  })
  .default({
    forceUnknownProviders: ["openai-compatible"],
    overrides: {},
  });

const subagentsSchemaV2 = z.object({
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
  delegatePromptOverlay: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe(
      "Free-form guidance appended to the parent-visible subagent_delegate tool description. Use for model selection, escalation, cost, or workflow preferences.",
    ),
  profiles: z
    .object({
      explore: subagentProfileSchemaV2(EXPLORE_PROFILE_DEFAULT)
        .default(EXPLORE_PROFILE_DEFAULT)
        .describe(
          "Legacy explore role, mapped to the restricted permission profile. Per-profile model fields are ignored by the current runtime.",
        ),
      general: subagentProfileSchemaV2(GENERAL_PROFILE_DEFAULT)
        .default(GENERAL_PROFILE_DEFAULT)
        .describe(
          "Legacy general role, mapped to the general permission profile. Per-profile model fields are ignored by the current runtime.",
        ),
      self: subagentProfileSchemaV2(SELF_PROFILE_DEFAULT)
        .default(SELF_PROFILE_DEFAULT)
        .describe(
          "Legacy self role, mapped to the full permission profile. Per-profile model fields are ignored by the current runtime.",
        ),
    })
    .default({
      explore: EXPLORE_PROFILE_DEFAULT,
      general: GENERAL_PROFILE_DEFAULT,
      self: SELF_PROFILE_DEFAULT,
    })
    .describe(
      "Legacy role profiles mapped to permission profiles: explore becomes restricted, self becomes full, and general keeps its name. Per-profile model fields are ignored by the current runtime. Version 3 configures permissions directly.",
    ),
});

const discordMarkdownTableRenderSchema = z
  .object({
    enabled: z
      .boolean()
      .default(true)
      .describe(
        "Render Markdown tables for Discord. When disabled, tables remain ordinary Markdown.\n\nDefault: `true`.",
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
      .default(50)
      .describe(
        "Maximum text-table width in display cells, not bytes. Also applies to image fallback. Allowed range: 40 to 240.\n\nDefault: `50`.",
      ),
    fallbackMode: z
      .enum(["list", "passthrough"])
      .default("list")
      .describe(
        'When a table cannot fit maxWidth, `list` renders wrapped row/key-value text in a code block; `passthrough` preserves the original Markdown table.\n\nDefault: `"list"`.',
      ),
  })
  .default({
    enabled: true,
    style: "unicode",
    maxWidth: 50,
    fallbackMode: "list",
  });

const discordMarkdownMathRenderSchema = z
  .object({
    enabled: z
      .boolean()
      .default(false)
      .describe("Render Markdown math expressions for Discord. Defaults to false."),
    maxWidth: z
      .number()
      .int()
      .min(40)
      .max(240)
      .default(50)
      .describe(
        "Maximum rendered math width in display cells. Allowed range: 40 to 240; defaults to 50.",
      ),
    fallbackMode: z
      .enum(["source", "passthrough"])
      .default("source")
      .describe(
        'When math cannot render within maxWidth, `source` displays the math source as code; `passthrough` preserves the original content.\n\nDefault: `"source"`.',
      ),
  })
  .default({
    enabled: false,
    maxWidth: 50,
    fallbackMode: "source",
  });

const positiveDurationMsSchema = z.preprocess(parseFriendlyDurationMs, z.number().int().positive());
const retentionDurationSchema = z.union([z.literal("unlimited"), positiveDurationMsSchema]);

const retentionCountSchema = z.union([z.number().int().positive(), z.literal("unlimited")]);

const discordAttachmentCacheSchema = z
  .object({
    ttl: retentionDurationSchema
      .default(DEFAULT_DISCORD_ATTACHMENT_CACHE_TTL_MS)
      .describe(
        "Lifetime for newly cached Discord attachments. Default: 30d. Set `unlimited` to create cache objects without expiry. Accepts positive milliseconds or a duration such as `7d`. Units: ms, s, m, h, d, w, mo; mo is 30 days.",
      ),
  })
  .default({ ttl: DEFAULT_DISCORD_ATTACHMENT_CACHE_TTL_MS });

const transcriptRetentionSchema = z
  .object({
    maxAge: retentionDurationSchema
      .default(DEFAULT_TRANSCRIPT_RETENTION_MAX_AGE_MS)
      .describe(
        "Maximum age of completed request transcripts. Default: 180d. Set `unlimited` to disable the age limit independently of maxRequests. Accepts positive milliseconds or a duration such as `7d`. Units: ms, s, m, h, d, w, mo; mo is 30 days.",
      ),
    maxRequests: retentionCountSchema
      .default(DEFAULT_TRANSCRIPT_RETENTION_MAX_REQUESTS)
      .describe(
        "Maximum retained completed requests. Default: 10000. Accepts a positive integer or `unlimited`; the age limit still applies independently.",
      ),
  })
  .default({
    maxAge: DEFAULT_TRANSCRIPT_RETENTION_MAX_AGE_MS,
    maxRequests: DEFAULT_TRANSCRIPT_RETENTION_MAX_REQUESTS,
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
      .default("lilac")
      .describe(
        'Bot display name used for attribution and mention stripping. Must not contain whitespace.\n\nDefault: `"lilac"`.',
      ),
    statusMessage: z.string().optional().describe("Optional custom Discord presence/status text."),
    memberPresence: z
      .boolean()
      .optional()
      .describe(
        "Enable the Discord member-presence intent. Requires the matching privileged intent in the Discord application settings.",
      ),
    outputMode: z
      .enum(["inline", "preview"])
      .default("preview")
      .describe(
        '`inline` streams into the final reply embed. `preview` streams into a temporary preview, posts the full final reply, then deletes the preview.\n\nDefault: `"preview"`.',
      ),
    outputPreviewModeFinalStyle: z
      .enum(["embed", "plain"])
      .default("plain")
      .describe(
        "Final answer rendering after preview mode: `embed` posts embeds; `plain` posts normal Discord messages. Defaults to plain.",
      ),
    outputPreviewModeFinalText: z
      .enum(["flat", "reply-chain"])
      .default("flat")
      .describe(
        "Grouping for preview/plain final output. `flat` replies with the first answer chunk and sends later chunks directly. `reply-chain` reposts commentary and final answer as a reply chain. Defaults to flat.",
      ),
    outputNotification: z
      .boolean()
      .default(true)
      .describe(
        "Allow reply pings and @user mention notifications when true. False suppresses output notifications by default.\n\nDefault: `true`.",
      ),
    attachmentCache: discordAttachmentCacheSchema.describe(
      "Retention for downloaded Discord ingress attachments. Existing cached data is reused within the configured lifetime.",
    ),
    workingIndicators: z
      .array(z.string().trim().min(1))
      .min(1)
      .optional()
      .describe(
        "Non-empty streaming title phrases rotated while a request runs. Overrides surface.workingIndicators for Discord only.",
      ),
    markdownTableRender: discordMarkdownTableRenderSchema.describe(
      "Discord Markdown table rendering and overflow behavior.",
    ),
    markdownMathRender: discordMarkdownMathRenderSchema.describe(
      "Discord Markdown math rendering and fallback behavior.",
    ),
  })
  .default({
    tokenEnv: "DISCORD_TOKEN",
    allowedChannelIds: [],
    allowedGuildIds: [],
    botName: "lilac",
    outputMode: "preview",
    outputPreviewModeFinalStyle: "plain",
    outputPreviewModeFinalText: "flat",
    outputNotification: true,
    attachmentCache: { ttl: DEFAULT_DISCORD_ATTACHMENT_CACHE_TTL_MS },
    markdownTableRender: {
      enabled: true,
      style: "unicode",
      maxWidth: 50,
      fallbackMode: "list",
    },
    markdownMathRender: {
      enabled: false,
      maxWidth: 50,
      fallbackMode: "source",
    },
  });

const byteSizeSchema = z.preprocess(parseFriendlyByteSize, z.number().int().positive());
const durationMsSchema = z.preprocess(parseFriendlyDurationMs, z.number().int().positive());

const webConfigSchemaV2 = z
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
      firecrawl: z
        .object({
          maxConcurrency: z
            .number()
            .int()
            .positive()
            .default(2)
            .describe(
              "Maximum concurrent calls per Firecrawl fetch/search limiter. Defaults to 2; must be positive.",
            ),
          queueTtl: durationMsSchema
            .default(3_000)
            .describe(
              "Maximum time a Firecrawl request can wait in the local queue. Default: 3s. Accepts positive milliseconds or a duration such as `7d`. Units: ms, s, m, h, d, w, mo; mo is 30 days.",
            ),
        })
        .optional()
        .describe(
          "Optional independent process-local concurrency and queue limits for Firecrawl fetch and search calls. Omit to leave these optional limits unconfigured.",
        ),
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

const toolsSchema = z
  .object({
    fsBackend: z
      .enum(["fff", "node-rg"])
      .default("fff")
      .describe("Filesystem search backend: `fff` or `node-rg`. Version 2 and 3 default to fff."),
    web: webConfigSchemaV2.describe("Web fetching and extraction providers."),
    inspect: z
      .object({
        model: z
          .string()
          .trim()
          .min(1)
          .default("google/gemini-3.5-flash")
          .describe(
            'Model reference in `provider/model` format or an alias from `models.def`. For example, `openai/gpt-4o`.\n\nDefault: `"google/gemini-3.5-flash"`.',
          ),
      })
      .default({
        model: "google/gemini-3.5-flash",
      })
      .describe(
        "Compatibility settings, ignored because content.inspect is retired. Rejected in configuration version 3.",
      ),
    editFile: z
      .object({
        hashline: z
          .boolean()
          .default(true)
          .describe("Use hashline-based file editing. Defaults to true."),
      })
      .default({
        hashline: true,
      })
      .describe("File-editing tool behavior."),
    output: z
      .object({
        maxPreviewBytes: byteSizeSchema
          .default(40 * 1024)
          .describe(
            "Maximum inline tool-result preview size. Default: 40KiB. Accepts a positive byte count or a unit string such as `40KiB`. Units: B, KB, MB, GB, KiB, MiB, GiB.",
          ),
        artifactTtl: durationMsSchema
          .default(7 * 24 * 60 * 60 * 1000)
          .describe(
            "Retention time for tool-result artifacts. Default: 7d. Accepts positive milliseconds or a duration such as `7d`. Units: ms, s, m, h, d, w, mo; mo is 30 days.",
          ),
        artifactMaxBytesPerSession: byteSizeSchema
          .default(50 * 1024 * 1024)
          .describe(
            "Per-session retained tool-artifact byte budget. Default: 50MiB. Accepts a positive byte count or a unit string such as `40KiB`. Units: B, KB, MB, GB, KiB, MiB, GiB.",
          ),
      })
      .default({
        maxPreviewBytes: 40 * 1024,
        artifactTtl: 7 * 24 * 60 * 60 * 1000,
        artifactMaxBytesPerSession: 50 * 1024 * 1024,
      })
      .describe("Bounded tool previews and retained overflow artifacts."),
    historicalResultPruning: z
      .object({
        enabled: z
          .boolean()
          .default(false)
          .describe("Enable historical tool-result pruning. Defaults to false."),
        protectTokens: z
          .number()
          .int()
          .nonnegative()
          .default(40_000)
          .describe(
            "Recent tool-result token budget protected from pruning. Defaults to 40000; accepts zero.",
          ),
        minimumTokens: z
          .number()
          .int()
          .nonnegative()
          .default(20_000)
          .describe(
            "Minimum prunable tool-result tokens before pruning is worthwhile. Defaults to 20000; accepts zero.",
          ),
      })
      .default({
        enabled: false,
        protectTokens: 40_000,
        minimumTokens: 20_000,
      })
      .describe(
        "Prune older tool results from model context while protecting recent results. Disabled by default.",
      ),
    batch: z
      .object({
        maxCalls: z
          .number()
          .int()
          .positive()
          .max(8)
          .default(8)
          .describe(
            "Compatibility field, ignored. The batch tool is retired; models issue ordinary tool calls directly.",
          ),
      })
      .default({ maxCalls: 8 })
      .describe("Compatibility section, ignored since the batch tool was retired."),
    media: z
      .object({
        maxInlineBytesPerPart: byteSizeSchema
          .default(10 * 1024 * 1024)
          .describe(
            "Maximum bytes in one inline media part. Default: 10MiB. Accepts a positive byte count or a unit string such as `40KiB`. Units: B, KB, MB, GB, KiB, MiB, GiB.",
          ),
        maxInlineBytesTotal: byteSizeSchema
          .default(20 * 1024 * 1024)
          .describe(
            "Maximum total inline media bytes. Default: 20MiB. Accepts a positive byte count or a unit string such as `40KiB`. Units: B, KB, MB, GB, KiB, MiB, GiB.",
          ),
      })
      .default({
        maxInlineBytesPerPart: 10 * 1024 * 1024,
        maxInlineBytesTotal: 20 * 1024 * 1024,
      })
      .describe("Inline media byte budgets for model input."),
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
    output: {
      maxPreviewBytes: 40 * 1024,
      artifactTtl: 7 * 24 * 60 * 60 * 1000,
      artifactMaxBytesPerSession: 50 * 1024 * 1024,
    },
    historicalResultPruning: {
      enabled: false,
      protectTokens: 40_000,
      minimumTokens: 20_000,
    },
    batch: { maxCalls: 8 },
    media: {
      maxInlineBytesPerPart: 10 * 1024 * 1024,
      maxInlineBytesTotal: 20 * 1024 * 1024,
    },
  });

const jevDecisionProbabilitiesV2 = {
  recallMinProbability: 0,
  durableSubjectMinProbability: 0.6,
  casualMaxProbability: 0.6,
  relevanceMinProbability: 0.2,
};

const lunaDecisionProbabilitiesV2 = {
  recallMinProbability: 0,
  durableSubjectMinProbability: 0.5,
  casualMaxProbability: 0.3,
  relevanceMinProbability: 0.1,
};

const decisionProbabilityOverridesSchemaV2 = z.object({
  recallMinProbability: z
    .number()
    .min(0)
    .max(1)
    .optional()
    .describe(
      "Minimum classifier probability that recall is needed, from 0 to 1. Omit to inherit this classifier's default.",
    ),
  durableSubjectMinProbability: z
    .number()
    .min(0)
    .max(1)
    .optional()
    .describe(
      "Minimum probability of a durable subject worth recalling, from 0 to 1. Omit to inherit this classifier's default.",
    ),
  casualMaxProbability: z
    .number()
    .min(0)
    .max(1)
    .optional()
    .describe(
      "Maximum casual-conversation probability accepted for recall, from 0 to 1. Omit to inherit this classifier's default.",
    ),
  relevanceMinProbability: z
    .number()
    .min(0)
    .max(1)
    .optional()
    .describe(
      "Minimum candidate relevance probability, from 0 to 1. Omit to inherit this classifier's default.",
    ),
});

const decisionAutoInjectDefaultsV2 = {
  model: ["typesafe/jev-1.13.0"],
  limit: 3,
  candidateLimit: 40,
  semanticFallback: true,
  jev: jevDecisionProbabilitiesV2,
  luna: lunaDecisionProbabilitiesV2,
};

const decisionAutoInjectSchemaV2 = decisionProbabilityOverridesSchemaV2
  .extend({
    model: z
      .union([z.string().trim().min(1), z.array(z.string().trim().min(1)).min(1)])
      .transform((model) => (typeof model === "string" ? [model] : model))
      .default(decisionAutoInjectDefaultsV2.model)
      .describe(
        "Decision model or non-empty model list. Text uses the first model; images use the first OpenAI entry when present. This is not a retry chain. TypeSafe uses TYPESAFE_AI_API_KEY / TYPESAFE_AI_BASE_URL; OpenAI uses OPENAI_API_KEY / OPENAI_BASE_URL.",
      ),
    limit: z
      .number()
      .int()
      .positive()
      .max(10)
      .default(decisionAutoInjectDefaultsV2.limit)
      .describe(
        "Maximum thread titles injected by decision recall. Default: 3; allowed range: 1 to 10.",
      ),
    candidateLimit: z
      .number()
      .int()
      .positive()
      .max(50)
      .default(decisionAutoInjectDefaultsV2.candidateLimit)
      .describe(
        "Maximum candidates considered by decision recall. Default: 40; allowed range: 1 to 50.",
      ),
    semanticFallback: z
      .boolean()
      .default(decisionAutoInjectDefaultsV2.semanticFallback)
      .describe("Include semantic candidates in decision recall when enabled. Defaults to true."),
    jev: decisionProbabilityOverridesSchemaV2
      .optional()
      .describe(
        "TypeSafe JEV probability thresholds. Defaults: recall 0, durable subject 0.6, casual maximum 0.6, relevance 0.2.",
      ),
    luna: decisionProbabilityOverridesSchemaV2
      .optional()
      .describe(
        "OpenAI Luna probability thresholds. Defaults: recall 0, durable subject 0.5, casual maximum 0.3, relevance 0.1.",
      ),
  })
  .transform(
    ({
      jev,
      luna,
      recallMinProbability,
      durableSubjectMinProbability,
      casualMaxProbability,
      relevanceMinProbability,
      ...options
    }) => {
      const legacy = {
        ...(recallMinProbability !== undefined ? { recallMinProbability } : {}),
        ...(durableSubjectMinProbability !== undefined ? { durableSubjectMinProbability } : {}),
        ...(casualMaxProbability !== undefined ? { casualMaxProbability } : {}),
        ...(relevanceMinProbability !== undefined ? { relevanceMinProbability } : {}),
      };
      return {
        ...options,
        jev: { ...jevDecisionProbabilitiesV2, ...legacy, ...jev },
        luna: { ...lunaDecisionProbabilitiesV2, ...legacy, ...luna },
      };
    },
  );

const conversationSchemaV2 = z
  .object({
    thread: z
      .object({
        summarization: z
          .object({
            enabled: z
              .boolean()
              .default(false)
              .describe(
                "Enable the background summarization worker. The hidden conversation.thread.runSummarization tool can still run manually when disabled.\n\nDefault: `false`.",
              ),
            model: z
              .string()
              .trim()
              .min(1)
              .default("fast")
              .describe(
                "Summary model: main, fast, a models.def alias, or provider/model. Defaults to fast.",
              ),
            concurrency: z
              .number()
              .int()
              .min(1)
              .max(128)
              .default(1)
              .describe(
                "Threads summarized concurrently within a run. Default: 1; allowed range: 1 to 128.",
              ),
            batchSize: z
              .number()
              .int()
              .min(1)
              .max(10_000)
              .default(32)
              .describe(
                "Maximum threads processed in a periodic run. Default: 32; maximum: 10000. Manual runs are unbounded unless given an explicit limit.",
              ),
            includePromptContext: z
              .boolean()
              .default(false)
              .describe(
                "Include MEMORY.md, USER.md, and optional ENTITIES.md as background-only disambiguation context. Defaults to false.",
              ),
          })
          .default({
            enabled: false,
            model: "fast",
            concurrency: 1,
            batchSize: 32,
            includePromptContext: false,
          })
          .describe("Background thread-summary generation. Disabled by default."),
        embedding: z
          .object({
            enabled: z
              .boolean()
              .default(false)
              .describe(
                "Generate semantic thread embeddings. Defaults to false. Lexical search still works when disabled or embedding generation fails.",
              ),
            model: z
              .string()
              .trim()
              .min(1)
              .default("openai/text-embedding-3-small")
              .describe(
                "AI SDK embedding model in provider/model format or a models.def alias. Defaults to openai/text-embedding-3-small.",
              ),
            queryModel: z
              .string()
              .trim()
              .min(1)
              .optional()
              .describe(
                "Optional query encoder. Must share the document embedding model's vector space and dimensions. Omit to use the document model.",
              ),
          })
          .default({ enabled: false, model: "openai/text-embedding-3-small" })
          .describe(
            "Semantic thread-embedding generation. Summaries and lexical search remain usable without it.",
          ),
        autoInject: z
          .object({
            enabled: z
              .boolean()
              .default(false)
              .describe(
                "Inject related thread title metadata for eligible user messages. Defaults to false.",
              ),
            plannerModel: z
              .string()
              .trim()
              .min(1)
              .optional()
              .describe(
                "Search-planning model: main, fast, a models.def alias, or provider/model. Omit to inherit conversation.thread.summarization.model.",
              ),
            textPlannerModel: z
              .string()
              .trim()
              .min(1)
              .optional()
              .describe(
                "Optional planner override for composed input containing only text. Accepts the same values as plannerModel; omit to use plannerModel.",
              ),
            gate: z
              .object({
                mode: z
                  .enum(["off", "shadow", "enforce"])
                  .default("shadow")
                  .describe(
                    "off disables gating; shadow records decisions but still retrieves; enforce skips confident negatives. Defaults to shadow.",
                  ),
                model: z
                  .union([z.string().trim().min(1), z.array(z.string().trim().min(1)).min(1)])
                  .transform((model) => (typeof model === "string" ? [model] : model))
                  .default(["typesafe/jev-1.13.0"])
                  .describe(
                    "Decision model or non-empty model list. Text uses the first model; images use the first OpenAI entry when present. This is not a retry chain. TypeSafe uses TYPESAFE_AI_API_KEY / TYPESAFE_AI_BASE_URL; OpenAI uses OPENAI_API_KEY / OPENAI_BASE_URL.",
                  ),
                skipMinProbability: z
                  .number()
                  .min(0.5)
                  .max(1)
                  .default(0.8)
                  .describe(
                    "Confidence required to skip in enforce mode. Default: 0.8; allowed range: 0.5 to 1.",
                  ),
              })
              .optional()
              .describe(
                "Optional decision gate before planning. Omit to plan every eligible input. Shadow records decisions while still retrieving; enforce skips confident negatives. Failures continue to the planner.",
              ),
            minTextUnits: z
              .number()
              .int()
              .positive()
              .default(10)
              .describe(
                "Minimum authored text mass after URLs, Discord syntax, and punctuation are removed and code blocks discounted. Default: 10, allowing short questions.",
              ),
            followUpMinTextUnits: z
              .number()
              .int()
              .positive()
              .default(10)
              .describe(
                "Minimum text mass after this conversation already received injected metadata. Default: 10. Increase to reduce follow-up searches.",
              ),
            limit: z
              .number()
              .int()
              .positive()
              .max(10)
              .default(3)
              .describe("Maximum thread titles injected. Default: 3; allowed range: 1 to 10."),
            minScore: z
              .number()
              .nonnegative()
              .default(0.1)
              .describe(
                "Minimum final search score after semantic/lexical ranking and aboutness coverage. Default: 0.1. Use 0 for broad/debug recall.",
              ),
            expansionMinConfidence: z
              .number()
              .min(0)
              .max(1)
              .default(0.65)
              .describe(
                "Confidence threshold for optional results 2 through limit. The best remaining candidate is kept when search finds one. Default: 0.65. Values 0.45-0.55 favor recall; 0.65-0.75 favor precision. Tune this before minScore, which removes candidates earlier.",
              ),
            mode: z
              .enum(["hybrid", "semantic", "lexical"])
              .default("hybrid")
              .describe(
                "Search strategy: hybrid combines semantic and lexical retrieval; semantic or lexical selects one. Defaults to hybrid.",
              ),
            filterCurrentParticipants: z
              .boolean()
              .default(false)
              .describe(
                "Restrict Discord-origin recall of Discord threads to participants visible in the composed request/reply chain. Native candidates and native-origin cross-surface recall remain global. Defaults to false.",
              ),
          })
          .default({
            enabled: false,
            minTextUnits: 10,
            followUpMinTextUnits: 10,
            limit: 3,
            minScore: 0.1,
            expansionMinConfidence: 0.65,
            mode: "hybrid",
            filterCurrentParticipants: false,
          })
          .describe(
            "Automatic injection of related thread title metadata before answers. Disabled by default.",
          ),
        autoInjectMode: z
          .enum(["llm", "decision", "jev"])
          .default("llm")
          .transform((mode) => (mode === "jev" ? ("decision" as const) : mode))
          .describe(
            "Recall selection strategy: llm uses the search planner; decision uses classifier-based recall. Defaults to llm.",
          ),
        decisionAutoInject: decisionAutoInjectSchemaV2
          .optional()
          .describe(
            "Classifier-based recall options used by decision mode. Set probability overrides separately under jev and luna.",
          ),
        jevAutoInject: decisionAutoInjectSchemaV2
          .optional()
          .describe("Legacy name for decisionAutoInject. Removed in configuration version 3."),
      })
      .transform(({ jevAutoInject, decisionAutoInject, ...thread }) => ({
        ...thread,
        autoInject: {
          ...thread.autoInject,
          ...(thread.autoInject.gate || thread.autoInjectMode === "llm"
            ? {}
            : {
                gate: {
                  mode: "shadow" as const,
                  model: (decisionAutoInject ?? jevAutoInject ?? decisionAutoInjectDefaultsV2)
                    .model,
                  skipMinProbability: 0.8,
                },
              }),
        },
        decisionAutoInject: decisionAutoInject ??
          jevAutoInject ?? { ...decisionAutoInjectDefaultsV2 },
      }))
      .default({
        summarization: {
          enabled: false,
          model: "fast",
          concurrency: 1,
          batchSize: 32,
          includePromptContext: false,
        },
        embedding: { enabled: false, model: "openai/text-embedding-3-small" },
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
        decisionAutoInject: decisionAutoInjectDefaultsV2,
      })
      .describe(
        "Thread memory: summaries, semantic embeddings, and related-thread metadata injection.",
      ),
  })
  .default({
    thread: {
      summarization: {
        enabled: false,
        model: "fast",
        concurrency: 1,
        batchSize: 32,
        includePromptContext: false,
      },
      embedding: { enabled: false, model: "openai/text-embedding-3-small" },
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
      decisionAutoInject: decisionAutoInjectDefaultsV2,
    },
  });

const workflowsSchemaV2 = z
  .object({
    maxActiveRuns: z
      .number()
      .int()
      .positive()
      .default(64)
      .describe(
        "Global admission cap across queued, running, blocked, and paused workflow runs. Defaults to 64; must be a positive integer.",
      ),
  })
  .default({ maxActiveRuns: 64 });

const modelsSchemaV2 = z
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
          /** Portable AI SDK reasoning effort. */
          reasoning: modelReasoningEffortSchema
            .optional()
            .describe(
              "Portable reasoning effort. `provider-default` leaves the choice to the provider. Supported effort levels depend on the selected model.",
            ),
          /** AI SDK providerOptions-style object (nested JSON allowed). */
          options: jsonObjectSchema
            .optional()
            .describe(
              "Provider-specific options merged onto inherited model settings. Accepts shorthand such as `{temperature: 0.2}` or nested provider namespaces such as `{openai: {parallelToolCalls: false}}. OpenAI-compatible options use `openaiCompatible`.\n\nLilac options include `response_commentary` for direct OpenAI/Codex channel guidance, `openai_server_compaction` to opt into server compaction, and `anthropic_prompt_cache` to opt into system/latest-user cache control. Cache writes can increase cost and interact poorly with tool-result pruning.",
            ),
          /** Optional ordered model fallback chain. */
          fallback: modelFallbackSchemaV2.describe(
            "Ordered fallback models, each a model reference/alias or `{model, reasoning, options}`. A model-slot chain takes precedence over the selected alias chain. Automatic fallback stays within the head model's provider family and is disabled for a `claude-code` head.",
          ),
          /** Optional parent-agent guidance shown alongside this model alias. */
          comment: z
            .string()
            .trim()
            .min(1)
            .optional()
            .describe(
              "Guidance shown to agents choosing this model alias. Describe the tasks it suits or relevant cost/latency tradeoffs.",
            ),
          /** Whether subagent_delegate may dynamically select this alias. */
          agentCanSelect: z
            .boolean()
            .default(false)
            .describe(
              "Allow agents to dynamically select this configured alias for delegation. Defaults to false. Human overrides and model-slot references remain available.",
            ),
        }),
      )
      .default({})
      .describe(
        "Reusable model aliases. Alias names cannot contain `/`; each alias must name a canonical provider/model. Example: `assistant: {model: openai/gpt-4o, agentCanSelect: true}`.",
      ),

    main: z
      .object({
        /** Model spec in provider/model format OR an alias from models.def. */
        model: z
          .string()
          .min(1)
          .default("openrouter/openai/gpt-4o")
          .describe(
            'Model reference in `provider/model` format or an alias from `models.def`. For example, `openai/gpt-4o`.\n\nDefault: `"openrouter/openai/gpt-4o"`.',
          ),
        /** Portable AI SDK reasoning effort. */
        reasoning: modelReasoningEffortSchema
          .optional()
          .describe(
            "Portable reasoning effort. `provider-default` leaves the choice to the provider. Supported effort levels depend on the selected model.",
          ),
        /** Provider-specific model options. */
        options: jsonObjectSchema
          .optional()
          .describe(
            "Provider-specific options merged onto inherited model settings. Accepts shorthand such as `{temperature: 0.2}` or nested provider namespaces such as `{openai: {parallelToolCalls: false}}. OpenAI-compatible options use `openaiCompatible`.\n\nLilac options include `response_commentary` for direct OpenAI/Codex channel guidance, `openai_server_compaction` to opt into server compaction, and `anthropic_prompt_cache` to opt into system/latest-user cache control. Cache writes can increase cost and interact poorly with tool-result pruning.",
          ),
        /** Optional ordered model fallback chain. */
        fallback: modelFallbackSchemaV2.describe(
          "Ordered fallback models, each a model reference/alias or `{model, reasoning, options}`. A model-slot chain takes precedence over the selected alias chain. Automatic fallback stays within the head model's provider family and is disabled for a `claude-code` head.",
        ),
      })
      .default({
        model: "openrouter/openai/gpt-4o",
      })
      .describe(
        "Primary request model and optional reasoning, options, and fallback overrides. Defaults to openrouter/openai/gpt-4o.",
      ),

    /** Fast/cheap model for lightweight features (router gate, etc.). */
    fast: z
      .object({
        model: z
          .string()
          .min(1)
          .default("openrouter/openai/gpt-4o-mini")
          .describe(
            'Model reference in `provider/model` format or an alias from `models.def`. For example, `openai/gpt-4o`.\n\nDefault: `"openrouter/openai/gpt-4o-mini"`.',
          ),
        reasoning: modelReasoningEffortSchema
          .optional()
          .describe(
            "Portable reasoning effort. `provider-default` leaves the choice to the provider. Supported effort levels depend on the selected model.",
          ),
        options: jsonObjectSchema
          .optional()
          .describe(
            "Provider-specific options merged onto inherited model settings. Accepts shorthand such as `{temperature: 0.2}` or nested provider namespaces such as `{openai: {parallelToolCalls: false}}. OpenAI-compatible options use `openaiCompatible`.\n\nLilac options include `response_commentary` for direct OpenAI/Codex channel guidance, `openai_server_compaction` to opt into server compaction, and `anthropic_prompt_cache` to opt into system/latest-user cache control. Cache writes can increase cost and interact poorly with tool-result pruning.",
          ),
        fallback: modelFallbackSchemaV2.describe(
          "Ordered fallback models, each a model reference/alias or `{model, reasoning, options}`. A model-slot chain takes precedence over the selected alias chain. Automatic fallback stays within the head model's provider family and is disabled for a `claude-code` head.",
        ),
      })
      .default({
        model: "openrouter/openai/gpt-4o-mini",
      })
      .describe(
        "Lightweight model used by features such as the router gate. Defaults to openrouter/openai/gpt-4o-mini.",
      ),

    capability: modelCapabilitySchemaV2.describe(
      "Manual model metadata and provider exclusions used when resolving model capabilities.",
    ),
  })
  .superRefine((models, ctx) => {
    for (const [alias, preset] of Object.entries(models.def)) {
      if (alias.includes("/")) {
        ctx.addIssue({
          code: "custom",
          path: ["def", alias],
          message: "model alias must not contain '/'",
        });
      }
      if (!/^[^/]+\/.+/u.test(preset.model)) {
        ctx.addIssue({
          code: "custom",
          path: ["def", alias, "model"],
          message: "models.def model must use provider/model format",
        });
      }
    }
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

const nativeHttpUrlSchema = z.url().refine((value) => {
  const url = new URL(value);
  return url.protocol === "http:" || url.protocol === "https:";
}, "Expected an HTTP or HTTPS URL");
const nativeOriginSchema = nativeHttpUrlSchema.refine(
  (value) => new URL(value).origin === value,
  "Expected an origin without a path or trailing slash",
);

export function validateNativeSurfaceConfig(
  value: Pick<UniversalCoreConfig["surface"]["native"], "enabled" | "installationId" | "auth">,
  ctx: z.RefinementCtx,
) {
  if (!value.enabled) return;
  if (!value.installationId)
    ctx.addIssue({
      code: "custom",
      path: ["installationId"],
      message: "Required when the native surface is enabled",
    });
  if (value.auth.provider !== "clerk") return;
  for (const key of ["ownerProviderUserId", "clerkIssuer"] as const) {
    if (value.auth[key]) continue;
    ctx.addIssue({
      code: "custom",
      path: ["auth", key],
      message: "Required when Clerk authentication is enabled",
    });
  }
}

const nativeSurfaceSchema = z
  .object({
    enabled: z
      .boolean()
      .default(false)
      .describe(
        "Enable the native web/TUI gateway. Defaults to false. Requires a unique installationId; Clerk auth also requires ownerProviderUserId and clerkIssuer.",
      ),
    host: z
      .string()
      .trim()
      .min(1)
      .default("127.0.0.1")
      .describe(
        "Gateway bind address. Defaults to 127.0.0.1; choose an externally reachable address only when appropriate for the deployment.",
      ),
    port: z
      .number()
      .int()
      .min(1)
      .max(65535)
      .default(8789)
      .describe("Gateway TCP port, from 1 to 65535. Defaults to 8789."),
    publicUrl: nativeHttpUrlSchema
      .default("http://localhost:8789")
      .describe("Public HTTP(S) URL for the native gateway. Defaults to http://localhost:8789."),
    installationId: z
      .string()
      .trim()
      .min(1)
      .max(256)
      .optional()
      .describe(
        "Unique, stable identifier for this Lilac installation. Required when enabled; maximum 256 characters.",
      ),
    allowedOrigins: z
      .array(nativeOriginSchema)
      .min(1)
      .default(["http://localhost:8789"])
      .describe(
        "Non-empty list of browser origins allowed to connect. Origins must have no path or trailing slash. Default: [http://localhost:8789].",
      ),
    auth: z
      .object({
        provider: z
          .enum(["local", "clerk"])
          .default("local")
          .describe(
            "Authentication backend: local or clerk. Defaults to local. Clerk requires ownerProviderUserId and clerkIssuer.",
          ),
        ownerId: z
          .string()
          .trim()
          .min(1)
          .max(256)
          .refine(
            (value) => value !== "lilac",
            "The lilac identity is reserved for the service user",
          )
          .default("owner")
          .describe(
            "Local owner identity. Defaults to owner. The name lilac is reserved for the service user.",
          ),
        ownerProviderUserId: z
          .string()
          .trim()
          .min(1)
          .optional()
          .describe(
            "Clerk user ID mapped to the installation owner. Required when native Clerk authentication is enabled.",
          ),
        clerkIssuer: z
          .url()
          .optional()
          .describe(
            "Clerk token issuer URL. Required when native Clerk authentication is enabled.",
          ),
        clerkOAuthClientId: z
          .string()
          .trim()
          .min(1)
          .optional()
          .describe("Optional Clerk OAuth client ID enabling TUI login."),
      })
      .default({ provider: "local", ownerId: "owner" })
      .describe(
        "Native authentication. Local credentials use LILAC_NATIVE_LOCAL_USERNAME and LILAC_NATIVE_LOCAL_PASSWORD_HASH; session signing uses LILAC_NATIVE_SESSION_SECRET (at least 32 bytes).",
      ),
    // Legacy values seed native deployment settings only when the database has no record.
    titleModel: z
      .string()
      .trim()
      .min(1)
      .default("fast")
      .describe(
        'Legacy initial thread-title model. Version 3 configures this in Settings > Deployment.\n\nDefault: `"fast"`.',
      ),
    outputStreaming: z
      .enum(["paragraph", "complete"])
      .default("paragraph")
      .describe(
        'Legacy initial output streaming policy. Version 3 configures this in Settings > Deployment.\n\nDefault: `"paragraph"`.',
      ),
    oldMessageSelectionMaxAgeMs: positiveDurationMsSchema
      .nullable()
      .default(null)
      .describe(
        "Legacy initial message selection age limit. Version 3 configures this in Settings > Deployment.\n\nDefault: `null`.",
      ),
    storageRetentionMaxAgeMs: positiveDurationMsSchema
      .nullable()
      .default(null)
      .describe(
        "Legacy initial storage retention age limit. Version 3 configures this in Settings > Deployment.\n\nDefault: `null`.",
      ),
    crossThreadSend: z
      .object({
        triggerRun: z
          .boolean()
          .default(true)
          .describe(
            "Whether a cross-thread send triggers a run by default in the legacy deployment seed.\n\nDefault: `true`.",
          ),
      })
      .default({ triggerRun: true })
      .describe(
        "Legacy initial cross-thread send policy. Version 3 configures this in Settings > Deployment.",
      ),
  })
  .superRefine(validateNativeSurfaceConfig)
  .default(defaultNativeSurfaceConfig());

export const agentSchemaFieldsV2 = {
  statsForNerds: statsForNerdsSchema.describe(
    "Response metadata statistics: false disables them, true includes model/timing/throughput, and `{verbose: true}` also includes input composition.",
  ),
  reasoningDisplay: reasoningDisplaySchema.describe(
    "Discord streaming reasoning display. `none` hides it; `simple` shows the working title and elapsed timer; `detailed` also shows blockquoted reasoning, clamped to 500 characters.",
  ),
  idleTimeoutMs: z
    .number()
    .int()
    .min(1_500)
    .default(15 * 60 * 1000)
    .describe(
      "Stop a primary run after this many milliseconds without model, tool, or subagent activity. Default: 900000 (15 minutes); minimum: 1500. Active runs may continue indefinitely. Child idle timeout is floor(2/3 of this), with a 1000 ms minimum.",
    ),
  retry: agentRetrySchema.describe(
    "Retry policy for transient provider failures and replay-safe idle timeouts.",
  ),
  transcriptRetention: transcriptRetentionSchema.describe(
    "Independent age and count limits for completed request transcripts. Each can be unlimited.",
  ),
  subagents: subagentsSchemaV2
    .default({
      enabled: true,
      maxDepth: 2,
      profiles: {
        explore: EXPLORE_PROFILE_DEFAULT,
        general: GENERAL_PROFILE_DEFAULT,
        self: SELF_PROFILE_DEFAULT,
      },
    })
    .describe(
      "Delegated child-agent execution and permissions. Child idle timeout derives from agent.idleTimeoutMs.",
    ),
};

export const AGENT_DEFAULT_V2 = {
  statsForNerds: false,
  reasoningDisplay: "detailed",
  idleTimeoutMs: 15 * 60 * 1000,
  retry: {
    enabled: true,
    maxRetries: 3,
    baseDelayMs: 2_000,
    maxDelayMs: 30_000,
  },
  transcriptRetention: {
    maxAge: DEFAULT_TRANSCRIPT_RETENTION_MAX_AGE_MS,
    maxRequests: DEFAULT_TRANSCRIPT_RETENTION_MAX_REQUESTS,
  },
  subagents: {
    enabled: true,
    maxDepth: 2,
    profiles: {
      explore: EXPLORE_PROFILE_DEFAULT,
      general: GENERAL_PROFILE_DEFAULT,
      self: SELF_PROFILE_DEFAULT,
    },
  },
} satisfies z.output<z.ZodObject<typeof agentSchemaFieldsV2>>;

export const coreConfigInputSchemaV2 = z.object({
  configVersion: configVersionSchema.describe(
    "Configuration format version. New files use 3. An omitted version is parsed as version 1; set this explicitly before using newer fields. See docs/core-config-migrations.md for upgrades.",
  ),

  blobStorage: blobStorageSchemaV2
    .optional()
    .describe(
      "Storage for managed opaque bytes. Omit to use local storage below DATA_DIR. For a custom local location use `{kind: local, root: /var/lib/lilac/blobs}`. For S3 use an existing private bucket and environment-variable names for credentials.",
    ),

  tools: toolsSchema.describe(
    "File, web, media, and tool-result settings. Omitted options use the defaults shown on their fields.",
  ),
  plugins: pluginsSchemaV2.describe(
    "Enablement and plugin-specific configuration for built-in and external plugins.",
  ),
  conversation: conversationSchemaV2.describe(
    "Experimental conversation memory: thread summaries, embeddings, and automatic recall. Background summarization, embedding, and injection are disabled by default. Behavior and storage may change.",
  ),
  workflows: workflowsSchemaV2.describe("Durable workflow execution settings."),

  surface: z
    .object({
      workingIndicators: z
        .array(z.string().trim().min(1))
        .min(1)
        .default(cloneDefaultWorkingIndicators())
        .describe(
          'Non-empty status phrases rotated while a request runs. Native web uses these instead of "Working" and their past tense instead of "Worked". Omit to use Lilac\'s built-in phrases.',
        ),
      native: nativeSurfaceSchema.describe(
        "Native web/TUI gateway and authentication. Set a unique installationId before enabling. Runtime deployment settings are managed through Settings > Deployment.",
      ),
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
      workingIndicators: cloneDefaultWorkingIndicators(),
      native: defaultNativeSurfaceConfig(),
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
        outputPreviewModeFinalText: "flat",
        outputNotification: true,
        attachmentCache: { ttl: DEFAULT_DISCORD_ATTACHMENT_CACHE_TTL_MS },
        markdownTableRender: {
          enabled: true,
          style: "unicode",
          maxWidth: 50,
          fallbackMode: "list",
        },
        markdownMathRender: {
          enabled: false,
          maxWidth: 50,
          fallbackMode: "source",
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
    .object(agentSchemaFieldsV2)
    .default(AGENT_DEFAULT_V2)
    .describe("Agent execution, retry, transcript retention, display, and delegation settings."),

  models: modelsSchemaV2.describe(
    "Model slots, reusable aliases, capability overrides, catalog visibility, and ordered option rules. Local Claude subscription models use `claude-code/<model>`; see docs/claude-code.md for authentication, persistent storage, and continuation limits.",
  ),
  entity: coreConfigInputSchemaV1.shape.entity.describe(
    "Discord aliases for users and channels. Rewrites outbound @name/#name to Discord mentions and inbound mentions to aliases. Matching is case-insensitive; configured casing is preserved. Whitespace becomes underscores and leading @/# is stripped. Optional comments accompany aliases in the system prompt.",
  ),
  basePrompt: z
    .string()
    .optional()
    .describe(
      "Base instructions. Codex uses this as Responses instructions when `codex_instructions` is absent. Other providers prepend it to the prompt files under DATA_DIR/prompts. Omit to use the provider's normal prompt assembly.",
    ),
});

export type ParsedCoreConfigV2 = z.infer<typeof coreConfigInputSchemaV2>;

export class CoreConfigV2Invalid extends TaggedError("CoreConfigV2Invalid")<{
  readonly cause: z.ZodError;
  readonly message: string;
}> {}

export function decodeCoreConfigV2(
  raw: unknown,
): ResultType<ParsedCoreConfigV2, CoreConfigV2Invalid> {
  const parsed = coreConfigInputSchemaV2.safeParse(raw);
  return parsed.success
    ? Result.ok(parsed.data)
    : Result.err(
        new CoreConfigV2Invalid({
          cause: parsed.error,
          message: parsed.error.issues.map((issue) => issue.message).join("; "),
        }),
      );
}

export function parseCoreConfigV2(raw: unknown): ParsedCoreConfigV2 {
  return coreConfigInputSchemaV2.parse(raw);
}

type UniversalSubagentsConfig = UniversalCoreConfig["agent"]["subagents"];

/** Shared v2-shaped conversion; each version supplies its own subagent mapping. */
export function coreConfigV2ShapeToUniversal<
  T extends Omit<ParsedCoreConfigV2, "configVersion" | "agent" | "models" | "tools"> & {
    tools: Omit<ParsedCoreConfigV2["tools"], "inspect"> & { inspect?: { model: string } };
    models: UniversalCoreConfig["models"];
    configVersion: CoreConfigVersion;
    agent: Omit<ParsedCoreConfigV2["agent"], "subagents"> & { subagents: object };
  },
>(
  parsed: T,
  raw: unknown,
  options: CoreConfigParseOptions | undefined,
  toSubagents: (subagents: T["agent"]["subagents"]) => UniversalSubagentsConfig,
): UniversalCoreConfig {
  if (options?.onUnknownKey) {
    for (const path of collectUnknownConfigKeyPaths(raw, parsed)) {
      options.onUnknownKey(path);
    }
  }
  // Zod default objects may be reused between parses. Isolate the decoded
  // config so runtime/test mutations cannot change a later parse's defaults.
  const isolated = structuredClone(parsed);
  const { inspect: _removedInspect, ...tools } = isolated.tools;
  const { artifactTtl, ...output } = tools.output;
  const { firecrawl, ...web } = isolated.tools.web;
  const { attachmentCache, ...discord } = isolated.surface.discord;
  const { transcriptRetention, ...agent } = isolated.agent;

  const retentionLimit = (value: number | "unlimited"): RetentionLimit =>
    value === "unlimited" ? { kind: "unlimited" } : { kind: "bounded", value };

  return {
    ...isolated,
    blobStorage: isolated.blobStorage ?? { kind: "local" },
    tools: {
      ...tools,
      web: firecrawl
        ? {
            ...web,
            firecrawl: {
              maxConcurrency: firecrawl.maxConcurrency,
              queueTtlMs: firecrawl.queueTtl,
            },
          }
        : web,
      output: {
        ...output,
        artifactTtlMs: artifactTtl,
      },
    },
    surface: {
      ...isolated.surface,
      discord: {
        ...discord,
        workingIndicators: discord.workingIndicators ?? isolated.surface.workingIndicators,
        attachmentCache: {
          ttlMs: retentionLimit(attachmentCache.ttl),
        },
      },
    },
    agent: {
      ...agent,
      transcriptRetention: {
        maxAgeMs: retentionLimit(transcriptRetention.maxAge),
        maxRequests: retentionLimit(transcriptRetention.maxRequests),
      },
      subagents: toSubagents(isolated.agent.subagents),
      systemPrompt: "",
      workerSystemPrompt: "",
    },
  };
}

function permissionAuthorityFromV2Profile(
  profile: SubagentProfileConfigV2,
): SubagentPermissionProfileConfig {
  const normalized = normalizeProfileToolNames(profile);
  return {
    ...(normalized.promptOverlay ? { promptOverlay: normalized.promptOverlay } : {}),
    level1: normalized.level1,
    level2: normalized.level2,
    network: normalized.network,
    workspaceWrites: normalized.workspaceWrites,
    execution: normalized.execution,
    delegation: normalized.delegation,
  };
}

// Frozen v2 role profiles map onto the universal permission profiles: explore
// becomes restricted, self becomes full, and general keeps its name and
// authority. Per-profile model fields have no universal equivalent.
function subagentsV2ToUniversal(
  subagents: ParsedCoreConfigV2["agent"]["subagents"],
): UniversalSubagentsConfig {
  return {
    enabled: subagents.enabled,
    maxDepth: subagents.maxDepth,
    ...(subagents.delegatePromptOverlay
      ? { delegatePromptOverlay: subagents.delegatePromptOverlay }
      : {}),
    defaultPermissions: "restricted",
    permissions: {
      restricted: permissionAuthorityFromV2Profile(subagents.profiles.explore),
      general: permissionAuthorityFromV2Profile(subagents.profiles.general),
      full: permissionAuthorityFromV2Profile(subagents.profiles.self),
    },
  };
}

function coreConfigV2ToUniversal(
  parsed: ParsedCoreConfigV2,
  raw: unknown,
  options?: CoreConfigParseOptions,
): UniversalCoreConfig {
  return coreConfigV2ShapeToUniversal(parsed, raw, options, subagentsV2ToUniversal);
}

export function decodeCoreConfigV2ToUniversal(
  raw: unknown,
  options?: CoreConfigParseOptions,
): ResultType<UniversalCoreConfig, CoreConfigV2Invalid> {
  const parsed = decodeCoreConfigV2(raw);
  const continueDecode = parsed.match<() => ResultType<UniversalCoreConfig, CoreConfigV2Invalid>>({
    ok: (value) => () => Result.ok(coreConfigV2ToUniversal(value, raw, options)),
    err: (error) => () => Result.err(error),
  });
  return continueDecode();
}

export function parseCoreConfigV2ToUniversal(
  raw: unknown,
  options?: CoreConfigParseOptions,
): UniversalCoreConfig {
  const result = decodeCoreConfigV2ToUniversal(raw, options);
  const resolved = result.match<
    { readonly value: UniversalCoreConfig } | { readonly error: CoreConfigV2Invalid }
  >({
    ok: (value) => ({ value }),
    err: (error) => ({ error }),
  });
  if ("error" in resolved) throw resolved.error.cause;
  return resolved.value;
}

export class V2CoreConfigParser implements ConfigParser {
  readonly version = V2_CORE_CONFIG_VERSION;

  async parse(input: object, options?: CoreConfigParseOptions): Promise<UniversalCoreConfig> {
    return parseCoreConfigV2ToUniversal(input, options);
  }
}
