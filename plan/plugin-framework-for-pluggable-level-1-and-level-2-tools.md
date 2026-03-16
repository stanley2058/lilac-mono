# Plugin Framework for Pluggable Level 1 and Level 2 Tools

**Summary**

The current repo has three different extension shapes: Level 1 tools are assembled inline in [bus-agent-runner.ts](/home/stanley/Sandbox/lilac-mcp/lilac-mono/apps/core/src/surface/bridge/bus-agent-runner.ts), Level 2 tools are hardcoded in [default-tools.ts](/home/stanley/Sandbox/lilac-mcp/lilac-mono/apps/core/src/tool-server/default-tools.ts), and Level 3 skills already use file-based discovery. The plan is to unify Levels 1 and 2 behind one in-process plugin system, keep built-ins on that same path, and load external plugins from `DATA_DIR/plugins/*`, enabled by default unless disabled in `core-config.yaml`.

**Architecture**

1. Add a new plugin runtime under `apps/core/src/plugins/` with `types.ts`, `discovery.ts`, `loader.ts`, `manager.ts`, and `builtin/`.
2. Define one plugin contract for both levels:
   - `LilacToolPlugin`: `meta`, `create(context)`, optional `init/destroy`.
   - `ToolPluginInstance`: `level1`, `level2`.
   - `level1` contributes typed Level 1 tool specs.
   - `level2` contributes existing `ServerTool` instances so the tool-server surface can stay mostly intact.
3. Use a package-based external plugin format:
   - Plugin root: `DATA_DIR/plugins/<plugin-id>/`
   - Required `package.json` custom field: `"lilac": { "plugin": "./dist/index.js" }`
   - Entrypoint exports a default `LilacToolPlugin`.
   - Plugin-local dependencies live inside that folder.
4. Keep built-ins as bundled plugins under `apps/core/src/plugins/builtin/`, grouped by current domain boundaries:
   - `builtin-local-tools` for `bash`, fs tools, edit/apply_patch, `batch`, `subagent_delegate`
   - one bundled plugin each for `web`, `skills`, `workflow`, `surface`, `attachment`, `onboarding`, `generate`, `codex`, `summarize`, `ssh`
5. Introduce a `ToolPluginManager` that:
   - discovers bundled and external plugins
   - reads plugin activation config
   - loads/imports plugins
   - validates unique plugin ids, unique Level 1 tool names, and unique Level 2 callable ids
   - tracks plugin status as `loaded`, `disabled`, `skipped`, or `failed`
   - supports `init()`, `destroy()`, `reload()`, and `ensureFresh()`

**Config and Interfaces**

1. Extend `packages/utils/core-config.ts` with a new top-level section:
   - `plugins.disabled: string[]` default `[]`
   - `plugins.config: Record<string, unknown>` default `{}`
2. `plugins.config.<pluginId>` is plugin-owned opaque config; core only stores/pass-throughs it, and each plugin validates its own config with Zod at load time.
3. External plugins are active by default when discovered. Adding a plugin id to `plugins.disabled` disables it without uninstalling it.
4. V1 supports plugin-level toggles only, not per-tool toggles inside a plugin.
5. Export plugin types and manager from `@stanley2058/lilac-core` so `apps/tool-bridge` and future packages use the same runtime.

**Level 1 Refactor**

1. Replace inline tool assembly in `startBusAgentRunner()` with `pluginManager.buildLevel1Toolset({ cwd, runProfile, editingToolMode, subagentDepth, requestContext })`.
2. Introduce `Level1ToolSpec` metadata needed to remove hardcoded tool-name logic:
   - `name`
   - `createTool(buildContext)`
   - `isEnabled(runContext)`
   - `supportsBatch`
   - `editTargets(args, context)` for overlap detection
   - `formatArgs(args)` for progress display
   - `summarizeFailure({ isError, result })`
