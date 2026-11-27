import type { CoreConfigFieldPattern as P } from "../../../core/src/generated/config-schemas/config-fields";
import { collection, type FieldEntry, type Manifest, type TypedCollection } from "./manifest";

const items = <C extends P>(spec: TypedCollection<P, C>) => collection<P, C>(spec);

const REASONING = {
  '"provider-default"': "Provider default",
  '"none"': "None",
  '"minimal"': "Minimal",
  '"low"': "Low",
  '"medium"': "Medium",
  '"high"': "High",
  '"xhigh"': "Extra high",
  '"max"': "Max",
};

const SLOT_MODEL_HELP =
  "Model used for this slot. Enter a `provider/model` ID or an alias defined below.";
const REASONING_HELP =
  "Reasoning effort sent to the model. Provider default lets the provider choose; supported levels depend on the model.";
const FALLBACK_HELP =
  "Ordered backup models tried if the primary model fails. Automatic fallback stays within the first model's provider family and is disabled for `claude-code`. A slot's chain overrides its alias chain.\n\nSelect a model in the list to give it its own reasoning or provider options.";
const OPTIONS_HELP =
  "YAML map of provider settings merged over inherited options, such as `temperature` or nested keys like `openai` and `openaiCompatible`.\n\nCommon Lilac options: `anthropic_prompt_cache` (`auto`, `false`, or `legacy`), `openai_server_compaction`, and `response_commentary`.";
const DECISION_MODELS_HELP =
  "Decision models for gating. Text uses the first entry, and images use the first OpenAI entry when present; entries do not act as retries.\n\nTypeSafe reads `TYPESAFE_AI_API_KEY` and `TYPESAFE_AI_BASE_URL`; OpenAI reads `OPENAI_API_KEY` and `OPENAI_BASE_URL`.";

function slot(prefix: "models.main" | "models.fast"): FieldEntry<P>[] {
  return [
    { path: `${prefix}.model`, label: "Model", help: SLOT_MODEL_HELP },
    {
      path: `${prefix}.reasoning`,
      label: "Reasoning",
      help: REASONING_HELP,
      options: REASONING,
    },
    {
      path: `${prefix}.fallback`,
      label: "Fallbacks",
      help: FALLBACK_HELP,
      widget: "modelList",
      // Labels for the reasoning of individual fallback entries.
      options: REASONING,
    },
    {
      path: `${prefix}.options`,
      label: "Provider options",
      help: OPTIONS_HELP,
      widget: "yaml",
    },
  ];
}

const KNOWN_TOOLS = [
  "*",
  "bash",
  "read",
  "glob",
  "grep",
  "fuzzy_search",
  "edit_file",
  "write_file",
];
const KNOWN_CALLABLES = [
  "*",
  "fetch",
  "search",
  "skills.list",
  "skills.read",
  "discovery.search",
  "conversation.thread.search",
  "surface.help",
  "surface.messages.list",
  "surface.messages.read",
];

const IS_PREVIEW = { path: "surface.discord.outputMode", equals: "preview" } as const;
const TABLES_ON = { path: "surface.discord.markdownTableRender.enabled", equals: true } as const;
const MATH_ON = { path: "surface.discord.markdownMathRender.enabled", equals: true } as const;
const CLERK = { path: "surface.native.auth.provider", equals: "clerk" } as const;
const S3 = { path: "blobStorage.kind", equals: "s3" } as const;
const DECISION = { path: "conversation.thread.autoInjectMode", equals: "decision" } as const;

