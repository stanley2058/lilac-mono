# Core configuration

Explain and change Core configuration through the Level 2 `config` callables, which read and write the
target instance's `<DATA_DIR>/core-config.yaml` against the schema of its `configVersion`.

## Inspect fields

- `tools config.describe core` lists the top-level sections and whether the file sets each one.
- `tools config.describe core --query=<text>` searches field paths and descriptions. Record keys appear
  as `*`; substitute a concrete key in a path.
- `tools config.describe core --path=<path>` returns one field's description, type, default, current
  value, whether the file sets it, its `restart` flag, and its child keys. Paths look like
  `agent.subagents.maxDepth` or `models.def["gpt-5"].model`.

The description covers what a field accepts. For side effects or behavior beyond it, search the exact
dotted path from the owner below and trace its consumer.

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
| `models` | Aliases, slots, catalog visibility, option rules, fallbacks, capabilities, and named OpenAI-compatible servers | `packages/utils/model-slot.ts`, `packages/utils/model-catalog.ts`, `packages/utils/model-rules.ts`, `packages/utils/model-capability.ts`, `packages/utils/model-provider.ts` |
| `entity` | Discord user and session aliases | `apps/core/src/entity`, `apps/core/src/surface/discord` |
| `basePrompt` | Base model instructions selected with the model plan | `packages/utils/model-slot.ts`, the Core agent runner |

## Settings that live elsewhere

- MCP servers live in `mcp-config.yaml`. Load the `mcp-management` skill and use the `mcp.*` callables.
- Provider credentials and the default OpenAI-compatible endpoint (`OPENAI_COMPATIBLE_BASE_URL`) live
  in the deployment environment. A named server under `models.providers.openaiCompatible` stores only
  its key's variable name in `apiKeyEnv`; ask the user to set the value, which takes effect after a
  restart.
- Native web deployment settings live in `native-surface.db`: title model, output streaming,
  cross-thread send behavior, DM context and timestamp gaps, and message selection and storage
  retention ages. Only the web Settings > Deployment page changes them. Config v3 rejects the old
  `surface.native.*` keys for these settings, so direct the user to that page.

## Make a requested edit

Before changing `configVersion`, follow `docs/core-config-migrations.md`. Verify any one-time native
deployment import and review the new default delegated authority before applying v3.

1. Confirm every path with `config.describe`. To return a field to its default, plan an `unset`
   operation rather than writing the default value.
2. Preview with `dryRun`. Record the returned `revision` and check that the diff changes only the
   requested fields:

   ```bash
   tools config.patch --stdin <<'JSON'
   {
     "file": "core",
     "dryRun": true,
     "operations": [
       { "op": "set", "path": "agent.subagents.maxDepth", "value": 3 },
       { "op": "unset", "path": "agent.reasoningDisplay" }
     ]
   }
   JSON
   ```

3. Apply the same operations without `dryRun` and with `"expectedRevision"` set to the recorded
   revision. On a conflict, the file changed underneath you: describe the affected fields again and
   return to step 2.
4. Read `restartRequired` in the result. Core applies every other written field through its config
   watcher. Restart with `tools onboarding.restart` only when the user authorized it; otherwise report
   the pending restart.
5. Verify the requested behavior through the consumer, a log source, or a live diagnostic.

The edit is complete when the written file passed `config.patch` validation, the intended consumer
observes the value or has an approved or reported restart pending, and the diff contains only the
requested fields.

## Edit without the config callables

Use this route only when `config.describe` and `config.patch` are unavailable, such as in a subagent
whose profile lacks them.

1. Read `configVersion` from the live file. When it is absent, use `DEFAULT_CORE_CONFIG_VERSION` in
   `packages/utils/core-config/v3.ts`. Confirm field shapes in the matching `v1.ts`, `v2.ts`, or `v3.ts`
   input schema.
2. Preserve the original file and prepare the smallest change outside the live path. Parse it with the
   shipped Bun runtime and the loader in `packages/utils/core-config.ts`, using a temporary `DATA_DIR` so
   loader-created prompt files stay outside live state. Unknown keys are reported and ignored, so a
   misspelled key can parse cleanly and change nothing.
3. Apply the validated change to the live file without rewriting unrelated sections, then run
   `tools onboarding.reload_config --mode=cache` when that callable is available.
4. Trace the field's consumer to decide whether it needs a restart, then finish with steps 4 and 5
   above. If live validation fails, restore the preserved file before anything else. A failed reload
   leaves Core on its last good config, but the invalid file still blocks the next clean startup.
