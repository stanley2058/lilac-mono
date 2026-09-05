import { ZodError } from "zod";
import type { output, ZodType } from "zod";
import { errorMessage as toErrorMessage, isRecord } from "@stanley2058/lilac-utils/runtime-utils";
import { Result, type Result as ResultType } from "better-result";

export type ToolValidationErrorParams = {
  callableId: string;
  input: unknown;
  error: unknown;
};

export class ToolInputValidationError extends Error {
  readonly callableId: string;
  override readonly cause: ZodError;

  constructor(params: { callableId: string; input: unknown; cause: ZodError }) {
    super(
      formatToolValidationError({
        callableId: params.callableId,
        input: params.input,
        error: params.cause,
      }),
    );
    this.name = "ToolInputValidationError";
    this.callableId = params.callableId;
    this.cause = params.cause;
    Object.defineProperty(this, "cause", { enumerable: false });
  }
}

function summarizeProvidedKeys(input: unknown): string {
  if (!isRecord(input)) return "(input is not an object)";

  const keys = Object.keys(input);
  if (keys.length === 0) return "(none)";

  const shown = keys.slice(0, 6).join(", ");
  return keys.length > 6 ? `${shown}, ...` : shown;
}

function isEmptyObjectInput(input: unknown): boolean {
  if (!isRecord(input)) return false;
  return Object.keys(input).length === 0;
}

function collectLikelyFieldPaths(error: ZodError): string[] {
  const paths = new Set<string>();

  for (const issue of error.issues) {
    if (issue.path.length === 0) continue;
    const path = issue.path.map((segment) => String(segment)).join(".");
    if (path.length > 0) paths.add(path);
  }

  return [...paths];
}

export function formatToolValidationError(params: ToolValidationErrorParams): string {
  const providedKeys = summarizeProvidedKeys(params.input);

  if (params.error instanceof ZodError) {
    const fields = collectLikelyFieldPaths(params.error);
    const fieldSummary = fields.length > 0 ? fields.join(", ") : "(unknown)";

    return [
      `${params.callableId} has invalid input.`,
      `Missing or invalid fields: ${fieldSummary}`,
      `Provided keys: ${providedKeys}`,
      ...(isEmptyObjectInput(params.input) ? ["Hint: input object is empty."] : []),
      `Run 'tools --help ${params.callableId}' for details.`,
    ].join("\n");
  }

  return [
    `${params.callableId} failed: ${toErrorMessage(params.error)}`,
    `Provided keys: ${providedKeys}`,
    ...(isEmptyObjectInput(params.input) ? ["Hint: input object is empty."] : []),
    `Run 'tools --help ${params.callableId}' for details.`,
  ].join("\n");
}

export function decodeToolInput<TSchema extends ZodType>(params: {
  callableId: string;
  input: unknown;
  schema: TSchema;
}): ResultType<output<TSchema>, ToolInputValidationError> {
  const decoded = params.schema.safeParse(params.input);
  if (decoded.success) return Result.ok(decoded.data);
  return Result.err(
    new ToolInputValidationError({
      callableId: params.callableId,
      input: params.input,
      cause: decoded.error,
    }),
  );
}

export function adaptToolInputResultToServerToolHost<T>(
  result: ResultType<T, ToolInputValidationError>,
): T {
  const resolved = result.match<
    { readonly value: T } | { readonly error: ToolInputValidationError }
  >({
    ok: (value) => ({ value }),
    err: (error) => ({ error }),
  });
  if ("error" in resolved) throw resolved.error;
  return resolved.value;
}

export function adaptToolInputResultToZodHost<T>(
  result: ResultType<T, ToolInputValidationError>,
): T {
  const resolved = result.match<
    { readonly value: T } | { readonly error: ToolInputValidationError }
  >({
    ok: (value) => ({ value }),
    err: (error) => ({ error }),
  });
  if ("error" in resolved) throw resolved.error.cause;
  return resolved.value;
}

export function parseToolInput<TSchema extends ZodType>(params: {
  callableId: string;
  input: unknown;
  schema: TSchema;
}): output<TSchema> {
  return adaptToolInputResultToServerToolHost(decodeToolInput(params));
}

export function parseToolInputPreservingZodError<TSchema extends ZodType>(params: {
  callableId: string;
  input: unknown;
  schema: TSchema;
}): output<TSchema> {
  return adaptToolInputResultToZodHost(decodeToolInput(params));
}
