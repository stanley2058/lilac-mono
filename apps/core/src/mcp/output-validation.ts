import Ajv from "ajv";
import Ajv2019 from "ajv/dist/2019.js";
import Ajv2020 from "ajv/dist/2020.js";
import type { ValidateFunction } from "ajv";
import type { CallToolResult, ListToolsResult } from "@ai-sdk/mcp";
import { Result } from "better-result";

import { captureError } from "../shared/error-capture";
import { rethrowPanic } from "./error-format";
import type { McpConvertedTool } from "./registry-types";

type OutputSchema = NonNullable<ListToolsResult["tools"][number]["outputSchema"]>;
type CompiledOutputSchema =
  | { readonly kind: "compiled"; readonly validate: ValidateFunction }
  | { readonly kind: "unsupported" };

function outputFailure(message: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text: message }] };
}

function compileOutputSchema(schema: OutputSchema): CompiledOutputSchema {
  if (schema.$async === true) return { kind: "unsupported" };
  const options = {
    strict: false,
    validateFormats: false,
    addUsedSchema: false,
    logger: false as const,
  };
  const captured = Result.try({
    try: () => {
      // Synchronous compilation resolves bundled references only and never fetches schemas.
      switch (schema.$schema) {
        case "http://json-schema.org/draft-07/schema#":
        case "http://json-schema.org/draft-07/schema":
          return new Ajv(options).compile(schema);
        case "https://json-schema.org/draft/2019-09/schema":
          return new Ajv2019(options).compile(schema);
        default:
          return new Ajv2020(options).compile(schema);
      }
    },
    catch: captureError,
  });
  if (captured.isErr()) {
    rethrowPanic(captured.error.cause);
    return { kind: "unsupported" };
  }
  return captured.match({
    ok: (validate): CompiledOutputSchema => ({ kind: "compiled", validate }),
    err: (): CompiledOutputSchema => ({ kind: "unsupported" }),
  });
}

function validateOutput(validate: ValidateFunction, output: CallToolResult): CallToolResult {
  if ("isError" in output && output.isError) return output;
  if (!("structuredContent" in output) || output.structuredContent === undefined) {
    return outputFailure("MCP tool declared outputSchema but returned no structuredContent.");
  }
  const captured = Result.try({
    try: () => validate(output.structuredContent),
    catch: captureError,
  });
  if (captured.isErr()) {
    rethrowPanic(captured.error.cause);
    return outputFailure("MCP tool structuredContent could not be validated against outputSchema.");
  }
  return captured.match({
    ok: (valid) =>
      valid === true
        ? output
        : outputFailure("MCP tool structuredContent does not match its outputSchema."),
    err: () =>
      outputFailure("MCP tool structuredContent could not be validated against outputSchema."),
  });
}

export function wrapMcpToolWithOutputValidation(
  tool: McpConvertedTool,
  schema: OutputSchema | undefined,
): McpConvertedTool {
  const execute = tool.execute;
  if (schema === undefined || !execute) return tool;
  const compiled = compileOutputSchema(schema);
  return {
    ...tool,
    execute: async (...args: Parameters<typeof execute>) => {
      args[1]?.abortSignal?.throwIfAborted();
      if (compiled.kind === "unsupported") {
        return outputFailure(
          "MCP tool outputSchema is invalid or unsupported. Remote schema references are not fetched.",
        );
      }
      const output = await execute(...args);
      if (Symbol.asyncIterator in output) {
        return outputFailure("MCP tool returned an unsupported streaming result.");
      }
      return validateOutput(compiled.validate, output);
    },
  };
}
