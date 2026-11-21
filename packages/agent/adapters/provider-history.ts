import type { LanguageModel, ModelMessage, ToolResultPart } from "ai";

type ProviderOptions = NonNullable<ModelMessage["providerOptions"]>;
type ProviderNamespace = ProviderOptions[string];
type ToolOutput = ToolResultPart["output"];
type ToolContentItem = Extract<ToolOutput, { type: "content" }>["value"][number];

export type ProviderHistoryFamily = "anthropic" | "openai" | "google" | "other";

/**
 * Admits declared keys of one namespace. `"all"` is reserved for namespaces owned by a provider
 * without a declared profile: a transport's own namespace and the `openaiCompatible` namespace
 * that the shared OpenAI-compatible converter spreads into its requests.
 */
export type ProviderNamespaceRule =
  | "all"
  | ReadonlySet<string>
  | ((key: string, namespace: Readonly<ProviderNamespace>) => boolean);

/**
 * What one outbound request accepts from stored history. Portable content always passes;
 * provider metadata passes only through a declared namespace key and custom content only
 * through a declared kind.
 */
export type ProviderHistoryProfile<F extends ProviderHistoryFamily = ProviderHistoryFamily> = {
  readonly family: F;
  readonly namespaces: Readonly<Record<string, ProviderNamespaceRule>>;
  readonly customKinds: readonly string[];
};

// Lilac's own markers are read from the model view at turn boundaries and are ignored by providers.
const LILAC_NAMESPACE = "lilac";

// Keys read by @ai-sdk/anthropic when converting history.
const ANTHROPIC_KEYS: ReadonlySet<string> = new Set([
  "cacheControl",
  "cache_control",
  "signature",
  "redactedData",
  "citations",
  "title",
  "context",
  "containerUpload",
  "clearAt",
  "effort",
  "toolChanges",
  "type",
  "toolName",
  "serverName",
  "toolsetName",
  "caller",
  "from",
  "to",
]);
const ANTHROPIC_CACHE_KEYS: ReadonlySet<string> = new Set(["cacheControl", "cache_control"]);
const ANTHROPIC_REPLAY_KINDS = [
  "anthropic.message_start",
  "anthropic.fallback",
  "anthropic.tool-reference",
];

// Keys read by the Lilac Responses encoder and @ai-sdk/openai when converting history.
const OPENAI_KEYS: ReadonlySet<string> = new Set([
  "itemId",
  "phase",
  "reasoningEncryptedContent",
  "encryptedContent",
  "type",
  "imageDetail",
  "promptCacheBreakpoint",
  "namespace",
  "async",
  "caller",
  "reasoningEffortUpdate",
  "parallelToolCall",
  "approvalId",
]);
const OPENAI_TOOL_SEARCH_KEYS: ReadonlySet<string> = new Set([
  "toolSearchSeed",
  "toolSearchTools",
  "toolSearchCall",
]);

// Keys read by @ai-sdk/google, which accepts both Google and Vertex namespaces.
const GOOGLE_KEYS: ReadonlySet<string> = new Set([
  "thoughtSignature",
  "thought",
  "serverToolCallId",
  "serverToolType",
]);

const projected: unique symbol = Symbol("projected provider history");

/**
 * Request-time view of history for one provider family. Encoders accept this type so raw history
 * cannot skip the projection; the brand is module-private, so only `projectMessagesFor` creates it.
 */
export type ProviderMessages<F extends ProviderHistoryFamily = ProviderHistoryFamily> = {
  readonly [projected]: F;
  readonly messages: readonly ModelMessage[];
};

export function projectMessagesFor<F extends ProviderHistoryFamily>(
  profile: ProviderHistoryProfile<F>,
  messages: readonly ModelMessage[],
): ProviderMessages<F> {
  return {
    [projected]: profile.family,
    messages: messages.flatMap((message) => projectMessage(profile, message)),
  };
}

export function anthropicHistoryProfile(
  input: { readonly routed?: boolean; readonly transport?: string } = {},
): ProviderHistoryProfile<"anthropic"> {
  return {
    family: "anthropic",
    namespaces: withTransport({ anthropic: ANTHROPIC_KEYS }, input.transport),
    // Routers serialize the prompt for their own backend; replay blocks are direct-API only.
    customKinds: input.routed ? [] : ANTHROPIC_REPLAY_KINDS,
  };
}

