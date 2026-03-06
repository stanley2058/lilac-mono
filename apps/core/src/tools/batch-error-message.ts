import { ZodError } from "zod";

type BatchChildValidationErrorParams = {
  childIndex: number;
  toolName: string;
  parameters: unknown;
  error: unknown;
};

type BatchPreflightMissingFieldErrorParams = {
  childIndex: number;
  toolName: string;
  field: string;
  expectedType: string;
  parameters?: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function oneLine(input: string): string {
  return input.replace(/\s+/g, " ").trim();
}

function truncate(input: string, maxChars: number): string {
  if (input.length <= maxChars) return input;
  if (maxChars <= 3) return "...".slice(0, maxChars);
  return `${input.slice(0, maxChars - 3)}...`;
}

function summarizeProvidedKeys(parameters: unknown): string {
  if (!isRecord(parameters)) return "(parameters is not an object)";

  const keys = Object.keys(parameters);
  if (keys.length === 0) return "(none)";

  const shown = keys.slice(0, 6).join(", ");
  return keys.length > 6 ? `${shown}, ...` : shown;
}

function isEmptyObjectParameters(parameters: unknown): boolean {
  if (!isRecord(parameters)) return false;
  return Object.keys(parameters).length === 0;
}

function collectLikelyFieldPaths(error: ZodError): string[] {
  const paths = new Set<string>();
  for (const issue of error.issues) {
    if (issue.path.length === 0) continue;
    const p = issue.path.map((segment) => String(segment)).join(".");
    if (p.length > 0) paths.add(p);
  }
  return [...paths];
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export function formatBatchPreflightMissingFieldError(
  params: BatchPreflightMissingFieldErrorParams,
): string {
  const providedKeys = summarizeProvidedKeys(params.parameters);
  const lines = [
    `batch child #${params.childIndex} (${params.toolName}) is missing required parameter: ${params.field} (${params.expectedType}).`,
    `Provided keys: ${providedKeys}`,
    `Fix: include all required ${params.toolName} fields and retry this batch call.`,
  ];

  if (isEmptyObjectParameters(params.parameters)) {
    lines.splice(2, 0, "Hint: parameters object is empty.");
  }

  return lines.join("\n");
}

export function formatBatchChildValidationError(params: BatchChildValidationErrorParams): string {
  const prefix = `batch child #${params.childIndex} (${params.toolName}) has invalid parameters.`;
  const providedKeys = summarizeProvidedKeys(params.parameters);

  if (params.error instanceof ZodError) {
    const fields = collectLikelyFieldPaths(params.error);
    const fieldSummary = fields.length > 0 ? fields.join(", ") : "(unknown)";

    return [
      prefix,
      `Missing or invalid fields: ${fieldSummary}`,
      `Provided keys: ${providedKeys}`,
      ...(isEmptyObjectParameters(params.parameters) ? ["Hint: parameters object is empty."] : []),
      `Fix: include all required ${params.toolName} fields and retry this batch call.`,
    ].join("\n");
  }

  const detail = truncate(oneLine(toErrorMessage(params.error)), 300);
  return [
    prefix,
    `Provided keys: ${providedKeys}`,
    ...(isEmptyObjectParameters(params.parameters) ? ["Hint: parameters object is empty."] : []),
    `Fix: include all required ${params.toolName} fields and retry this batch call.`,
    `Details: ${detail}`,
  ].join("\n");
}
