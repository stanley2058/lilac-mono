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
    promptOverlay: z.string().trim().min(1).optional(),
    level1: profileLevel1Schema.default(defaults.level1),
    level2: profileLevel2Schema.default(defaults.level2),
    network: z.boolean().default(defaults.network),
    workspaceWrites: z.boolean().default(defaults.workspaceWrites),
    execution: z
      .union([z.literal(false), z.enum(["restricted", "native"])])
      .default(defaults.execution),
    delegation: z.boolean().default(defaults.delegation),
  });
}

const permissionProfilesSchemaV3 = z
  .object({
    full: permissionProfileSchemaV3(FULL_PERMISSIONS_DEFAULT).default(FULL_PERMISSIONS_DEFAULT),
    restricted: permissionProfileSchemaV3(RESTRICTED_PERMISSIONS_DEFAULT).default(
      RESTRICTED_PERMISSIONS_DEFAULT,
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
  enabled: z.boolean().default(true),
  maxDepth: z.number().int().min(0).max(2).default(2),
  delegatePromptOverlay: z.string().trim().min(1).optional(),
  permissions: permissionProfilesSchemaV3.default({
    full: FULL_PERMISSIONS_DEFAULT,
    restricted: RESTRICTED_PERMISSIONS_DEFAULT,
  }),
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
      match: z.string().min(1).max(512),
      options: baseModels.shape.main.unwrap().shape.options,
      reasoning: z.enum(MODEL_REASONING_EFFORTS).optional(),
      unset: z
        .array(
          z
            .string()
            .regex(
              /^(?!.*(?:__proto__|constructor|prototype))[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/,
            ),
        )
        .optional(),
      legacy: z.boolean().optional(),
    }),
  )
  .default([]);
const reasoningFieldsV3 = {
  reasoning: z.enum(MODEL_REASONING_EFFORTS).optional(),
  fallback: z
    .array(
      z.union([
        z.string().min(1),
        z.object({
          model: z.string().min(1),
          reasoning: z.enum(MODEL_REASONING_EFFORTS).optional(),
          options: baseModels.shape.main.unwrap().shape.options,
        }),
      ]),
    )
    .optional(),
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
          model: z.string().regex(/^[^/]+\/.+/u),
        }),
      )
      .default({}),
    main: baseModels.shape.main
      .unwrap()
      .extend(reasoningFieldsV3)
      .default({ model: "openrouter/openai/gpt-4o" }),
    fast: baseModels.shape.fast
      .unwrap()
      .extend(reasoningFieldsV3)
      .default({ model: "openrouter/openai/gpt-4o-mini" }),
    catalog: z
      .object({
        providers: z.record(z.string(), z.enum(["auto", "enabled", "disabled"])).default({}),
      })
      .default({ providers: {} }),
    rules: modelRulesSchema,
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
    .default({ providers: ["tavily"] }),
});
const toolsSchemaV3 = baseTools
  .extend({
    inspect: removedV3Field("tools.inspect", "content.inspect is no longer available"),
    web: webSchemaV3.prefault({}),
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
          .default("llm"),
        jevAutoInject: removedV3Field(
          "conversation.thread.jevAutoInject",
          "use decisionAutoInject",
        ),
        decisionAutoInject: decisionSchemaV3.optional(),
      })
      .transform((value): z.output<typeof baseThread.in> => value)
      .pipe(baseThread.out)
      .prefault({}),
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
const surfaceSchemaV3 = baseSurface.extend({ native: nativeSchemaV3.prefault({}) }).prefault({});

export const coreConfigInputSchemaV3 = coreConfigInputSchemaV2.extend({
  models: modelsSchemaV3,
  tools: toolsSchemaV3,
  conversation: conversationSchemaV3,
  surface: surfaceSchemaV3,
  configVersion: z.literal(V3_CORE_CONFIG_VERSION).default(V3_CORE_CONFIG_VERSION),
  agent: z
    .object({
      ...agentFieldsWithoutSubagents,
      subagents: subagentsSchemaV3.default(SUBAGENTS_DEFAULT_V3),
    })
    .default({ ...agentDefaultWithoutSubagents, subagents: SUBAGENTS_DEFAULT_V3 }),
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
