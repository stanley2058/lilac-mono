import { configureMonacoYaml, type JSONSchema } from "monaco-yaml";
import { monaco } from "./monaco-runtime";
import core from "../../../core/src/generated/config-schemas/core-config.schema.json?raw";
import mcp from "../../../core/src/generated/config-schemas/mcp-config.schema.json?raw";
let enabled = false;
export function enableYaml() {
  if (enabled) return;
  enabled = true;
  configureMonacoYaml(monaco, {
    enableSchemaRequest: true,
    schemas: [
      {
        uri: "file:///lilac-settings/.schemas/core-config.schema.json",
        schema: JSON.parse(core) as JSONSchema,
        fileMatch: ["file:///lilac-settings/core-config.yaml"],
      },
      {
        uri: "file:///lilac-settings/.schemas/mcp-config.schema.json",
        schema: JSON.parse(mcp) as JSONSchema,
        fileMatch: ["file:///lilac-settings/mcp-config.yaml"],
      },
    ],
  });
}
