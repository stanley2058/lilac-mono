import { Result, TaggedError, type Result as ResultType } from "better-result";
import { z } from "zod";

import { defaultNativeSurfaceConfig, MODEL_REASONING_EFFORTS } from "./types";
import { isPermissionProfileName } from "../subagent-profile";
import {
  AGENT_DEFAULT_V2,
  agentSchemaFieldsV2,
  coreConfigInputSchemaV2,
  coreConfigV2ShapeToUniversal,
  normalizeProfileToolNames,
  profileLevel1Schema,
  profileLevel2Schema,
  validateNativeSurfaceConfig,
} from "./v2";

import type {
  ConfigParser,
  CoreConfigParseOptions,
  CoreConfigVersion,
  SubagentPermissionProfileConfig,
  UniversalCoreConfig,
} from "./types";

export const V3_CORE_CONFIG_VERSION = 3 satisfies CoreConfigVersion;
export const CURRENT_CORE_CONFIG_VERSION = V3_CORE_CONFIG_VERSION;
export const DEFAULT_CORE_CONFIG_VERSION = 1 satisfies CoreConfigVersion;
export const SUPPORTED_CORE_CONFIG_VERSIONS = [
  1, 2, 3,
] as const satisfies readonly CoreConfigVersion[];

const FULL_PERMISSIONS_DEFAULT: SubagentPermissionProfileConfig = {
  level1: { tools: ["*"], plugins: ["*"] },
  level2: { callables: ["*"], plugins: ["*"] },
  network: true,
  workspaceWrites: true,
  execution: "native",
  delegation: true,
};

