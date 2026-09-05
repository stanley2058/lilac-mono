import type { ToolClientJsonObject } from "./client-protocol";
import { Result, TaggedError, type Result as ResultType } from "better-result";

export type ToolPrimaryPositional = {
  readonly field: string;
  readonly variadic?: boolean;
};

export class ToolClientArgumentInvalid extends TaggedError("ToolClientArgumentInvalid")<{
  readonly code:
    | "UNSUPPORTED_POSITIONAL_INPUT"
    | "CONFLICTING_POSITIONAL_INPUT"
    | "TOO_MANY_POSITIONAL_ARGUMENTS";
  readonly message: string;
}> {}

export function parseToolBoolean(value: string): boolean | undefined {
  const normalized = value.trim().toLowerCase();
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  return undefined;
}

export function toolFlagField(input: string): string {
  return input.replace(/-([a-z0-9])/g, (_, character: string) => character.toUpperCase());
}

export function toolFieldFlag(input: string): string {
  return input.replace(/[A-Z]/g, (character) => `-${character.toLowerCase()}`);
}

export function applyToolPositionals(params: {
  readonly callableId: string;
  readonly input: ToolClientJsonObject;
  readonly positionals: readonly string[];
  readonly primary?: ToolPrimaryPositional;
  readonly bareBooleanField?: string;
}): ResultType<ToolClientJsonObject, ToolClientArgumentInvalid> {
  const { callableId, input, positionals, primary } = params;
  if (positionals.length === 0) return Result.ok(input);
  if (primary === undefined) {
    return Result.err(unsupportedToolPositionals(callableId, params.bareBooleanField));
  }
  const displayField = toolFieldFlag(primary.field);
  if (primary.variadic !== true && positionals.length > 1) {
    return Result.err(
      new ToolClientArgumentInvalid({
        code: "TOO_MANY_POSITIONAL_ARGUMENTS",
        message: `Tool '${callableId}' accepts at most one positional argument: <${displayField}>.`,
      }),
    );
  }
  if (Object.hasOwn(input, primary.field)) {
    const suffix = primary.variadic === true ? "..." : "";
    return Result.err(
      new ToolClientArgumentInvalid({
        code: "CONFLICTING_POSITIONAL_INPUT",
        message: `Primary positional <${displayField}${suffix}> conflicts with an existing '${primary.field}' value from flags or JSON input.`,
      }),
    );
  }
  return Result.ok({
    ...input,
    [primary.field]: primary.variadic === true ? [...positionals] : (positionals[0] ?? ""),
  });
}

function unsupportedToolPositionals(
  callableId: string,
  bareBooleanField: string | undefined,
): ToolClientArgumentInvalid {
  const bareFlag = bareBooleanField === undefined ? undefined : toolFieldFlag(bareBooleanField);
  const hint =
    bareFlag === undefined
      ? " If you meant to pass a flag value, use --field=<value>."
      : ` Bare --${bareFlag} was parsed as boolean true; if you meant to pass a value, use --${bareFlag}=<value>.`;
  return new ToolClientArgumentInvalid({
    code: "UNSUPPORTED_POSITIONAL_INPUT",
    message: `Tool '${callableId}' does not support positional input.${hint} Space-separated flag values are not supported; use --input JSON or stdin for structured input.`,
  });
}