export function openAIHistoryProfile(
  input: {
    readonly nativeToolSearch?: boolean;
    readonly routed?: boolean;
    readonly transport?: string;
  } = {},
): ProviderHistoryProfile<"openai"> {
  const openai: ProviderNamespaceRule = input.nativeToolSearch
    ? (key) => OPENAI_KEYS.has(key) || OPENAI_TOOL_SEARCH_KEYS.has(key)
    : (key, namespace) =>
        OPENAI_KEYS.has(key) &&
        // A tool-search item id is invalid on the function call that replaces it.
        !(key === "itemId" && namespace.toolSearchCall === true);
  return {
    family: "openai",
    namespaces: withTransport({ openai }, input.transport),
    customKinds: input.routed ? [] : ["openai.compaction"],
  };
}

export function googleHistoryProfile(
  input: { readonly transport?: string } = {},
): ProviderHistoryProfile<"google"> {
  return {
    family: "google",
    namespaces: withTransport(
      { google: GOOGLE_KEYS, googleVertex: GOOGLE_KEYS, vertex: GOOGLE_KEYS },
      input.transport,
    ),
    customKinds: [],
  };
}

function otherHistoryProfile(transport: string): ProviderHistoryProfile<"other"> {
  return {
    family: "other",
    // @ai-sdk/openai-compatible reads `openaiCompatible` whatever the provider id is.
    namespaces: withTransport(isRouter(transport) ? {} : { openaiCompatible: "all" }, transport),
    customKinds: [],
  };
}

function isRouter(transport: string): boolean {
  return transport === "gateway" || transport === "openrouter";
}

function withTransport(
  namespaces: Record<string, ProviderNamespaceRule>,
  transport: string | undefined,
): Record<string, ProviderNamespaceRule> {
  if (!transport || Object.hasOwn(namespaces, transport)) return namespaces;
  // OpenRouter reads Anthropic cache breakpoints for every routed model, including aliases.
  const cache: Record<string, ProviderNamespaceRule> =
    transport === "openrouter" && !Object.hasOwn(namespaces, "anthropic")
      ? { anthropic: ANTHROPIC_CACHE_KEYS }
      : {};
  return { ...namespaces, ...cache, [transport]: "all" };
}

// Only routers name the upstream vendor in the model id.
function routedVendor(transport: string, modelId: string): string | undefined {
  if (!isRouter(transport)) return undefined;
  const slash = modelId.indexOf("/");
  return slash > 0 ? modelId.slice(0, slash) : undefined;
}

/**
 * Resolves the profile for an AI SDK model. Direct providers are identified by their provider id.
 * Routers (Vercel Gateway, OpenRouter) name the upstream vendor in the model id, which covers
 * Anthropic served through Vertex or Bedrock upstreams.
 */
export function resolveAiSdkHistoryProfile(model: LanguageModel): ProviderHistoryProfile {
  // A bare model id resolves through the AI SDK default provider, Vercel Gateway.
  const provider = typeof model === "string" ? "gateway" : model.provider;
  const modelId = typeof model === "string" ? model : model.modelId;
  const transport = provider.split(".")[0] ?? provider;
  if (/^(?:[\w-]+\.)?anthropic\./.test(provider)) return anthropicHistoryProfile({ transport });
  if (/^(?:openai|codex|azure)\./.test(provider)) return openAIHistoryProfile({ transport });
  if (/^(?:google|vertex)\./.test(provider)) return googleHistoryProfile({ transport });
  switch (routedVendor(transport, modelId)) {
    case "anthropic":
      return anthropicHistoryProfile({ routed: true, transport });
    case "openai":
      return openAIHistoryProfile({ routed: true, transport });
    case "google":
      return googleHistoryProfile({ transport });
    default:
      return otherHistoryProfile(transport);
  }
}

function acceptsKind(profile: ProviderHistoryProfile, kind: string): boolean {
  return profile.customKinds.includes(kind);
}

function projectNamespace(
  rule: ProviderNamespaceRule,
  namespace: ProviderNamespace,
): ProviderNamespace {
  if (rule === "all") return namespace;
  const accepts = typeof rule === "function" ? rule : (key: string) => rule.has(key);
  return Object.fromEntries(Object.entries(namespace).filter(([key]) => accepts(key, namespace)));
}

