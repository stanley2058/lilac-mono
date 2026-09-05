# Plugin Authoring

Core loads built-in and external Level 1 and Level 2 tools through the same in-process plugin runtime.
This is the canonical external-plugin contract. Plugins are trusted Core code with the service user's
authority.

## Package Layout

External plugins are discovered only from `DATA_DIR/plugins/*`.

Each plugin lives at:

```text
DATA_DIR/plugins/<plugin-id>/
```

The plugin directory must contain a `package.json` with a `lilac.plugin` entry pointing at the built entrypoint:

```json
{
  "name": "my-plugin",
  "version": "0.0.1",
  "type": "module",
  "lilac": {
    "plugin": "./dist/index.js"
  }
}
```

- The directory name is the plugin id.
- The plugin's exported `meta.id` must match that directory name.
- Plugin-local dependencies should be installed inside that plugin directory.

## Entrypoint Contract

Entrypoints default-export a `LilacToolPlugin` from `@stanley2058/lilac-plugin-runtime`.

```ts
import { z } from "zod";
import { tool } from "ai";
import { Result } from "better-result";
import { defineServerTool, serverToolFailure } from "@stanley2058/lilac-plugin-runtime";
import type {
  Level1ToolSpec,
  LilacToolPlugin,
  ServerTool,
} from "@stanley2058/lilac-plugin-runtime";

const configSchema = z.object({
  greeting: z.string().default("hello"),
});

const level1Tool: Level1ToolSpec<unknown> = {
  name: "example_echo",
  supportsBatch: false,
  isEnabled: () => true,
  createTool: () =>
    tool({
      inputSchema: z.object({ text: z.string() }),
      execute: async ({ text }) => ({ text }),
    }),
};

const level2Tool = defineServerTool({
  id: "example",
  callables: ({ callable }) => ({
    "example.echo": callable({
      name: "Example Echo",
      description: "Echo text back to the caller.",
      inputSchema: z.object({
        text: z.string().describe("Text to echo"),
      }),
      primaryPositional: "text",
      run: ({ text }) => Result.ok({ text }),
    }),
  }),
});

const plugin: LilacToolPlugin<unknown, Level1ToolSpec<unknown>, ServerTool> = {
  meta: {
    id: "my-plugin",
    name: "My Plugin",
  },
  create(context) {
    const config = configSchema.parse(context.pluginConfig);
    void config;

    return {
      level1: [level1Tool],
      level2: [level2Tool],
    };
  },
};

export default plugin;
```

Keep `isEnabled` for runtime prerequisites, not caller classification.

`defineServerTool` derives Level 2 lifecycle defaults, callable listing, CLI help, input
decoding, and dispatch. Callable-map keys are the exact externally visible callable IDs; keep
them stable. Each `run` callback receives the decoded `z.output` of its `inputSchema` plus the
request options (`signal`, `context`, and `messages`). Use `validation: "zod"` only when a
callable must preserve a raw `ZodError`; the default produces guided `ToolInputValidationError`
messages. Static or dynamic catalog overrides can hide a callable or adjust its current
description without changing its callable ID.

Every external Level 2 `run` callback must return a `better-result` `Result`, synchronously or
through a promise. Core accepts the full `better-result` Result protocol structurally so Results
created by a plugin-local dependency installation work across the plugin boundary. Return
`Result.ok(value)` when the callable completed successfully. For an expected failure, return
`Result.err(serverToolFailure({ ... }))` with all required `ServerToolFailure` fields:

```ts
return Result.err(
  serverToolFailure({
    kind: "unavailable",
    code: "upstream_unavailable",
    message: "The upstream service is unavailable",
    retryable: true,
    details: { service: "example" },
  }),
);
```

`kind` is one of `internal`, `usage`, `denied`, `not_found`, `conflict`, `unavailable`, `timeout`,
or `cancelled`; `code` is a stable machine-readable identifier, `message` is safe caller-facing
text, `retryable` states whether retrying may succeed, and optional `details` must be JSON. Raw
values and plain `{ status: ... }` wire-shaped objects without the full Result protocol are invalid
returns. Throwing is a callable defect, not an expected failure path; do not throw failures that
belong in `Result.err`.

This Result contract is a clean break with no compatibility path for older raw-return callables.
Update and rebuild every external Level 2 plugin before loading it. Report and diagnostic
callables retain their success semantics: if the callable successfully produced its report, return
`Result.ok(report)` even when the report contains warnings, validation findings, an unhealthy
status, or another negative diagnostic conclusion. Use `Result.err` only when the callable itself
could not complete as expected.