3. Rework [batch.ts](/home/stanley/Sandbox/lilac-mcp/lilac-mono/apps/core/src/tools/batch.ts), [tool-args-display.ts](/home/stanley/Sandbox/lilac-mcp/lilac-mono/apps/core/src/tools/tool-args-display.ts), and [tool-failure-logging.ts](/home/stanley/Sandbox/lilac-mcp/lilac-mono/apps/core/src/surface/bridge/bus-agent-runner/tool-failure-logging.ts) to consume Level 1 metadata instead of hardcoded tool names.
4. Preserve current built-in behavior exactly:
   - `explore` still gets read/search-only tools
   - edit mode still chooses `edit_file` vs `apply_patch`
   - `batch` still only permits tools marked `supportsBatch`
   - `subagent_delegate` still obeys current depth/profile rules

**Level 2 Refactor**

1. Replace `createDefaultToolServerTools()` with plugin-manager-backed Level 2 loading.
2. Keep the `ServerTool` interface for v1 so existing Level 2 tool classes migrate with adapter wrappers instead of full rewrites.
3. Update [create-core-runtime.ts](/home/stanley/Sandbox/lilac-mcp/lilac-mono/apps/core/src/runtime/create-core-runtime.ts) to create one shared `ToolPluginManager` and pass it to both the bus agent runner and tool server.
4. Update [apps/tool-bridge/index.ts](/home/stanley/Sandbox/lilac-mcp/lilac-mono/apps/tool-bridge/index.ts) to create the same manager in dev mode with missing services unset.
5. Capability-dependent plugins must skip cleanly when required services are absent:
   - `workflow` and `attachment` skip without `bus`
   - `surface` skips without `adapter` and config access
   - skips are logged and included in plugin status, not treated as fatal
6. `/reload` on the tool server becomes `pluginManager.reload()` plus callable remapping refresh.

**Failure Policy and Reloading**

1. Built-in plugin load/init failures are fatal unless the plugin explicitly skips for missing optional runtime capabilities.
2. External plugin failures are non-fatal: mark failed, log the reason, continue startup.
3. `ensureFresh()` checks `core-config.yaml` mtime and `DATA_DIR/plugins` contents before Level 1 toolset creation and before Level 2 list/call handling.
4. Reloading code changes is supported by re-importing plugin entrypoints with a cache-busting file URL; config-only changes also trigger plugin re-evaluation.

**Testing and Acceptance**

1. Add discovery tests for valid plugin packages, missing `lilac.plugin`, duplicate ids, duplicate Level 1 names, duplicate callable ids, disabled plugins, and broken imports.
2. Add parity tests proving current built-in tool names and Level 2 callable ids are unchanged after migration.
3. Add Level 1 integration tests for:
   - `explore` vs normal profile tool exposure
   - `apply_patch` vs `edit_file` mode switching
   - batch allow/deny behavior from metadata
   - overlapping edit rejection via plugin-provided `editTargets`
4. Add tool-server tests for:
   - plugin-backed `/list`
   - plugin-backed `/call`
   - `/reload` reloading external plugins from a temp `DATA_DIR/plugins`
   - dev-mode skipping of bus/adapter-dependent plugins
5. Add one temp external plugin fixture that contributes both one Level 1 tool and one Level 2 callable to prove the dual-level plugin contract works.

**Docs and Rollout**

1. Update `PROJECT.md` to describe the new Level 1/2 plugin model, discovery path, and activation rules.
2. Update `packages/utils/config-templates/core-config.example.yaml` with the new `plugins` section.
3. Add a short plugin authoring doc with the package layout, entrypoint contract, config shape, and lifecycle expectations.
4. Remove or deprecate `createDefaultToolServerTools()` once all callers use `ToolPluginManager`.

**Assumptions and Defaults**

1. V1 is in-process only; plugins have the same privileges as core code.
2. V1 discovers external plugins only from `DATA_DIR/plugins/*`; no workspace-local plugin scan is included yet.
3. Existing built-in tool names and Level 2 callable ids stay stable during migration.
4. Plugin configuration is opaque to core and validated by each plugin individually.
5. Plugin enablement is default-on, disable-via-config, matching your requested activation model.
