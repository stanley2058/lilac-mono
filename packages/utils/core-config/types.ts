export type JSONValue = null | string | number | boolean | JSONObject | JSONArray;
export type JSONArray = JSONValue[];
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

export type SubagentProfileConfig = {
  modelSlot: "main" | "fast";
  model?: string;
  reasoning?: ModelReasoningEffort;
  options?: JSONObject;
  promptOverlay?: string;
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

export type UniversalCoreConfig = {
  configVersion: CoreConfigVersion;

  tools: {
    fsBackend: "fff" | "node-rg";
    web: {
      extract: {
        providers: Array<"tavily" | "exa" | "firecrawl">;
      };
      fetch: {
        mode: "auto" | "fetch" | "browser" | "extract" | "provider-only";
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
        includePromptContext: boolean;
      };
      embedding: {
        enabled: boolean;
        model: string;
      };
      autoInject: {
        enabled: boolean;
        plannerModel?: string;
        minTextUnits: number;
        followUpMinTextUnits: number;
        limit: number;
        minScore: number;
        mode: "hybrid" | "semantic" | "lexical";
        filterCurrentParticipants: boolean;
      };
    };
  };

  surface: {
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
      outputNotification?: boolean;
      workingIndicators: string[];
      markdownTableRender: {
        enabled: boolean;
        style: "unicode" | "ascii";
        maxWidth: number;
        fallbackMode: "list" | "passthrough";
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
    statsForNerds: boolean | { verbose: boolean };
    reasoningDisplay: "none" | "simple" | "detailed";
    idleTimeoutMs: number;
    retry: {
      enabled: boolean;
      maxRetries: number;
      baseDelayMs: number;
      maxDelayMs: number;
    };
    subagents: {
      enabled: boolean;
      maxDepth: number;
      idleTimeoutMs: number;
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
        comment?: string;
        agentCanSelect?: boolean;
      }
    >;
    main: {
      model: string;
      reasoning?: ModelReasoningEffort;
      options?: JSONObject;
    };
    fast: {
      model: string;
      reasoning?: ModelReasoningEffort;
      options?: JSONObject;
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

export interface ConfigParser {
  readonly version: CoreConfigVersion;
  parse(input: object, options?: CoreConfigParseOptions): Promise<UniversalCoreConfig>;
}