The Level 2 `/call` wire response is exactly one of:

```ts
{ status: "ok", value }
{ status: "error", error: ServerToolFailure }
```

Plugins return `Result`; Core owns this wire projection. Plugin authors must not construct the wire
envelope themselves.

## Lifecycle

- `create(context)` runs when Lilac loads or reloads the plugin.
- `instance.init()` is optional and runs after `create`.
- `instance.destroy()` is optional and runs after the plugin is retired and its last active holder releases it.
- Level 2 `ServerTool.init()` runs before its callable catalog is read. `ServerTool.destroy()` runs before the owning instance is destroyed.
- Throw `ToolPluginSkipError` when your plugin should be skipped because an optional runtime capability is missing.

Reload publishes a new plugin generation while existing Level 1 runs retain their original tools.
Core drains active Level 2 calls before replacing their callable catalog. The retired generation keeps
its shared resources until its Level 1 toolsets and Level 2 calls have released them. New and retired
instances can therefore coexist; keep instance-owned resources scoped to the corresponding `create`
result. An agent can reload tools without waiting for its own run to finish.

## Config

Plugin config is opaque to core and stored under:

```yaml
plugins:
  disabled: []
  config:
    my-plugin:
      greeting: hello
```

- `plugins.disabled` disables a plugin without uninstalling it.
- `plugins.config.<pluginId>` is passed through as `context.pluginConfig`.
- `agent.subagents.profiles.<profile>.level1` and `.level2` select plugin contributions for that native profile.
- Level 1 selection uses both plugin id and tool name; Level 2 selection uses both plugin id and callable
  id. A `"*"` entry includes every globally enabled contribution at that level.
- The same resolved native profile applies to direct, generated-delegation, and user-authored workflow
  launches. Plugin code cannot grant a profile additional authority.
- Plugins are expected to validate their own config, typically with Zod.

## Runtime Notes

- Built-in Level 1 names are reserved. External Level 1 names are qualified by plugin ID in the
  model-facing catalog, so different plugins may use the same raw name.
- Level 2 callable ids must be globally unique.
- Level 2 tools can opt into a single string positional shortcut via `primaryPositional`, e.g. `tools fetch <url>`.
- Core reloads plugins after a valid `core-config.yaml` change or an explicit reload through `/reload` or `tools onboarding.reload_tools`. After rebuilding a plugin, request a reload to load its new entrypoint. `/list`, `/help/:callableId`, and `/call` use the installed catalog and do not trigger reload.

## Level 1 Output

- Text and JSON returned to the model are bounded by `tools.output.maxPreviewBytes` after `toModelOutput` conversion.
- Oversized text and JSON are preserved as transient, session-owned `resource://t1_` artifacts when storage succeeds. The preview tells the model how to inspect the artifact with `read`; built-in `grep` can search the URI directly and always returns a bounded inline result. Core accepts legacy `tool-result://` references as read-only compatibility input.
- Core's trusted built-in `read` is the exception: it bounds only its textual payload by actual UTF-8 bytes, returns an exact continuation, and is excluded from settled batch aggregate budgeting. External tools named `read` do not receive this trust.
- Media and provider-reference content parts are not converted into text artifacts.
- Truncation does not change whether the tool execution succeeded or failed.
- Level 1 tools are batch-callable by default. Set `supportsBatch: false` when a tool must not be expanded into a batch child.
- Batch children execute as ordinary Level 1 calls, so approval checks, streaming, `toModelOutput`, output normalization, media parts, and tool lifecycle events behave the same as direct calls.
- Writer tools should implement `editTargets` so batch can reject children that would concurrently edit the same resource. Set `supportsBatch: false` when targets cannot be determined safely.
- A Level 1 spec may implement `summarizeFailure({ isError, result })` to classify a model-visible
  result. It returns `{ ok: true }` for success or `{ ok: false, ... }` for failure. `failureKind`
  (`hard` or `soft`) and `error` remain optional compatibility fields. Structured failures may also
  set `failureClass` (`input`, `policy`, `environment`, `timeout`, `cancelled`, `tool`, or `unknown`),
  a stable lower-snake-case tool-owned `failureCode`, `retryable`, and an integer `exitCode`. These
  fields are operational log data, so codes must not contain request-specific values or free-form
  messages. Core decodes every returned summary before using it.