function projectOptions(
  profile: ProviderHistoryProfile,
  options: ModelMessage["providerOptions"],
): ModelMessage["providerOptions"] {
  if (!options) return undefined;
  const entries: [string, ProviderNamespace][] = [];
  for (const [name, namespace] of Object.entries(options)) {
    if (name === LILAC_NAMESPACE) {
      entries.push([name, namespace]);
      continue;
    }
    if (!Object.hasOwn(profile.namespaces, name)) continue;
    const rule = profile.namespaces[name];
    const kept = rule === undefined ? {} : projectNamespace(rule, namespace);
    // A namespace emptied by the projection no longer carries replay metadata.
    if (Object.keys(kept).length > 0 || rule === "all") entries.push([name, kept]);
  }
  return entries.length === 0 ? undefined : Object.fromEntries(entries);
}

function hasProviderMetadata(options: ModelMessage["providerOptions"]): boolean {
  return Object.keys(options ?? {}).some((name) => name !== LILAC_NAMESPACE);
}

function withOptions<T extends { providerOptions?: ModelMessage["providerOptions"] }>(
  profile: ProviderHistoryProfile,
  value: T,
): T {
  if (value.providerOptions === undefined) return value;
  return { ...value, providerOptions: projectOptions(profile, value.providerOptions) };
}

// Tool-output custom items carry no kind; their namespace's `type` names the content.
function acceptsToolContentItem(profile: ProviderHistoryProfile, item: ToolContentItem): boolean {
  if (item.type !== "custom") return true;
  return Object.entries(item.providerOptions ?? {}).some(
    ([name, namespace]) =>
      typeof namespace.type === "string" && acceptsKind(profile, `${name}.${namespace.type}`),
  );
}

function projectToolOutput(profile: ProviderHistoryProfile, output: ToolOutput): ToolOutput {
  if (output.type !== "content") return withOptions(profile, output);
  return {
    ...output,
    value: output.value
      .filter((item) => acceptsToolContentItem(profile, item))
      .map((item) => withOptions(profile, item)),
  };
}

function projectToolResult(profile: ProviderHistoryProfile, part: ToolResultPart): ToolResultPart {
  return { ...withOptions(profile, part), output: projectToolOutput(profile, part.output) };
}

type AssistantMessage = Extract<ModelMessage, { role: "assistant" }>;
type AssistantPart = Exclude<AssistantMessage["content"], string>[number];
type ToolPart = Extract<ModelMessage, { role: "tool" }>["content"][number];

function projectAssistantPart(profile: ProviderHistoryProfile, part: AssistantPart): AssistantPart {
  switch (part.type) {
    case "tool-result":
      return projectToolResult(profile, part);
    case "tool-approval-request":
      return part;
    default:
      return withOptions(profile, part);
  }
}

function projectToolPart(profile: ProviderHistoryProfile, part: ToolPart): ToolPart {
  return part.type === "tool-result" ? projectToolResult(profile, part) : part;
}

function projectAssistant(
  profile: ProviderHistoryProfile,
  message: AssistantMessage,
): AssistantMessage[] {
  const projected = withOptions(profile, message);
  if (typeof message.content === "string") return [{ ...projected, content: message.content }];
  const content = message.content
    .filter((part) => part.type !== "custom" || acceptsKind(profile, part.kind))
    .map((part) => projectAssistantPart(profile, part));
  // An empty assistant turn is invalid for most providers, unless message-level metadata still
  // carries a replay item such as an OpenAI tool seed.
  if (content.length === 0 && !hasProviderMetadata(projected.providerOptions)) return [];
  return [{ ...projected, content }];
}

function projectMessage(profile: ProviderHistoryProfile, message: ModelMessage): ModelMessage[] {
  switch (message.role) {
    case "system":
      return [withOptions(profile, message)];
    case "assistant":
      return projectAssistant(profile, message);
    case "tool":
      return [
        {
          ...withOptions(profile, message),
          content: message.content.map((part) => projectToolPart(profile, part)),
        },
      ];
    case "user":
      return [
        {
          ...withOptions(profile, message),
          content:
            typeof message.content === "string"
              ? message.content
              : message.content.map((part) => withOptions(profile, part)),
        },
      ];
  }
}
