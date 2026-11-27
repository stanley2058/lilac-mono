# Core configuration

Keep `core-config.yaml` focused on your deployment's settings. Optional fields and their
explanations are available through YAML language-server hover and completion. The
[starter template](../packages/utils/config-templates/core-config.example.yaml) includes the schema
association and a small set of editable settings.

## Editor documentation

Keep this first line in `DATA_DIR/core-config.yaml`:

```yaml
# yaml-language-server: $schema=./.schemas/core-config.schema.json
```

Core writes the matching schema to `DATA_DIR/.schemas/core-config.schema.json` at startup and
refreshes it after upgrades. The schema is local, so editor documentation works offline once it
has been published. When editing a remote copy, copy the `.schemas` directory alongside the config
or adjust the modeline to the schema's location.

Use an editor connected to `yaml-language-server`, such as VS Code with Red Hat's YAML extension
or Neovim with yamlls. Hover a key for behavior, examples, units, defaults, and caveats. Invoke
completion within a mapping to discover optional keys and allowed values. Set `configVersion`
explicitly so the editor can select the matching version.

Enable `yaml.hover` and `yaml.completion` in the language-server settings. To keep inserted
objects small, set `yaml.disableDefaultProperties: true`; optional fields remain discoverable.
Plugin-specific configuration and arbitrary provider options depend on their owner's schema and
may only have documentation on the containing field.

## Agent configuration tools

Agents can read and edit `core-config.yaml` and `mcp-config.yaml` through two tool-server
callables in the `config` plugin:

- `config.describe` takes `file` (`core` or `mcp`) and an optional `path` or `query`. A path such as
  `agent.subagents.maxDepth` or `models.def["gpt-5"].model` returns the field's description, type,
  default, current value, whether the file sets it, and its child keys. A query searches field paths
  and descriptions. With neither, it lists the top-level sections. Core fields come from the schema
  of the file's `configVersion`.
- `config.patch` applies up to 50 `set` and `unset` operations and keeps comments outside the
  changed nodes. Core rejects paths the schema does not know and validates the whole result before
  writing. `dryRun` returns the diff without writing. `expectedRevision` fails the write when the
  file changed since that revision. `unset` resets a field to its default.

Core reloads core-config changes automatically, except fields marked restart-only, such as
`surface.native.port`. `config.patch` lists any touched restart-only paths. MCP writes reload the
MCP registry and return the outcome for each server. The native settings page saves through the
same validation, revision check, and atomic write.

Both callables are hidden in restricted sessions and heartbeat runs. Subagent profiles need the
callables in `level2`, and `config.patch` also needs `workspaceWrites: true`. The built-in
`restricted` profile grants neither. Keep secrets out of both files. Reference environment
variable names, or `{env: NAME}` value sources in `mcp-config.yaml`.

## Maintaining field documentation

Field descriptions live beside the Zod input schemas in `packages/utils/core-config/v1.ts`,
`v2.ts`, and `v3.ts`. Shared fields inherit descriptions; version-specific overrides must retain
or update them. Include omission behavior and defaults in the descriptions. The generator emits
these descriptions as Markdown hover text and preserves schema defaults for completion.

After changing a field or its documentation, run `bun run codegen:config-schemas`.
`bun run codegen:config-schemas:check` checks that the committed schema matches the source.
The generated JSON Schema can also be read directly without an LSP client.

See [configuration migrations](core-config-migrations.md) before changing a file's version.

## Settings pages

Owners can edit both files under Settings > Core and Settings > MCP. Each has form pages and a
YAML tab that edits the same draft, so changes in one appear in the other before saving. A save
validates the whole file, checks that it has not changed since it was loaded, and keeps comments
and formatting outside the edited lines. If a file mixes indent widths so that an edit cannot keep
its original lines valid, the save writes the whole file in the standard layout with the same
values. The form edits Core `configVersion: 3`. For older files the form is read-only and links
to the YAML tab.

The form takes types, defaults, and descriptions from the generated schema. Two more pieces decide
how a field appears:

- **Editor hints in the schema.** Attach `.meta(configUi({ kind, restart }))` from
  `packages/utils/core-config/ui-meta.ts` where a field is defined. `kind` picks a widget for
  values whose type alone is ambiguous, such as `model`, `discordChannel`, `env`, or `multiline`;
  on a list it describes the items. Set `restart: true` when Core reads the field only at startup;
  children inherit it. The generator marks friendly durations and byte sizes automatically.
- **Placement in the web manifest.** `apps/web/src/config-ui/core-manifest.ts` and
  `mcp-manifest.ts` group fields into pages and sections and give them labels. Their paths are
  typed by the generated `config-fields.ts`, so renaming or removing a field fails the typecheck.

`apps/web/src/config-ui/manifest-coverage.test.ts` fails when a schema field has no place in the
manifest, or when a fixed editor such as the fallback list or an MCP value source meets a child
field that `FIXED_EDITOR_FIELDS` in `manifest.ts` does not list. When you add a field, place it,
or list it under `unplaced` with the reason it stays YAML-only.
