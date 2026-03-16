# Plugin Authoring

Lilac Level 1 and Level 2 tools now load through the same in-process plugin runtime.

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
  supportsBatch: true,
  isEnabled: () => true,
  createTool: () =>
    tool({
      inputSchema: z.object({ text: z.string() }),
      execute: async ({ text }) => ({ text }),
    }),
};

const level2Tool: ServerTool = {
  id: "example",
  async init() {},
  async destroy() {},
  async list() {
    return [
      {
        callableId: "example.echo",
        name: "Example Echo",
        description: "Echo text back to the caller.",
        shortInput: ["text=<string>"],
        input: ["text: string"],
      },
    ];
  },
  async call(callableId, input) {
    if (callableId !== "example.echo") {
      throw new Error(`Unknown callable '${callableId}'`);
    }
    return input;
  },
};

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

## Lifecycle

- `create(context)` runs when Lilac loads or reloads the plugin.
- `instance.init()` is optional and runs after `create`.
- `instance.destroy()` is optional and runs when the plugin is unloaded.
- Level 2 `ServerTool.init()` / `ServerTool.destroy()` still run when tools are activated or replaced.
- Throw `ToolPluginSkipError` when your plugin should be skipped because an optional runtime capability is missing.

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
- Plugins are expected to validate their own config, typically with Zod.

## Runtime Notes

- Plugins run in-process and have the same privileges as core code.
- Level 1 tool names must be globally unique.
- Level 2 callable ids must be globally unique.
- Built-in and external plugins share the same loading path and validation rules.
- Hot reload is based on `core-config.yaml` and plugin directory contents; changing the built entrypoint and then calling `/reload`, `/list`, `/help/:callableId`, or `/call` will cause re-evaluation.
