# Core configuration

Explain and change Core configuration against the parser shipped with the target instance.

## Find the contract

1. Resolve the active file as `<DATA_DIR>/core-config.yaml`. In the stock container, `DATA_DIR` is
   `/data`.
2. Read `configVersion` before interpreting any field. When it is absent, inspect
   `DEFAULT_CORE_CONFIG_VERSION` in `packages/utils/core-config/v3.ts`; do not assume the version used by
   the current example template.
3. Use the matching `packages/utils/core-config/v1.ts`, `v2.ts`, or `v3.ts` input schema for accepted fields and
   version-owned defaults.
4. Use `packages/utils/core-config/types.ts` for the universal shape consumed by the application and
   `packages/utils/core-config.ts` for YAML loading, version dispatch, cache behavior, and path resolution.
5. Read field descriptions in the matching Zod input schema or
   `<DATA_DIR>/.schemas/core-config.schema.json`. The example YAML is a minimal starter;
   `docs/core-config.md` explains editor hover and completion.
   Confirm exact shapes in the parser before proposing an edit.

Wrongly typed values fail parsing. Unknown keys are currently reported and ignored. Confirm both behaviors
in the shipped loader before relying on them, since an ignored misspelling can look like a successful
change.

## Ownership map

| Top-level key | What it controls | First owner to inspect |
| --- | --- | --- |
| `configVersion` | Parser and version-owned defaults | `packages/utils/core-config.ts`, then `core-config/v1.ts`, `v2.ts`, or `v3.ts` |
| `blobStorage` | Backend for Core-managed opaque bytes | `apps/core/src/runtime/create-core-runtime.ts`, `packages/blob-storage` |
| `tools` | Tool providers, behavior, media, and result budgets | `apps/core/src/plugins`, `apps/core/src/tool-server`, `packages/coding-tools`, `packages/tool-results` |
| `plugins` | Disabled contributions and plugin-owned opaque config | `apps/core/src/plugins/manager.ts`, `packages/plugin-runtime` |
| `conversation` | Thread summaries, embeddings, and request-time thread injection | `apps/core/src/conversation` |
| `workflows` | Workflow admission policy | `apps/core/src/workflow`, `apps/core/src/plugins/builtin/server-tools.ts` |
| `surface` | Routing, Discord behavior, and heartbeat | `apps/core/src/surface`, `apps/core/src/heartbeat` |
| `agent` | Run display, retention, retry, idle, and subagent policy | `apps/core/src/surface/bridge/bus-agent-runner.ts`, `packages/agent` |
| `models` | Aliases, slots, catalog visibility, option rules, fallbacks, and capabilities | `packages/utils/model-slot.ts`, `packages/utils/model-catalog.ts`, `packages/utils/model-rules.ts`, `packages/utils/model-capability.ts` |
| `entity` | Discord user and session aliases | `apps/core/src/entity`, `apps/core/src/surface/discord` |
| `basePrompt` | Base model instructions selected with the model plan | `packages/utils/model-slot.ts`, the Core agent runner |

The table is a navigation map, not a field catalog. Search the exact dotted path and trace its consumer
before describing side effects or reload timing.

## Determine when a change takes effect

Core watches `core-config.yaml`, validates changed content, refreshes adapter config, updates active
transcript retention, and marks conversation-thread materialization dirty. Request paths also reload the
cached config opportunistically. This does not make every field hot-reloadable.

Classify the exact field from current code:

- A consumer that calls `getCoreConfig` for each request or refreshes its stored config can observe a valid
  change without process replacement.
- A value captured while `createCoreRuntime` constructs a store, server, registry, or worker needs the
  lifecycle action shown by that owner, often a restart.
- A failed reload leaves the process on its last known good config, but the invalid file still blocks a
  clean future startup.

State the traced timing for the requested field. Avoid a global "hot reload" or "restart required" claim.

## Make a requested edit

Before changing `configVersion`, follow `docs/core-config-migrations.md`. Verify any one-time native
deployment import and review the new default delegated authority before applying v3.

1. Preserve the original file and prepare the smallest candidate change outside the live path.
2. Parse the candidate with the shipped Bun runtime and matching Core loader. A temporary `DATA_DIR` may
   be used so loader-created prompt files stay outside live state.
3. Apply the validated delta to the live file without rewriting unrelated sections or adding a new option
   the user did not request.
4. Force a cache validation with `tools onboarding.reload_config --mode=cache` when that callable is
   available. Otherwise use the automatic watcher and an available log or behavior check.
5. Verify the requested behavior. If live validation fails, restore the preserved file before doing
   anything else.
6. Restart only when the traced owner requires it and the user authorized that lifecycle action.

The edit is complete when the live file parses under its declared version, the intended consumer observes
the value or has an approved restart pending, and unrelated configuration is unchanged.