const RESTRICTED_PERMISSIONS_DEFAULT: SubagentPermissionProfileConfig = {
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

function permissionProfileSchemaV3(defaults: SubagentPermissionProfileConfig) {
  return z.object({
    promptOverlay: z
      .string()
      .trim()
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
  });
}

const permissionProfilesSchemaV3 = z
  .object({
    full: permissionProfileSchemaV3(FULL_PERMISSIONS_DEFAULT)
      .default(FULL_PERMISSIONS_DEFAULT)
      .describe(
        "Full globally enabled tool access, network, workspace writes, native execution, and further delegation by default. Explicit fields override these defaults.",
      ),
    restricted: permissionProfileSchemaV3(RESTRICTED_PERMISSIONS_DEFAULT)
      .default(RESTRICTED_PERMISSIONS_DEFAULT)
      .describe(
        "Defaults to read-oriented local and lookup tools, network enabled, workspace writes disabled, native execution, and delegation disabled. This is a tool/behavior policy; native execution retains host authority.",
      ),
  })
  // Custom profiles start from the restricted defaults.
  .catchall(permissionProfileSchemaV3(RESTRICTED_PERMISSIONS_DEFAULT))
  .superRefine((profiles, ctx) => {
    for (const name of Object.keys(profiles)) {
      if (isPermissionProfileName(name)) continue;
      ctx.addIssue({
        code: "custom",
        path: [name],
        message:
          "permission profile names must be lowercase slugs of at most 32 characters other than primary",
      });
    }
  });

const subagentsSchemaV3 = z.object({
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
  permissions: permissionProfilesSchemaV3
    .default({
      full: FULL_PERMISSIONS_DEFAULT,
      restricted: RESTRICTED_PERMISSIONS_DEFAULT,
    })
    .describe(
      "Named permission profiles shared by direct and workflow launches. Omitted permissions on a direct delegation select full when the caller can grant it, otherwise the caller's own profile; v1/v2 default to restricted. Built-ins full and restricted always exist. Custom lowercase slug names (maximum 32 characters, excluding primary) inherit restricted defaults. A child may only select authority within its own. Models are selected separately per delegation.",
    ),
  profiles: z
    .never({
      error:
        "agent.subagents.profiles was removed in configVersion 3; move authority fields to agent.subagents.permissions and choose models per delegation",
    })
    .optional(),
});

const SUBAGENTS_DEFAULT_V3 = {
  enabled: true,
  maxDepth: 2,
  permissions: {
    full: FULL_PERMISSIONS_DEFAULT,
    restricted: RESTRICTED_PERMISSIONS_DEFAULT,
  },
} satisfies z.output<typeof subagentsSchemaV3>;

const { subagents: _v2Subagents, ...agentFieldsWithoutSubagents } = agentSchemaFieldsV2;
const { subagents: _v2SubagentsDefault, ...agentDefaultWithoutSubagents } = AGENT_DEFAULT_V2;

const baseModels = coreConfigInputSchemaV2.shape.models.unwrap();
const modelRulesSchema = z
  .array(
    z.object({
      match: z
        .string()
        .min(1)
        .max(512)
        .describe(
          "Glob matched against the canonical provider/model reference. `*` also matches slashes. Rules apply in declaration order.",
        ),
      options: baseModels.shape.main.unwrap().shape.options,
      reasoning: z
        .enum(MODEL_REASONING_EFFORTS)
        .optional()
        .describe(
          "Portable reasoning effort. `provider-default` leaves the choice to the provider. Supported effort levels depend on the selected model.",
        ),
      unset: z
        .array(
          z
            .string()
            .regex(
              /^(?!.*(?:__proto__|constructor|prototype))[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/,
            ),
        )
        .optional()
        .describe(
          "Inherited option paths to remove, such as `[openai.someInheritedOption]`. Dot-separated path segments must contain letters, numbers, underscores, or hyphens; prototype-related names are forbidden.",
        ),
      legacy: z
        .boolean()
        .optional()
        .describe(
          "Override the matched catalog model's legacy flag, which controls its legacy classification in model discovery.",
        ),
    }),
  )
  .default([]);
const reasoningFieldsV3 = {
  reasoning: z
    .enum(MODEL_REASONING_EFFORTS)
    .optional()
    .describe(
      "Portable reasoning effort. `provider-default` leaves the choice to the provider. Supported effort levels depend on the selected model.",
    ),
  fallback: z
    .array(
      z.union([
        z.string().min(1),
        z.object({
          model: z
            .string()
            .min(1)
            .describe(
              "Model reference in `provider/model` format or an alias from `models.def`. For example, `openai/gpt-4o`.",
            ),
          reasoning: z
            .enum(MODEL_REASONING_EFFORTS)
            .optional()
            .describe(
              "Portable reasoning effort. `provider-default` leaves the choice to the provider. Supported effort levels depend on the selected model.",
            ),
          options: baseModels.shape.main.unwrap().shape.options,
        }),
      ]),
    )
    .optional()
    .describe(
      "Ordered fallback models, each a model reference/alias or `{model, reasoning, options}`. A model-slot chain takes precedence over the selected alias chain. Automatic fallback stays within the head model's provider family and is disabled for a `claude-code` head.",
    ),
};
const modelsSchemaV3 = z
  .object({
    ...baseModels.shape,
    def: z
      .record(
        z
          .string()
          .min(1)
          .refine((name) => !name.includes("/")),
        baseModels.shape.def.unwrap().valueType.extend({
          ...reasoningFieldsV3,
          agentCanSelect: baseModels.shape.def
            .unwrap()
            .valueType.shape.agentCanSelect.describe(
              "Compatibility field, ignored in v3. Agents can select every configured alias and available catalog model regardless of this value.",
            ),
          model: z
            .string()
            .regex(/^[^/]+\/.+/u)
            .describe(
              "Canonical provider/model reference. An alias cannot point to another alias. Example: openai/gpt-4o.",
            ),
        }),
      )
      .default({})
      .describe(
        "Reusable model aliases. Alias names cannot contain `/`; each alias must name a canonical provider/model. Example: `assistant: {model: openai/gpt-4o}`.",
      ),
    main: baseModels.shape.main
      .unwrap()
      .extend(reasoningFieldsV3)
      .default({ model: "openrouter/openai/gpt-4o" })
      .describe(
        "Primary request model and optional reasoning, options, and fallback overrides. Defaults to openrouter/openai/gpt-4o.",
      ),
    fast: baseModels.shape.fast
      .unwrap()
      .extend(reasoningFieldsV3)
      .default({ model: "openrouter/openai/gpt-4o-mini" })
      .describe(
        "Lightweight model used by features such as the router gate. Defaults to openrouter/openai/gpt-4o-mini.",
      ),
    catalog: z
      .object({
        providers: z
          .record(z.string(), z.enum(["auto", "enabled", "disabled"]))
          .default({})
          .describe(
            "Visibility by provider ID: auto infers availability from credentials, enabled shows the provider, disabled hides it. Example: `{codex: enabled, anthropic: disabled}`.",
          ),
      })
      .default({ providers: {} })
      .describe(
        "Model discovery visibility. Credentials are inferred by default; overrides affect catalog visibility only.",
      ),
    rules: modelRulesSchema.describe(
      'Ordered glob defaults applied before alias and per-run options. `*` includes slashes. Later matching rules can override earlier settings. Example: `{match: "codex/gpt-6-*", options: {serviceTier: priority}}.',
    ),
  })
  .default({
    def: {},
    main: { model: "openrouter/openai/gpt-4o" },
    fast: { model: "openrouter/openai/gpt-4o-mini" },
    capability: { forceUnknownProviders: ["openai-compatible"], overrides: {} },
    catalog: { providers: {} },
    rules: [],
  });

function removedV3Field(field: string, guidance: string) {
  return z.never({ error: `${field} was removed in configVersion 3; ${guidance}` }).optional();
}

const baseTools = coreConfigInputSchemaV2.shape.tools.unwrap();
const baseWeb = baseTools.shape.web.unwrap().out;
const webSchemaV3 = baseWeb.extend({
  search: removedV3Field("tools.web.search", "use tools.web.extract.providers"),
  extract: baseWeb.shape.extract
    .unwrap()
    .out.extend({
      provider: removedV3Field("tools.web.extract.provider", "use providers: [provider]"),
    })
    .default({ providers: ["tavily"] })
    .describe(
      "Provider-backed web extraction settings. Configure the ordered provider list under providers.",
    ),
});
const toolsSchemaV3 = baseTools
  .extend({
    inspect: removedV3Field("tools.inspect", "content.inspect is no longer available"),
    web: webSchemaV3.prefault({}).describe("Web fetching and extraction providers."),
  })
  .prefault({});

const baseConversation = coreConfigInputSchemaV2.shape.conversation.unwrap();
const baseThread = baseConversation.shape.thread.unwrap();
const baseDecision = baseThread.in.shape.decisionAutoInject.unwrap();
const decisionSchemaV3 = baseDecision.in
  .extend({
    recallMinProbability: removedV3Field(
      "decisionAutoInject.recallMinProbability",
      "set jev.recallMinProbability and luna.recallMinProbability",
    ),
    durableSubjectMinProbability: removedV3Field(
      "decisionAutoInject.durableSubjectMinProbability",
      "set jev.durableSubjectMinProbability and luna.durableSubjectMinProbability",
    ),
    casualMaxProbability: removedV3Field(
      "decisionAutoInject.casualMaxProbability",
      "set jev.casualMaxProbability and luna.casualMaxProbability",
    ),
    relevanceMinProbability: removedV3Field(
      "decisionAutoInject.relevanceMinProbability",
      "set jev.relevanceMinProbability and luna.relevanceMinProbability",
    ),
  })
  .transform((value): z.output<typeof baseDecision.in> => value)
  .pipe(baseDecision.out);
const conversationSchemaV3 = baseConversation
  .extend({
    thread: baseThread.in
      .extend({
        autoInjectMode: z
          .enum(["llm", "decision"], {
            error:
              "autoInjectMode must be llm or decision in configVersion 3; rename jev to decision",
          })
          .default("llm")
          .describe(
            "Compatibility selector. All recall uses the search planner; decision supplies a shadow gate when autoInject.gate is absent. Prefer autoInject.gate. Defaults to llm.",
          ),
        jevAutoInject: removedV3Field(
          "conversation.thread.jevAutoInject",
          "use decisionAutoInject",
        ),
        decisionAutoInject: decisionSchemaV3
          .optional()
          .describe(
            "Compatibility settings. Legacy decision mode uses the model list for a shadow gate; candidate budgets and probability thresholds no longer control retrieval. Prefer autoInject.gate.",
          ),
      })
      .transform((value): z.output<typeof baseThread.in> => value)
      .pipe(baseThread.out)
      .prefault({})
      .describe(
        "Thread memory: summaries, semantic embeddings, and related-thread metadata injection.",
      ),
  })
  .prefault({});

const baseSurface = coreConfigInputSchemaV2.shape.surface.unwrap();
const nativeSchemaV3 = z
  .object({
    ...baseSurface.shape.native.unwrap().shape,
    titleModel: removedV3Field("surface.native.titleModel", "use Settings > Deployment"),
    outputStreaming: removedV3Field("surface.native.outputStreaming", "use Settings > Deployment"),
    oldMessageSelectionMaxAgeMs: removedV3Field(
      "surface.native.oldMessageSelectionMaxAgeMs",
      "use Settings > Deployment",
    ),
    storageRetentionMaxAgeMs: removedV3Field(
      "surface.native.storageRetentionMaxAgeMs",
      "use Settings > Deployment",
    ),
    crossThreadSend: removedV3Field("surface.native.crossThreadSend", "use Settings > Deployment"),
  })
  .transform(
    ({
      titleModel: _titleModel,
      outputStreaming: _outputStreaming,
      oldMessageSelectionMaxAgeMs: _selectionAge,
      storageRetentionMaxAgeMs: _retentionAge,
      crossThreadSend: _crossThreadSend,
      ...native
    }) => ({
      ...defaultNativeSurfaceConfig(),
      ...native,
    }),
  )
  .superRefine(validateNativeSurfaceConfig);
const surfaceSchemaV3 = baseSurface
  .extend({
    native: nativeSchemaV3
      .prefault({})
      .describe(
        "Native web/TUI gateway and authentication. Set a unique installationId before enabling. Runtime deployment settings are managed through Settings > Deployment.",
      ),
  })
  .prefault({});

export const coreConfigInputSchemaV3 = coreConfigInputSchemaV2.extend({
  models: modelsSchemaV3.describe(
    "Model slots, reusable aliases, capability overrides, catalog visibility, and ordered option rules. Local Claude subscription models use `claude-code/<model>`; see docs/claude-code.md for authentication, persistent storage, and continuation limits.",
  ),
  tools: toolsSchemaV3.describe(
    "File, web, media, and tool-result settings. Omitted options use the defaults shown on their fields.",
  ),
  conversation: conversationSchemaV3.describe(
    "Experimental conversation memory: thread summaries, embeddings, and automatic recall. Background summarization, embedding, and injection are disabled by default. Behavior and storage may change.",
  ),
  surface: surfaceSchemaV3.describe(
    "Communication surfaces, request routing, and autonomous heartbeat settings.",
  ),
  configVersion: z
    .literal(V3_CORE_CONFIG_VERSION)
    .default(V3_CORE_CONFIG_VERSION)
    .describe(
      "Configuration format version. New files use 3. An omitted version is parsed as version 1; set this explicitly before using newer fields. See docs/core-config-migrations.md for upgrades.",
    ),
  agent: z
    .object({
      ...agentFieldsWithoutSubagents,
      subagents: subagentsSchemaV3
        .default(SUBAGENTS_DEFAULT_V3)
        .describe(
          "Delegated child-agent execution and permissions. Child idle timeout derives from agent.idleTimeoutMs.",
        ),
    })
    .default({ ...agentDefaultWithoutSubagents, subagents: SUBAGENTS_DEFAULT_V3 })
    .describe("Agent execution, retry, transcript retention, display, and delegation settings."),
});

export type ParsedCoreConfigV3 = z.infer<typeof coreConfigInputSchemaV3>;

export class CoreConfigV3Invalid extends TaggedError("CoreConfigV3Invalid")<{
  readonly cause: z.ZodError;
  readonly message: string;
}> {}

export function decodeCoreConfigV3(
  raw: unknown,
): ResultType<ParsedCoreConfigV3, CoreConfigV3Invalid> {
  const parsed = coreConfigInputSchemaV3.safeParse(raw);
  return parsed.success
    ? Result.ok(parsed.data)
    : Result.err(
        new CoreConfigV3Invalid({
          cause: parsed.error,
          message: parsed.error.issues.map((issue) => issue.message).join("; "),
        }),
      );
}

export function parseCoreConfigV3(raw: unknown): ParsedCoreConfigV3 {
  return coreConfigInputSchemaV3.parse(raw);
}

function subagentsV3ToUniversal(
  subagents: ParsedCoreConfigV3["agent"]["subagents"],
): UniversalCoreConfig["agent"]["subagents"] {
  const { profiles: _removed, permissions, ...rest } = subagents;
  const normalized = Object.fromEntries(
    Object.entries(permissions).map(([name, profile]) => [
      name,
      normalizeProfileToolNames(profile),
    ]),
  );
  return {
    ...rest,
    defaultPermissions: "full",
    permissions: {
      ...normalized,
      full: normalizeProfileToolNames(permissions.full),
      restricted: normalizeProfileToolNames(permissions.restricted),
    },
  };
}

export function decodeCoreConfigV3ToUniversal(
  raw: unknown,
  options?: CoreConfigParseOptions,
): ResultType<UniversalCoreConfig, CoreConfigV3Invalid> {
  return decodeCoreConfigV3(raw).map((parsed) =>
    coreConfigV2ShapeToUniversal(parsed, raw, options, subagentsV3ToUniversal),
  );
}

export function parseCoreConfigV3ToUniversal(
  raw: unknown,
  options?: CoreConfigParseOptions,
): UniversalCoreConfig {
  const result = decodeCoreConfigV3ToUniversal(raw, options);
  const resolved = result.match<
    { readonly value: UniversalCoreConfig } | { readonly error: CoreConfigV3Invalid }
  >({
    ok: (value) => ({ value }),
    err: (error) => ({ error }),
  });
  if ("error" in resolved) throw resolved.error.cause;
  return resolved.value;
}

export class V3CoreConfigParser implements ConfigParser {
  readonly version = V3_CORE_CONFIG_VERSION;

  async parse(input: object, options?: CoreConfigParseOptions): Promise<UniversalCoreConfig> {
    return parseCoreConfigV3ToUniversal(input, options);
  }
}
