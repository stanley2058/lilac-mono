import path from "node:path";
import { z } from "zod";
import {
  coreConfigInputSchemaV1,
  migrateWebConfigValue,
  migrateWebExtractConfigValue,
  webExtractProviderSchema,
} from "@stanley2058/lilac-utils/core-config/v1";
import { coreConfigInputSchemaV2 } from "@stanley2058/lilac-utils/core-config/v2";
import { coreConfigInputSchemaV3 } from "@stanley2058/lilac-utils/core-config/v3";
import {
  parseFriendlyByteSize,
  parseFriendlyDurationMs,
} from "@stanley2058/lilac-utils/friendly-units";
import { mcpConfigInputSchemaV1 } from "../src/mcp/config";

const unsupportedPreprocessors: string[] = [];

function applyFriendlyUnitSchema(
  output: z.core.$ZodType,
  units: string,
  jsonSchema: z.core.JSONSchema.JSONSchema,
): void {
  const numeric = toEditorSchema(output);
  delete numeric.$schema;
  delete jsonSchema.type;
  delete jsonSchema.exclusiveMinimum;
  delete jsonSchema.maximum;
  Object.assign(jsonSchema, {
    anyOf: [numeric, { type: "string", pattern: `^(0|[1-9][0-9]*)(\\.[0-9]+)?(${units})$` }],
  });
}

function applyPreprocessorSchema(
  def: z.core.$ZodPipeDef,
  jsonSchema: z.core.JSONSchema.JSONSchema,
): void {
  const transform = (def.in as z.core.$ZodTransform)._zod.def.transform;
  if (transform === parseFriendlyByteSize || transform === parseFriendlyDurationMs) {
    applyFriendlyUnitSchema(
      def.out,
      transform === parseFriendlyByteSize ? "B|KB|MB|GB|KiB|MiB|GiB" : "ms|s|m|h|d|w|mo",
      jsonSchema,
    );
    return;
  }
  if (transform !== migrateWebConfigValue && transform !== migrateWebExtractConfigValue) {
    unsupportedPreprocessors.push("Config input preprocessor needs an editor schema");
    return;
  }
  const output = toEditorSchema(def.out);
  delete output.$schema;
  Object.assign(jsonSchema, output);
  if (transform === migrateWebConfigValue && jsonSchema.properties?.extract) {
    jsonSchema.properties.search = jsonSchema.properties.extract;
  }
  if (transform === migrateWebExtractConfigValue && jsonSchema.properties) {
    jsonSchema.properties.provider = toEditorSchema(webExtractProviderSchema);
  }
}

function toEditorSchema(schema: z.core.$ZodType): z.core.JSONSchema.JSONSchema {
  return z.toJSONSchema(schema, {
    target: "draft-7",
    io: "input",
    override: ({ zodSchema, jsonSchema }) => {
      const def = (zodSchema as z.core.$ZodTypes)._zod.def;
      if (def.type === "pipe" && def.in._zod.def.type === "transform") {
        applyPreprocessorSchema(def, jsonSchema);
        return;
      }
      if (def.type === "object" && !def.catchall) jsonSchema.additionalProperties = false;
      // An omitted version dispatches to V1 at runtime.
      if (zodSchema === coreConfigInputSchemaV2 || zodSchema === coreConfigInputSchemaV3) {
        jsonSchema.required = [...new Set([...(jsonSchema.required ?? []), "configVersion"])];
      }
    },
  });
}

async function generateConfigSchemas(): Promise<void> {
  const core = toEditorSchema(
    z.union([coreConfigInputSchemaV1, coreConfigInputSchemaV2, coreConfigInputSchemaV3]),
  );
  core.title = "Lilac Core configuration";
  const mcp = toEditorSchema(mcpConfigInputSchemaV1);
  mcp.title = "Lilac MCP configuration";
  if (unsupportedPreprocessors.length > 0) {
    console.error(unsupportedPreprocessors.join("\n"));
    process.exitCode = 1;
    return;
  }
  const schemas = { "core-config.schema.json": core, "mcp-config.schema.json": mcp };
  for (const [name, schema] of Object.entries(schemas)) {
    const outputPath = path.join(import.meta.dir, "../src/generated/config-schemas", name);
    const formatted = Bun.spawnSync(["bunx", "oxfmt", "--stdin-filepath", outputPath], {
      stdin: Buffer.from(JSON.stringify(schema)),
      stdout: "pipe",
      stderr: "pipe",
    });
    if (!formatted.success) {
      console.error(formatted.stderr.toString());
      process.exitCode = 1;
      return;
    }
    const content = formatted.stdout.toString();
    if (process.argv.includes("--check")) {
      const file = Bun.file(outputPath);
      if (!(await file.exists()) || (await file.text()) !== content) {
        console.error(`${name} is stale. Run bun run codegen:config-schemas.`);
        process.exitCode = 1;
      }
      continue;
    }
    await Bun.write(outputPath, content);
  }
}

await generateConfigSchemas();
