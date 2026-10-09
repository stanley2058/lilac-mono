export type JSONValue = null | string | number | boolean | Readonly<JSONObject> | JSONArray;
export type JSONArray = readonly JSONValue[];
export type JSONObject = {
  [key: string]: JSONValue | undefined;
};

export type CoreConfigVersion = 1 | 2;

export type CoreConfigKeyPath = readonly (string | number)[];

export type CoreConfigModelOptionWarning = {
  namespace: string;
  option: string;
  suggestion?: string;
};

export type CoreConfigParseOptions = {
  onUnknownKey?: (path: CoreConfigKeyPath) => void;
  onUnknownModelOption?: (warning: CoreConfigModelOptionWarning, source: string) => void;
};

export type RetentionLimit =
  | { readonly kind: "bounded"; readonly value: number }
  | { readonly kind: "unlimited" };

export const DEFAULT_TRANSCRIPT_RETENTION_MAX_AGE_MS = 180 * 24 * 60 * 60 * 1000;
export const DEFAULT_TRANSCRIPT_RETENTION_MAX_REQUESTS = 10_000;
export const DEFAULT_DISCORD_ATTACHMENT_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export type DecisionAutoInjectProbabilities = {
  recallMinProbability: number;
  durableSubjectMinProbability: number;
  casualMaxProbability: number;
  relevanceMinProbability: number;
};

export type DiscordUserAliasConfig = {
  discord: string;
  comment?: string;
};

export type DiscordSessionAliasConfig =
  | string
  | {
      discord: string;
      comment?: string;
    };

export type ConfiguredModelRef = {
  /** Model ref in provider/model format or alias from models.def. */
  model: string;
  /** Optional portable AI SDK reasoning effort. */
  reasoning?: ModelReasoningEffort;
  /** Optional providerOptions override. */
  options?: JSONObject;
};

export type ConfiguredModelChainEntry = string | ConfiguredModelRef;

export type SubagentExecution = false | "restricted" | "native";

export type SubagentProfileConfig = {
  modelSlot: "main" | "fast";
  model?: string;
  reasoning?: ModelReasoningEffort;
  options?: JSONObject;
  fallback?: ConfiguredModelChainEntry[];
  promptOverlay?: string;
  level1: {
    tools: string[];
    plugins: string[];
  };
  level2: {
    callables: string[];
    plugins: string[];
  };
  /** Network behavior/tool-surface setting; not a trusted-Bash network boundary. */
  network: boolean;
  /** Write behavior/edit-tool setting; not a trusted-Bash filesystem boundary. */
  workspaceWrites: boolean;
  execution: SubagentExecution;
  delegation: boolean;
};

export const MODEL_REASONING_EFFORTS = [
  "provider-default",
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
] as const;

export type ModelReasoningEffort = (typeof MODEL_REASONING_EFFORTS)[number];

export type ModelCapabilityOverride = {
  inherit?: string;
  cost?: {
    input?: number;
    output?: number;
    cache_read?: number;
    cache_write?: number;
    input_audio?: number;
    output_audio?: number;
    context_over_200k?: {
      input: number;
      output: number;
      cache_read?: number;
      cache_write?: number;
    };
  };
  limit?: {
    context?: number;
    output?: number;
  };
  attachment?: boolean;
  modalities?: {
    input?: Array<"text" | "image" | "audio" | "video" | "pdf">;
    output?: Array<"text" | "image" | "audio" | "video" | "pdf">;
  };
};

export type BlobStorageConfig =
  | {
      kind: "local";
      root?: string;
    }
  | {
      kind: "s3";
      bucket: string;
      prefix: string;
      endpoint: string;
      region: string;
      accessKeyIdEnv: string;
      secretAccessKeyEnv: string;
      sessionTokenEnv?: string;
      forcePathStyle: boolean;
    };

export type NativeSurfaceConfig = {
  enabled: boolean;
  host: string;
  port: number;
  publicUrl: string;
  installationId?: string;
  allowedOrigins: string[];
  auth: {
    provider: "local" | "clerk";
    ownerId: string;
    ownerProviderUserId?: string;
    clerkIssuer?: string;
    clerkOAuthClientId?: string;
  };
  titleModel: string;
  outputStreaming: "paragraph" | "complete";
  oldMessageSelectionMaxAgeMs: number | null;
  storageRetentionMaxAgeMs: number | null;
  crossThreadSend: { triggerRun: boolean };
};

export function defaultNativeSurfaceConfig(): NativeSurfaceConfig {
  return {
    enabled: false,
    host: "127.0.0.1",
    port: 8789,
    publicUrl: "http://localhost:8789",
    allowedOrigins: ["http://localhost:8789"],
    auth: { provider: "local", ownerId: "owner" },
    titleModel: "fast",
    outputStreaming: "paragraph",
    oldMessageSelectionMaxAgeMs: null,
    storageRetentionMaxAgeMs: null,
    crossThreadSend: { triggerRun: true },
  };
}