export const coreManifest: Manifest<P> = {
  kind: "core",
  unplaced: {
    configVersion: "Shown as a notice; form pages edit the current version only.",
    "models.def.*.agentCanSelect": "Ignored in version 3.",
    "tools.batch.maxCalls": "Ignored; the batch tool is retired.",
  },
  pages: [
    {
      id: "models",
      title: "Models",
      sections: [
        { title: "Main model", entries: slot("models.main") },
        {
          title: "Fast model",
          help: "Handles lightweight tasks such as summaries and routing checks.",
          entries: slot("models.fast"),
        },
        {
          title: "Aliases",
          entries: [
            items({
              collection: "models.def",
              label: "Aliases",
              help: "Named model presets that slots and agents can reference.",
              itemNoun: "alias",
              keyLabel: "Alias",
              keyPlaceholder: "writer",
              newItem: { model: "" },
              summary: ["model"],
              fields: [
                {
                  path: "model",
                  label: "Model",
                  help: "Target model in `provider/model` format. Aliases cannot point to other aliases.",
                },
                {
                  path: "reasoning",
                  label: "Reasoning",
                  help: REASONING_HELP,
                  options: REASONING,
                },
                {
                  path: "comment",
                  label: "Note for agents",
                  help: "Shown to agents when picking a model. Note the tasks it fits or its speed and cost tradeoffs.",
                },
                {
                  path: "fallback",
                  label: "Fallbacks",
                  help: FALLBACK_HELP,
                  widget: "modelList",
                  // Labels for the reasoning of individual fallback entries.
                  options: REASONING,
                },
                {
                  path: "options",
                  label: "Provider options",
                  help: OPTIONS_HELP,
                  widget: "yaml",
                },
              ],
            }),
          ],
        },
        {
          title: "Catalog",
          entries: [
            {
              path: "models.catalog.providers",
              label: "Provider visibility",
              help: "Controls which providers appear in model pickers. Auto shows a provider when its credentials are configured.",
              widget: "map",
              options: { '"auto"': "Auto", '"enabled"': "Shown", '"disabled"': "Hidden" },
              placeholder: "Provider ID",
            },
          ],
        },
        {
          title: "Rules",
          advanced: true,
          entries: [
            {
              path: "models.rules",
              label: "Rules",
              help: "Ordered YAML rules that set default options by model glob before alias or per-run settings apply. `*` matches slashes, and later rules override earlier ones.",
              widget: "yaml",
            },
          ],
        },
        {
          title: "Capability overrides",
          help: "Overrides model limits, modalities, and pricing metadata.",
          advanced: true,
          entries: [
            {
              path: "models.capability.forceUnknownProviders",
              label: "Ignore provider metadata",
              help: "Ignores `models.dev` capability metadata for these provider IDs so Lilac treats their models as unresolved. Useful for providers whose metadata changes unpredictably.",
              placeholder: "Provider ID",
            },
            items({
              collection: "models.capability.overrides",
              label: "Overrides",
              itemNoun: "override",
              keyLabel: "Model",
              keyPlaceholder: "provider/model",
              newItem: {},
              summary: ["inherit"],
              fields: [
                {
                  path: "inherit",
                  label: "Inherit from",
                  help: "Base `provider/model` to copy capabilities from before applying overrides. Leave blank to merge onto upstream metadata; without any base, set Context window and any cost or modality fields in full.",
                },
                {
                  path: "limit.context",
                  label: "Context window",
                  help: "Maximum context size in tokens. Must be a positive number.",
                },
                {
                  path: "limit.output",
                  label: "Output limit",
                  help: "Maximum tokens the model can generate per reply. Accepts `0` or any positive whole number.",
                },
                {
                  path: "attachment",
                  label: "Attachments",
                  help: "Overrides whether this model accepts file attachments.",
                },
                {
                  path: "modalities.input",
                  label: "Input types",
                  help: "Input types the model accepts: `text`, `image`, `audio`, `video`, or `pdf`.",
                },
                {
                  path: "modalities.output",
                  label: "Output types",
                  help: "Output types the model produces: `text`, `image`, `audio`, `video`, or `pdf`.",
                },
                {
                  path: "cost",
                  label: "Cost",
                  help: "Partial YAML token-price overrides merged onto base costs. Affects cost estimates only, never provider billing.",
                  widget: "yaml",
                },
              ],
            }),
          ],
        },
      ],
    },
    {
      id: "discord",
      title: "Discord",
      sections: [
        {
          title: "Connection",
          entries: [
            {
              path: "surface.discord.tokenEnv",
              label: "Token variable",
              hint: "Environment variable name; do not paste the token.",
              help: "Environment variable that holds the Discord bot token. Keep the token value itself in your environment.",
            },
            {
              path: "surface.discord.botName",
              label: "Bot name",
              help: "Display name used for message attribution and stripping mentions. Cannot contain spaces.",
            },
            {
              path: "surface.discord.statusMessage",
              label: "Status message",
              help: "Custom status text shown on the bot's Discord profile.",
            },
            {
              path: "surface.discord.memberPresence",
              label: "Member presence intent",
              help: "Requests Discord member presence updates. Enable the matching privileged intent in your Discord app settings too.",
            },
            {
              path: "surface.discord.dbPath",
              label: "Database path",
              help: "Custom file path for the Discord state database.",
            },
          ],
        },
        {
          title: "Access",
          help: "Empty allowlists ignore all Discord messages.",
          entries: [
            {
              path: "surface.discord.allowedGuildIds",
              label: "Servers",
              help: "Discord server IDs the bot can respond in. If both this list and Channels are empty, the bot ignores all Discord traffic.",
              placeholder: "Server ID",
            },
            {
              path: "surface.discord.allowedChannelIds",
              label: "Channels",
              help: "Discord channel IDs the bot can respond in. If both this list and Servers are empty, the bot ignores all Discord traffic.",
              placeholder: "Channel ID",
            },
          ],
        },
        {
          title: "Routing",
          entries: [
            {
              path: "surface.router.defaultMode",
              label: "Default mode",
              help: "Controls which channel messages trigger the bot. When mentioned responds to mentions and replies; Every message considers every message like a DM.",
              options: { '"mention"': "When mentioned", '"active"': "Every message" },
            },
            {
              path: "surface.router.activeDebounceMs",
              label: "Active batching delay",
              help: "Wait time in milliseconds to group rapid opening messages in active mode before starting a run. Must be positive.",
            },
            {
              path: "surface.router.activeGate.enabled",
              label: "Active-mode gate",
              help: "Checks whether each active-mode message needs a reply before running the main agent. Individual channel overrides can turn this on or off.",
            },
            {
              path: "surface.router.activeGate.timeoutMs",
              label: "Gate timeout",
              help: "Maximum wait time in milliseconds for the active-mode gate to decide. Must be positive.",
              visibleWhen: { path: "surface.router.activeGate.enabled", equals: true },
            },
            items({
              collection: "surface.router.sessionModes",
              label: "Channel overrides",
              itemNoun: "override",
              keyLabel: "Channel, thread, or server ID",
              channelKeys: true,
              keyPlaceholder: "123456789012345678",
              newItem: {},
              summary: ["mode", "model"],
              fields: [
                {
                  path: "mode",
                  label: "Mode",
                  help: "Overrides channel routing for this server, channel, or thread. Leave unset to inherit the broader routing mode.",
                  options: { '"mention"': "When mentioned", '"active"': "Every message" },
                },
                {
                  path: "gate",
                  label: "Active-mode gate",
                  help: "Overrides the active-mode gate for this scope. Applies only when routing is set to active mode.",
                },
                {
                  path: "model",
                  label: "Model",
                  help: "Overrides the model used in this scope. Enter a `provider/model` ID or a configured model alias.",
                },
                {
                  path: "safetyMode",
                  label: "Safety",
                  hint: "Use Restricted for public or untrusted channels.",
                  help: "Trusted runs host tools directly. Restricted runs Bash inside an overlay filesystem and discards writes outside `/tmp` after each request, keeping `/tmp` under `/tmp/lilac-restricted/<sessionId>`.",
                  options: { '"trusted"': "Trusted", '"restricted"': "Restricted" },
                },
                {
                  path: "additionalPrompts",
                  label: "Extra prompts",
                  help: "Extra instructions appended to the system prompt for this scope. Enter plain text or a `file://` URL; an empty list blocks inherited prompts from broader scopes.",
                  placeholder: "Text or file:// URL",
                },
              ],
            }),
          ],
        },
        {
          title: "Replies",
          entries: [
            {
              path: "surface.discord.outputMode",
              label: "Streaming",
              help: "Controls how replies stream to Discord. Inline updates the final embed in place; Preview streams in a temporary message, posts the final reply, then deletes the preview.",
              options: { '"inline"': "Inline", '"preview"': "Preview" },
            },
            {
              path: "surface.discord.outputPreviewModeFinalStyle",
              label: "Final reply style",
              help: "Format for the final reply after preview streaming finishes: Discord embeds or plain messages.",
              options: { '"embed"': "Embed", '"plain"': "Plain message" },
              visibleWhen: IS_PREVIEW,
            },
            {
              path: "surface.discord.outputPreviewModeFinalText",
              label: "Long replies",
              help: "Splits long plain-text replies after preview streaming. Separate messages replies with the first chunk and posts the rest directly; Reply chain links commentary and chunks as replies.",
              options: { '"flat"': "Separate messages", '"reply-chain"': "Reply chain" },
              visibleWhen: IS_PREVIEW,
            },
            {
              path: "surface.discord.outputNotification",
              label: "Mention notifications",
              help: "Allows reply pings and `@user` notifications on bot replies. Turn off to post replies silently.",
            },
            {
              path: "surface.discord.workingIndicators",
              label: "Working phrases",
              help: "Status phrases rotated in Discord while a request runs. Overrides the global working phrases for Discord only.",
            },
            {
              path: "surface.discord.attachmentCache.ttl",
              label: "Attachment cache lifetime",
              help: "How long newly cached Discord attachments stay before expiring. Use no limit to keep them without expiry; `mo` equals 30 days.",
            },
          ],
        },
        {
          title: "Tables and math",
          entries: [
            {
              path: "surface.discord.markdownTableRender.enabled",
              label: "Render tables",
              help: "Formats Markdown tables so they read cleanly in Discord. When off, tables stay as raw Markdown.",
            },
            {
              path: "surface.discord.markdownTableRender.style",
              label: "Table style",
              help: "Unicode and ASCII draw text tables. Image posts top-level tables as PNG attachments in preview, plain, flat output, falling back to Unicode in other modes or on failure.",
              options: { '"unicode"': "Unicode", '"ascii"': "ASCII", '"image"': "Image" },
              visibleWhen: TABLES_ON,
            },
            {
              path: "surface.discord.markdownTableRender.maxWidth",
              label: "Table width",
              hint: "In display cells, 40 to 240.",
              help: "Maximum width for text tables and image fallbacks, measured in display cells from 40 to 240.",
              visibleWhen: TABLES_ON,
            },
            {
              path: "surface.discord.markdownTableRender.fallbackMode",
              label: "Too-wide tables",
              help: "Fallback when a table exceeds the width limit. List wraps rows as key-value text in a code block; Leave as Markdown keeps the original table.",
              options: { '"list"': "List", '"passthrough"': "Leave as Markdown" },
              visibleWhen: TABLES_ON,
            },
            {
              path: "surface.discord.markdownMathRender.enabled",
              label: "Render math",
              help: "Formats Markdown math expressions for Discord.",
            },
            {
              path: "surface.discord.markdownMathRender.maxWidth",
              label: "Math width",
              hint: "In display cells, 40 to 240.",
              help: "Maximum width for rendered math in display cells, from 40 to 240.",
              visibleWhen: MATH_ON,
            },
            {
              path: "surface.discord.markdownMathRender.fallbackMode",
              label: "Too-wide math",
              help: "Fallback when math exceeds the width limit. Show source displays the raw expression as code; Leave as Markdown keeps the original text.",
              options: { '"source"': "Show source", '"passthrough"': "Leave as Markdown" },
              visibleWhen: MATH_ON,
            },
          ],
        },
        {
          title: "Aliases",
          help: "Names the agent can use for Discord users and channels.",
          entries: [
            items({
              collection: "entity.users",
              label: "Users",
              itemNoun: "user",
              keyLabel: "Alias",
              keyPlaceholder: "alice",
              newItem: { discord: "" },
              summary: ["discord"],
              fields: [
                {
                  path: "discord",
                  label: "User ID",
                  help: "Discord snowflake ID for this user, stored as text to preserve precision.",
                },
                {
                  path: "comment",
                  label: "Note for the agent",
                  help: "Context about this user added to the system prompt alongside their alias and Discord ID.",
                },
              ],
            }),
            items({
              collection: "entity.sessions.discord",
              label: "Channels",
              itemNoun: "channel",
              keyLabel: "Alias",
              keyPlaceholder: "ops",
              newItem: { discord: "" },
              shorthand: "discord",
              summary: ["discord"],
              fields: [
                {
                  path: "discord",
                  label: "Channel ID",
                  help: "Discord snowflake ID for this channel, stored as text to preserve precision.",
                },
                {
                  path: "comment",
                  label: "Note for the agent",
                  help: "Context about this channel added to the system prompt alongside its alias and Discord ID.",
                },
              ],
            }),
          ],
        },
      ],
    },
    {
      id: "memory",
      experimental: true,
      title: "Memory",
      sections: [
        {
          title: "Thread summaries",
          entries: [
            {
              path: "conversation.thread.summarization.enabled",
              label: "Summarize threads",
              help: "Runs the background worker that summarizes past threads. Manual summarization via `conversation.thread.runSummarization` still works when off.",
            },
            {
              path: "conversation.thread.summarization.model",
              label: "Model",
              help: "Model used to write thread summaries. Accepts `main`, `fast`, a model alias, or `provider/model`.",
            },
            {
              path: "conversation.thread.summarization.concurrency",
              label: "Concurrency",
              help: "Number of threads summarized in parallel during a run, from 1 to 128.",
            },
            {
              path: "conversation.thread.summarization.batchSize",
              label: "Batch size",
              help: "Maximum threads summarized per scheduled run, up to 10,000. Manual runs stay unbounded unless given an explicit limit.",
            },
            {
              path: "conversation.thread.summarization.includePromptContext",
              label: "Include memory files",
              help: "Includes `MEMORY.md`, `USER.md`, and `ENTITIES.md` when present as background context to help resolve names and references.",
            },
          ],
        },
        {
          title: "Embeddings",
          entries: [
            {
              path: "conversation.thread.embedding.enabled",
              label: "Generate embeddings",
              help: "Creates semantic embeddings for thread search. Keyword search still works when this is off or if embedding fails.",
            },
            {
              path: "conversation.thread.embedding.model",
              label: "Model",
              help: "Embedding model for indexing threads. Enter a `provider/model` ID or a model alias.",
            },
            {
              path: "conversation.thread.embedding.queryModel",
              label: "Query model",
              help: "Separate embedding model used to encode search queries. Must match the document model's vector space and dimensions; leave blank to reuse the document model.",
              inherits: ["conversation.thread.embedding.model"],
            },
          ],
        },
        {
          title: "Related threads",
          help: "Adds titles of related past threads before the agent answers.",
          entries: [
            {
              path: "conversation.thread.autoInject.enabled",
              label: "Suggest related threads",
              help: "Automatically attaches matching past thread titles to eligible messages before the agent responds.",
            },
            {
              path: "conversation.thread.autoInject.plannerModel",
              label: "Search planner",
              help: "Model that plans thread searches. Accepts `main`, `fast`, a model alias, or `provider/model`; leave blank to inherit the summary model.",
              inherits: ["conversation.thread.summarization.model"],
            },
            {
              path: "conversation.thread.autoInject.textPlannerModel",
              label: "Text-only planner",
              help: "Planner model used when a message contains only text. Accepts the same values as Search planner; leave blank to reuse it.",
              inherits: [
                "conversation.thread.autoInject.plannerModel",
                "conversation.thread.summarization.model",
              ],
            },
            {
              path: "conversation.thread.autoInject.mode",
              label: "Search mode",
              help: "Retrieval method for matching past threads. Hybrid combines semantic and keyword search; Semantic or Keyword uses one method.",
              options: { '"hybrid"': "Hybrid", '"semantic"': "Semantic", '"lexical"': "Keyword" },
            },
            {
              path: "conversation.thread.autoInject.limit",
              label: "Max titles",
              help: "Maximum number of related thread titles attached to a message, from 1 to 10.",
            },
            {
              path: "conversation.thread.autoInject.minScore",
              label: "Minimum score",
              help: "Minimum combined search score required to keep a candidate thread. Set `0` for broad recall when debugging.",
            },
            {
              path: "conversation.thread.autoInject.expansionMinConfidence",
              label: "Extra result confidence",
              help: "Confidence needed to include additional results beyond the top match. Values around `0.45` to `0.55` favor recall; `0.65` to `0.75` favor precision. Tune this before Minimum score.",
            },
            {
              path: "conversation.thread.autoInject.minTextUnits",
              label: "Minimum message length",
              help: "Minimum message text mass needed to trigger recall, measured after stripping URLs, Discord syntax, and punctuation and discounting code blocks.",
            },
            {
              path: "conversation.thread.autoInject.followUpMinTextUnits",
              label: "Minimum follow-up length",
              help: "Minimum message text mass for later turns after a conversation already received related threads. Raise this to run fewer follow-up searches.",
            },
            {
              path: "conversation.thread.autoInject.filterCurrentParticipants",
              label: "Match current participants",
              help: "Limits Discord recall of Discord threads to people visible in the current message or reply chain. Web and TUI recall stays global.",
            },
          ],
        },
        {
          title: "Recall gate",
          help: "Decides whether a message needs related threads.",
          entries: [
            {
              path: "conversation.thread.autoInject.gate.mode",
              label: "Mode",
              help: "Controls how the recall gate acts. Off disables it, Record only logs decisions while still searching, and Skip searches skips retrieval when confident.",
              options: { '"off"': "Off", '"shadow"': "Record only", '"enforce"': "Skip searches" },
            },
            {
              path: "conversation.thread.autoInject.gate.model",
              label: "Models",
              help: DECISION_MODELS_HELP,
              widget: "modelList",
            },
            {
              path: "conversation.thread.autoInject.gate.skipMinProbability",
              label: "Skip confidence",
              help: "Minimum gate confidence required to skip thread search in Skip searches mode, from `0.5` to `1`.",
            },
          ],
        },
        {
          title: "Legacy decision mode",
          help: "Deprecated compatibility settings. Prefer Recall gate above.",
          advanced: true,
          entries: [
            {
              path: "conversation.thread.autoInjectMode",
              label: "Mode",
              help: "Legacy selector. All recall uses the search planner; Decision adds a record-only gate when Recall gate is unset. Use Recall gate instead.",
              options: { '"llm"': "Planner", '"decision"': "Decision" },
            },
            {
              path: "conversation.thread.decisionAutoInject.model",
              label: "Models",
              help: DECISION_MODELS_HELP,
              widget: "modelList",
              visibleWhen: DECISION,
            },
            {
              path: "conversation.thread.decisionAutoInject.limit",
              label: "Max titles",
              help: "Maximum related thread titles attached by decision recall, from 1 to 10.",
              visibleWhen: DECISION,
            },
            {
              path: "conversation.thread.decisionAutoInject.candidateLimit",
              label: "Candidates",
              help: "Maximum candidate threads evaluated by decision recall, from 1 to 50.",
              visibleWhen: DECISION,
            },
            {
              path: "conversation.thread.decisionAutoInject.semanticFallback",
              label: "Semantic candidates",
              help: "Includes semantic search matches in the candidate pool for decision recall.",
              visibleWhen: DECISION,
            },
            ...(["jev", "luna"] as const).flatMap((model): FieldEntry<P>[] => {
              const name = model === "jev" ? "Jev" : "Luna";
              const base = `conversation.thread.decisionAutoInject.${model}` as const;
              const fields: FieldEntry<P>[] = [
                {
                  path: `${base}.recallMinProbability`,
                  label: `${name} recall`,
                  help: `Minimum ${name} probability that a message needs recall, from \`0\` to \`1\`. Leave blank for the classifier's default.`,
                },
                {
                  path: `${base}.durableSubjectMinProbability`,
                  label: `${name} durable subject`,
                  help: `Minimum ${name} probability that the message mentions a lasting topic worth recalling, from \`0\` to \`1\`. Leave blank for the classifier's default.`,
                },
                {
                  path: `${base}.casualMaxProbability`,
                  label: `${name} casual maximum`,
                  help: `Maximum ${name} casual-chat probability allowed before skipping recall, from \`0\` to \`1\`. Leave blank for the classifier's default.`,
                },
                {
                  path: `${base}.relevanceMinProbability`,
                  label: `${name} relevance`,
                  help: `Minimum ${name} relevance probability for keeping a candidate thread, from \`0\` to \`1\`. Leave blank for the classifier's default.`,
                },
              ];
              return fields.map((field) => ({ ...field, visibleWhen: DECISION }));
            }),
          ],
        },
      ],
    },
    {
      id: "runs",
      title: "Runs",
      sections: [
        {
          title: "Responses",
          entries: [
            {
              path: "basePrompt",
              label: "Base prompt",
              help: "Instructions prepended before the prompt files in `DATA_DIR/prompts`.",
            },
            {
              path: "agent.reasoningDisplay",
              label: "Reasoning on Discord",
              help: "How model reasoning streams in Discord. Hidden hides it, Simple shows the status title and timer, and Detailed adds blockquoted reasoning up to 500 characters.",
              options: { '"none"': "Hidden", '"simple"': "Simple", '"detailed"': "Detailed" },
            },
            {
              path: "agent.statsForNerds",
              label: "Response stats",
              help: "Shows model, timing, and throughput stats below each reply. Verbose also includes input composition.",
              widget: "stats",
            },
            {
              path: "surface.workingIndicators",
              label: "Working phrases",
              help: "Status phrases rotated while a run is active. The web app uses them in place of `Working` and their past tense in place of `Worked`.",
            },
          ],
        },
        {
          title: "Limits",
          entries: [
            {
              path: "agent.idleTimeoutMs",
              label: "Idle timeout",
              help: "Stops a primary run after this many milliseconds with no model, tool, or subagent activity, minimum 1,500 ms. Active runs have no hard limit; subagents use two-thirds of this value, minimum 1,000 ms.",
            },
            {
              path: "workflows.maxActiveRuns",
              label: "Active workflow runs",
              help: "Maximum queued, running, blocked, and paused workflow runs allowed at once. Must be a positive whole number.",
            },
          ],
        },
        {
          title: "Retries",
          entries: [
            {
              path: "agent.retry.enabled",
              label: "Retry failures",
              help: "Automatically retries temporary provider failures and replay-safe idle timeouts on primary runs.",
            },
            {
              path: "agent.retry.maxRetries",
              label: "Max retries",
              help: "Retry attempts after the initial request fails. Set `0` to disable retries.",
              visibleWhen: { path: "agent.retry.enabled", equals: true },
            },
            {
              path: "agent.retry.baseDelayMs",
              label: "First delay",
              help: "Wait time in milliseconds before the first retry. Accepts `0`.",
              visibleWhen: { path: "agent.retry.enabled", equals: true },
            },
            {
              path: "agent.retry.maxDelayMs",
              label: "Max delay",
              help: "Upper limit in milliseconds on backoff delay between retries. Accepts `0`.",
              visibleWhen: { path: "agent.retry.enabled", equals: true },
            },
          ],
        },
        {
          title: "Transcripts",
          entries: [
            {
              path: "agent.transcriptRetention.maxAge",
              label: "Keep for",
              help: "Deletes completed request transcripts older than this duration. Applies independently of Keep at most; `mo` equals 30 days, and no limit turns off age pruning.",
            },
            {
              path: "agent.transcriptRetention.maxRequests",
              label: "Keep at most",
              help: "Maximum completed request transcripts to keep. Applies independently of Keep for; use no limit to remove the count cap.",
            },
          ],
        },
        {
          title: "Heartbeat",
          help: "Wakes the agent on a schedule without a message.",
          entries: [
            {
              path: "surface.heartbeat.enabled",
              label: "Enable heartbeat",
              help: "Turns on scheduled background wakes. To use a separate model, add a Channel override keyed `__heartbeat__`.",
            },
            {
              path: "surface.heartbeat.cron",
              label: "Schedule",
              help: "Five-field cron expression with minute precision controlling when heartbeat wakes run.",
            },
            {
              path: "surface.heartbeat.quietAfterActivityMs",
              label: "Quiet after activity",
              help: "Skips heartbeat wakes for this many milliseconds after regular chat activity. Set `0` to disable the cooldown.",
            },
            {
              path: "surface.heartbeat.retryBusyMs",
              label: "Retry delay",
              help: "Wait time in milliseconds before retrying a skipped heartbeat wake. Must be positive.",
            },
            {
              path: "surface.heartbeat.defaultOutputSession",
              label: "Post to",
              help: "Fallback destination for heartbeat messages in `<client>/<sessionIdOrAlias>` format. Concrete IDs are more reliable than aliases; per-watch destinations override this.",
              placeholder: "discord/ops",
            },
            {
              path: "surface.heartbeat.softQuietHours.start",
              label: "Quiet hours start",
              help: "Start of quiet hours in 24-hour `HH:MM` format.",
            },
            {
              path: "surface.heartbeat.softQuietHours.end",
              label: "Quiet hours end",
              help: "End of quiet hours in 24-hour `HH:MM` format.",
            },
            {
              path: "surface.heartbeat.softQuietHours.timezone",
              label: "Quiet hours timezone",
              help: "IANA timezone used to evaluate quiet hours, such as `Asia/Taipei`.",
              placeholder: "Asia/Taipei",
            },
          ],
        },
      ],
    },
    {
      id: "subagents",
      title: "Subagents",
      sections: [
        {
          title: "Delegation",
          entries: [
            {
              path: "agent.subagents.enabled",
              label: "Enable subagents",
              help: "Allows agents to delegate work to child subagents.",
            },
            {
              path: "agent.subagents.maxDepth",
              label: "Nesting depth",
              help: "Maximum delegation levels from `0` to `2`, counting the primary agent as `0`. Child agents also need Can delegate enabled in their permission profile.",
            },
            {
              path: "agent.subagents.delegatePromptOverlay",
              label: "Delegation guidance",
              help: "Extra instructions appended to the parent agent's `subagent_delegate` tool description. Use this for model choices, escalation rules, or cost preferences.",
            },
          ],
        },
        {
          title: "Permission profiles",
          entries: [
            items({
              collection: "agent.subagents.permissions",
              label: "Profiles",
              help: "Custom profiles start from the restricted defaults.",
              itemNoun: "profile",
              keyLabel: "Profile name",
              keyPlaceholder: "reviewer",
              fixedKeys: ["full", "restricted"],
              newItem: {},
              summary: ["execution", "workspaceWrites"],
              fields: [
                {
                  path: "execution",
                  label: "Shell",
                  help: "Controls shell access for this profile. Disabled turns off Bash, Restricted runs a virtual shell, and Host runs host Bash unless the channel is restricted.",
                  options: { false: "Disabled", '"restricted"': "Restricted", '"native"': "Host" },
                },
                {
                  path: "workspaceWrites",
                  label: "Workspace writes",
                  hint: "Host Bash can still write to disk.",
                  help: "Allows file-writing tools in the workspace. Host Bash still runs as the Core service user; use Restricted shell or OS isolation to contain filesystem writes.",
                },
                {
                  path: "network",
                  label: "Network",
                  hint: "Tool guardrail only; host Bash keeps network access.",
                  help: "Allows network-capable tools for this profile. Acts as a tool guardrail only; host Bash still has normal OS network access.",
                },
                {
                  path: "delegation",
                  label: "Can delegate",
                  help: "Lets subagents using this profile spawn their own subagents up to Nesting depth. They can only grant profiles within their own permissions.",
                },
                {
                  path: "level1.tools",
                  label: "Tools",
                  help: "Direct tools available to this profile. Add `*` to allow every globally enabled tool.",
                  suggestions: KNOWN_TOOLS,
                },
                {
                  path: "level1.plugins",
                  label: "Tool plugins",
                  help: "Direct-tool plugin IDs available to this profile. Add `*` for all enabled plugins; MCP servers also need Available to subagents turned on.",
                  suggestions: ["*"],
                },
                {
                  path: "level2.callables",
                  label: "Callables",
                  help: "Core tool-server callables available to this profile, such as `fetch` or `skills.read`. Add `*` for all enabled callables.",
                  suggestions: KNOWN_CALLABLES,
                },
                {
                  path: "level2.plugins",
                  label: "Callable plugins",
                  help: "Core tool-server plugin IDs available to this profile. Add `*` for all enabled plugins.",
                  suggestions: ["*"],
                },
                {
                  path: "promptOverlay",
                  label: "Instructions",
                  help: "Extra instructions appended to the prompt for subagents running with this profile.",
                },
              ],
            }),
          ],
        },
      ],
    },
    {
      id: "tools",
      title: "Tools",
      sections: [
        {
          title: "Files",
          entries: [
            {
              path: "tools.fsBackend",
              label: "Search backend",
              help: "Search engine powering file search tools: `fff` or `ripgrep`.",
              options: { '"fff"': "fff", '"node-rg"': "ripgrep" },
            },
            {
              path: "tools.editFile.hashline",
              label: "Hashline edits",
              help: "Enables hashline-based file editing for the file edit tool.",
            },
          ],
        },
        {
          title: "Web",
          entries: [
            {
              path: "tools.web.fetch.mode",
              label: "Fetch strategy",
              help: "Method the web fetch tool uses to retrieve pages. Extraction provider and Provider only use the configured extraction providers.",
              options: {
                '"auto"': "Auto",
                '"fetch"': "Direct",
                '"browser"': "Browser",
                '"extract"': "Extraction provider",
                '"provider-only"': "Provider only",
              },
            },
            {
              path: "tools.web.extract.providers",
              label: "Extraction providers",
              help: "Ordered list of web extraction providers: `tavily`, `exa`, or `firecrawl`. Duplicates are removed; set each provider's credentials in your environment.",
            },
            {
              path: "tools.web.firecrawl.maxConcurrency",
              label: "Firecrawl concurrency",
              help: "Maximum simultaneous requests per Firecrawl fetch or search limiter. Must be positive.",
            },
            {
              path: "tools.web.firecrawl.queueTtl",
              label: "Firecrawl queue wait",
              help: "Longest time a Firecrawl request waits in the local queue before timing out.",
            },
          ],
        },
        {
          title: "Tool output",
          entries: [
            {
              path: "tools.output.maxPreviewBytes",
              label: "Inline preview size",
              help: "Maximum size of a tool result shown inline in the conversation before truncation.",
            },
            {
              path: "tools.output.artifactTtl",
              label: "Keep results for",
              help: "How long stored tool-result artifacts are kept before expiring. `mo` equals 30 days.",
            },
            {
              path: "tools.output.artifactMaxBytesPerSession",
              label: "Results per session",
              help: "Maximum total size of stored tool-result artifacts retained per session.",
            },
            {
              path: "tools.media.maxInlineBytesPerPart",
              label: "Inline media per part",
              help: "Maximum size allowed for a single inline media attachment.",
            },
            {
              path: "tools.media.maxInlineBytesTotal",
              label: "Inline media total",
              help: "Maximum combined size across all inline media parts.",
            },
          ],
        },
        {
          title: "Result pruning",
          entries: [
            {
              path: "tools.historicalResultPruning.enabled",
              label: "Prune old results",
              help: "Removes older tool results from conversation history once thresholds are exceeded.",
            },
            {
              path: "tools.historicalResultPruning.protectTokens",
              label: "Protected recent tokens",
              help: "Token budget of recent tool results kept untouched by pruning. Accepts `0`.",
              visibleWhen: { path: "tools.historicalResultPruning.enabled", equals: true },
            },
            {
              path: "tools.historicalResultPruning.minimumTokens",
              label: "Minimum to prune",
              help: "Minimum tokens of eligible old tool results required before pruning runs. Accepts `0`.",
              visibleWhen: { path: "tools.historicalResultPruning.enabled", equals: true },
            },
          ],
        },
      ],
    },
    {
      id: "web",
      title: "Web app",
      sections: [
        {
          title: "Gateway",
          entries: [
            {
              path: "surface.native.enabled",
              label: "Enable web and TUI",
              help: "Starts the gateway for the web app and TUI. Requires an Installation ID; Clerk sign-in also requires an Owner Clerk user and Clerk issuer.",
            },
            {
              path: "surface.native.installationId",
              label: "Installation ID",
              help: "Unique, stable identifier for this installation, up to 256 characters. Required when the web and TUI gateway is enabled.",
            },
            {
              path: "surface.native.host",
              label: "Bind address",
              help: "Network interface the gateway listens on. Use an externally reachable address only when your deployment is secured for external access.",
            },
            {
              path: "surface.native.port",
              label: "Port",
              help: "TCP port the gateway listens on, from 1 to 65535.",
            },
            {
              path: "surface.native.publicUrl",
              label: "Public URL",
              help: "External HTTP or HTTPS address clients use to reach the gateway.",
            },
            {
              path: "surface.native.allowedOrigins",
              label: "Allowed origins",
              help: "Browser origins permitted to connect to the gateway. Must be non-empty, with no path or trailing slash.",
              placeholder: "https://example.com",
            },
          ],
        },
        {
          title: "Sign-in",
          entries: [
            {
              path: "surface.native.auth.provider",
              label: "Provider",
              help: "Sign-in backend for the web app and TUI. Clerk requires Owner Clerk user and Clerk issuer.",
              options: { '"local"': "Local", '"clerk"': "Clerk" },
            },
            {
              path: "surface.native.auth.ownerId",
              label: "Owner ID",
              help: "Local owner username for sign-in. `lilac` is reserved for the service user.",
              visibleWhen: { path: "surface.native.auth.provider", equals: "local" },
            },
            {
              path: "surface.native.auth.ownerProviderUserId",
              label: "Owner Clerk user",
              help: "Clerk user ID granted installation owner access. Required when Clerk sign-in is enabled.",
              visibleWhen: CLERK,
            },
            {
              path: "surface.native.auth.clerkIssuer",
              label: "Clerk issuer",
              help: "Token issuer URL from your Clerk instance. Required when Clerk sign-in is enabled.",
              visibleWhen: CLERK,
            },
            {
              path: "surface.native.auth.clerkOAuthClientId",
              label: "Clerk OAuth client",
              help: "Clerk OAuth client ID used to enable TUI sign-in.",
              visibleWhen: CLERK,
            },
          ],
        },
      ],
    },
    {
      id: "system",
      title: "System",
      sections: [
        {
          title: "Blob storage",
          help: "Stores uploaded files and tool artifacts.",
          entries: [
            {
              path: "blobStorage.kind",
              label: "Storage",
              help: "Where Core stores managed binary files. Choose a custom local directory, an existing private S3-compatible bucket, or Data directory for `DATA_DIR`.",
              widget: "discriminator",
              unsetLabel: "Data directory",
              options: { '"local"': "Local directory", '"s3"': "S3 bucket" },
            },
            {
              path: "blobStorage.root",
              label: "Directory",
              help: "Absolute path to the local storage directory. Required for local storage; choose Data directory above to use `DATA_DIR`.",
              placeholder: "/var/lib/lilac/blobs",
              visibleWhen: { path: "blobStorage.kind", equals: "local" },
            },
            {
              path: "blobStorage.bucket",
              label: "Bucket",
              help: "Name of an existing private S3-compatible bucket.",
              visibleWhen: S3,
            },
            {
              path: "blobStorage.prefix",
              label: "Key prefix",
              help: "Non-empty prefix prepended to object keys inside the bucket.",
              placeholder: "production/blobs",
              visibleWhen: S3,
            },
            {
              path: "blobStorage.endpoint",
              label: "Endpoint",
              help: "HTTP or HTTPS endpoint URL for the S3 API. Do not include credentials in the URL.",
              placeholder: "https://s3.example.com",
              visibleWhen: S3,
            },
            {
              path: "blobStorage.region",
              label: "Region",
              help: "Region used to sign S3 API requests.",
              placeholder: "us-east-1",
              visibleWhen: S3,
            },
            {
              path: "blobStorage.accessKeyIdEnv",
              label: "Access key variable",
              hint: "Environment variable name; do not paste the key.",
              help: "Environment variable holding the S3 access key ID, such as `LILAC_S3_ACCESS_KEY_ID`. Keep the key value in your environment.",
              visibleWhen: S3,
            },
            {
              path: "blobStorage.secretAccessKeyEnv",
              label: "Secret key variable",
              hint: "Environment variable name; do not paste the secret.",
              help: "Environment variable holding the S3 secret access key, such as `LILAC_S3_SECRET_ACCESS_KEY`. Keep the secret value in your environment.",
              visibleWhen: S3,
            },
            {
              path: "blobStorage.sessionTokenEnv",
              label: "Session token variable",
              hint: "Environment variable name; do not paste the token.",
              help: "Environment variable holding an S3 session token when using temporary credentials.",
              visibleWhen: S3,
            },
            {
              path: "blobStorage.forcePathStyle",
              label: "Path-style URLs",
              help: "Uses path-style bucket URLs when required by your S3-compatible storage provider.",
              visibleWhen: S3,
            },
          ],
        },
        {
          title: "Plugins",
          entries: [
            {
              path: "plugins.disabled",
              label: "Disabled plugins",
              help: "Plugin IDs turned off across Core. Disabled plugins are also unavailable to subagents even if listed in a profile.",
              placeholder: "Plugin ID",
            },
            {
              path: "plugins.config",
              label: "Plugin settings",
              help: "YAML map of plugin-specific settings keyed by plugin ID. Each plugin defines and validates its own options.",
              widget: "yaml",
            },
          ],
        },
        {
          title: "Telemetry",
          entries: [
            {
              path: "telemetry.errors",
              label: "Send error reports",
              help: "Sends sanitized error diagnostics: allowlisted breadcrumbs, repo-relative stack frames, and structural transcript shapes on provider 4xx schema errors. Excludes user text and raw identifiers.",
            },
            {
              path: "telemetry.usage",
              label: "Send usage metrics",
              help: "Sends anonymous per-run model, client, latency, and token counts. Excludes prompts and responses.",
            },
          ],
        },
      ],
    },
  ],
};
