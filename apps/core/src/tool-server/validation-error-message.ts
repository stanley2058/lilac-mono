import { ZodError } from "zod";
import type { ZodType } from "zod";

type ToolValidationErrorParams = {
  callableId: string;
  input: unknown;
  error: unknown;
};

export class ToolInputValidationError extends Error {
  readonly callableId: string;
  readonly input: unknown;
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
    this.input = params.input;
    this.cause = params.cause;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
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

export function parseToolInput<T>(params: {
  callableId: string;
  input: unknown;
  schema: ZodType<T>;
}): T {
  try {
    return params.schema.parse(params.input);
  } catch (error) {
    if (error instanceof ZodError) {
      throw new ToolInputValidationError({
        callableId: params.callableId,
        input: params.input,
        cause: error,
      });
    }

    throw error;
  }
}