export type UniversalCoreConfig = {
  configVersion: CoreConfigVersion;

  blobStorage: BlobStorageConfig;

  tools: {
    fsBackend: "fff" | "node-rg";
    web: {
      extract: {
        providers: Array<"tavily" | "exa" | "firecrawl">;
      };
      fetch: {
        mode: "auto" | "fetch" | "browser" | "extract" | "provider-only";
      };
      firecrawl?: {
        maxConcurrency: number;
        queueTtlMs: number;
      };
    };
    inspect: {
      model: string;
    };
    editFile: {
      hashline: boolean;
    };
    output: {
      maxPreviewBytes: number;
      artifactTtlMs: number;
      artifactMaxBytesPerSession: number;
    };
    historicalResultPruning: {
      enabled: boolean;
      protectTokens: number;
      minimumTokens: number;
    };
    batch: {
      maxCalls: number;
    };
    media: {
      maxInlineBytesPerPart: number;
      maxInlineBytesTotal: number;
    };
  };

  plugins: {
    disabled: string[];
    config: Record<string, unknown>;
  };

  conversation: {
    thread: {
      summarization: {
        enabled: boolean;
        model: string;
        concurrency: number;
        batchSize: number;
        includePromptContext: boolean;
      };
      embedding: {
        enabled: boolean;
        model: string;
        queryModel?: string;
      };
      autoInject: {
        enabled: boolean;
        plannerModel?: string;
        textPlannerModel?: string;
        minTextUnits: number;
        followUpMinTextUnits: number;
        limit: number;
        minScore: number;
        expansionMinConfidence: number;
        mode: "hybrid" | "semantic" | "lexical";
        filterCurrentParticipants: boolean;
      };
      autoInjectMode: "llm" | "decision";
      decisionAutoInject: {
        model: string[];
        limit: number;
        candidateLimit: number;
        semanticFallback: boolean;
        jev: DecisionAutoInjectProbabilities;
        luna: DecisionAutoInjectProbabilities;
      };
    };
  };

  workflows: {
    maxActiveRuns: number;
  };

  surface: {
    native: NativeSurfaceConfig;
    router: {
      defaultMode: "mention" | "active";
      sessionModes: Record<
        string,
        {
          mode?: "mention" | "active";
          gate?: boolean;
          model?: string;
          safetyMode?: "trusted" | "restricted";
          additionalPrompts?: string[];
        }
      >;
      activeDebounceMs: number;
      activeGate: {
        enabled: boolean;
        timeoutMs: number;
      };
    };

    discord: {
      tokenEnv: string;
      allowedChannelIds: string[];
      allowedGuildIds: string[];
      dbPath?: string;
      botName: string;
      statusMessage?: string;
      memberPresence?: boolean;
      outputMode: "inline" | "preview";
      outputPreviewModeFinalStyle: "embed" | "plain";
      outputPreviewModeFinalText: "flat" | "reply-chain";
      outputNotification?: boolean;
      workingIndicators: string[];
      attachmentCache: {
        ttlMs: RetentionLimit;
      };
      markdownTableRender: {
        enabled: boolean;
        style: "unicode" | "ascii" | "image";
        maxWidth: number;
        fallbackMode: "list" | "passthrough";
      };
      markdownMathRender: {
        enabled: boolean;
        maxWidth: number;
        fallbackMode: "source" | "passthrough";
      };
    };

    heartbeat: {
      enabled: boolean;
      cron: string;
      quietAfterActivityMs: number;
      retryBusyMs: number;
      defaultOutputSession?: string;
      softQuietHours?: {
        start: string;
        end: string;
        timezone?: string;
      };
    };
  };

  agent: {
    systemPrompt: string;
    workerSystemPrompt: string;
    statsForNerds: boolean | { verbose: boolean };
    reasoningDisplay: "none" | "simple" | "detailed";
    idleTimeoutMs: number;
    transcriptRetention: {
      maxAgeMs: RetentionLimit;
      maxRequests: RetentionLimit;
    };
    retry: {
      enabled: boolean;
      maxRetries: number;
      baseDelayMs: number;
      maxDelayMs: number;
    };
    subagents: {
      enabled: boolean;
      maxDepth: number;
      delegatePromptOverlay?: string;
      profiles: {
        explore: SubagentProfileConfig;
        general: SubagentProfileConfig;
        self: SubagentProfileConfig;
      };
    };
  };

  models: {
    def: Record<
      string,
      {
        model: string;
        reasoning?: ModelReasoningEffort;
        options?: JSONObject;
        fallback?: ConfiguredModelChainEntry[];
        comment?: string;
        agentCanSelect?: boolean;
      }
    >;
    main: {
      model: string;
      reasoning?: ModelReasoningEffort;
      options?: JSONObject;
      fallback?: ConfiguredModelChainEntry[];
    };
    fast: {
      model: string;
      reasoning?: ModelReasoningEffort;
      options?: JSONObject;
      fallback?: ConfiguredModelChainEntry[];
    };
    capability: {
      forceUnknownProviders: string[];
      overrides: Record<string, ModelCapabilityOverride>;
    };
  };

  entity?: {
    users: Record<string, DiscordUserAliasConfig>;
    sessions: {
      discord: Record<string, DiscordSessionAliasConfig>;
    };
  };

  basePrompt?: string;
};

export type CoreConfig = UniversalCoreConfig;

export type RouterSessionConfig = CoreConfig["surface"]["router"]["sessionModes"][string];

export type RouterSessionConfigScope = {
  sessionId: string;
  parentChannelId?: string | null;
  guildId?: string | null;
};

export interface ConfigParser {
  readonly version: CoreConfigVersion;
  parse(input: object, options?: CoreConfigParseOptions): Promise<UniversalCoreConfig>;
}
