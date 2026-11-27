import {
  decodeConfigSchema,
  versionSchemaNode,
  type ConfigSchema,
  type ConfigSchemaNode,
} from "@stanley2058/lilac-utils/config-schema";
import coreText from "../../../core/src/generated/config-schemas/core-config.schema.json?raw";
import mcpText from "../../../core/src/generated/config-schemas/mcp-config.schema.json?raw";

export type ConfigKind = "core" | "mcp";

/** The latest Core config version that form pages edit. */
export const FORM_CORE_CONFIG_VERSION = 3;

export type LoadedConfigSchema = {
  readonly schema: ConfigSchema;
  readonly root: ConfigSchemaNode;
  /** The schema as JSON, for the YAML editor. */
  readonly text: string;
};

function load(text: string, version?: number): LoadedConfigSchema {
  // The schema is generated at build time; `manifest-coverage.test.ts` fails if it stops decoding.
  const schema = decodeConfigSchema(JSON.parse(text)).match({
    ok: (value) => value,
    err: (): ConfigSchema => ({ root: {}, definitions: {} }),
  });
  return { schema, root: versionSchemaNode(schema, version), text };
}

const loaded: Record<ConfigKind, LoadedConfigSchema | undefined> = {
  core: undefined,
  mcp: undefined,
};

export function configSchema(kind: ConfigKind): LoadedConfigSchema {
  const cached = loaded[kind];
  if (cached) return cached;
  const next = kind === "core" ? load(coreText, FORM_CORE_CONFIG_VERSION) : load(mcpText);
  loaded[kind] = next;
  return next;
}

export function rawConfigSchema(kind: ConfigKind): string {
  return kind === "core" ? coreText : mcpText;
}
