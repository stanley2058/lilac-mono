export type JSONValue = null | string | number | boolean | JSONObject | JSONArray;
export type JSONArray = JSONValue[];
export type JSONObject = {
  [key: string]: JSONValue | undefined;
};

export type CoreConfigVersion = 1 | 2;

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
  options?: JSONObject;
  promptOverlay?: string;
};

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
  modalities?: {
    input?: Array<"text" | "image" | "audio" | "video" | "pdf">;
    output?: Array<"text" | "image" | "audio" | "video" | "pdf">;
  };
};

export type UniversalCoreConfig = {
  configVersion: CoreConfigVersion;

  tools: {
    web: {
      extract: {
        providers: Array<"tavily" | "exa" | "firecrawl">;
      };
      fetch: {
        mode: "auto" | "fetch" | "browser" | "extract" | "provider-only";
      };
    };
    editFile: {
      hashline: boolean;
    };
  };

  plugins: {
    disabled: string[];
    config: Record<string, unknown>;
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
    subagents: {
      enabled: boolean;
      maxDepth: number;
      defaultTimeoutMs: number;
      maxTimeoutMs: number;
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
        options?: JSONObject;
      }
    >;
    main: {
      model: string;
      options?: JSONObject;
    };
    fast: {
      model: string;
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
  parse(input: object): Promise<UniversalCoreConfig>;
}
