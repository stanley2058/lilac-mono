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

## Maintaining field documentation

Field descriptions live beside the Zod input schemas in `packages/utils/core-config/v1.ts`,
`v2.ts`, and `v3.ts`. Shared fields inherit descriptions; version-specific overrides must retain
or update them. Include omission behavior and defaults in the descriptions. The generator emits
these descriptions as Markdown hover text and preserves schema defaults for completion.

After changing a field or its documentation, run `bun run codegen:config-schemas`.
`bun run codegen:config-schemas:check` checks that the committed schema matches the source.
The generated JSON Schema can also be read directly without an LSP client.

See [configuration migrations](core-config-migrations.md) before changing a file's version.
