import { redactSecrets } from "../../../tools/bash-safety/format";
import type { Level1ToolFailureSummary, Level1ToolSpec } from "@stanley2058/lilac-plugin-runtime";

const SENSITIVE_KEYS = new Set([
  "authorization",
  "Authorization",
  "apiKey",
  "apikey",
  "token",
  "access",
  "refresh",
  "idToken",
  "code",
  "pkceVerifier",
  "privateKey",
  "privateKeyPem",
  "private_key",
  "pem",
  "keyPath",
  "password",
]);

const DEFAULT_PREVIEW_MAX_CHARS = 4_000;

export type ToolFailureSummary = Level1ToolFailureSummary;

export type BatchChildFailureEntry = {
  index: number;
  toolCallId?: string;
  toolName: string;
  error: string;
  args: unknown;
  result: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getStringField(value: unknown, key: string): string | undefined {
  if (!isRecord(value)) return undefined;
  const v = value[key];
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function getNumberField(value: unknown, key: string): number | undefined {
  if (!isRecord(value)) return undefined;
  const v = value[key];
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function getBooleanField(value: unknown, key: string): boolean | undefined {
  if (!isRecord(value)) return undefined;
  const v = value[key];
  return typeof v === "boolean" ? v : undefined;
}

function toSerializablePreview(value: unknown, maxChars?: number): string {
  const seen = new WeakSet<object>();

  let raw = "";
  try {
    raw = JSON.stringify(value, (key, nested) => {
      if (SENSITIVE_KEYS.has(key)) return "<redacted>";

      if (nested instanceof Error) {
        return {
          name: nested.name,
          message: nested.message,
          stack: nested.stack,
        };
      }

      if (typeof nested === "bigint") {
        return nested.toString();
      }

      if (isRecord(nested)) {
        if (seen.has(nested)) return "<circular>";
        seen.add(nested);
      }

      return nested;
    });
  } catch {
    raw = String(value);
  }

  const redacted = redactSecrets(raw);
  if (maxChars === undefined || maxChars <= 0) return redacted;
  if (redacted.length <= maxChars) return redacted;
  return `${redacted.slice(0, maxChars)}...`;
}

function oneLine(input: string): string {
  return input.replace(/\s+/g, " ").trim();
}

function defaultErrorFromResult(result: unknown): string {
  if (typeof result === "string" && result.length > 0) return result;
  if (result instanceof Error) return result.message;

  const message = getStringField(result, "message");
  if (message) return message;

  return oneLine(toSerializablePreview(result, 500));
}

function summarizeBashFailure(result: unknown): ToolFailureSummary {
  const executionError = isRecord(result) ? result["executionError"] : undefined;
  const exitCode = getNumberField(result, "exitCode");

  if (executionError !== undefined) {
    return {
      ok: false,
      failureKind: "hard",
      error: `bash execution error: ${oneLine(toSerializablePreview(executionError, 500))}`,
    };
  }

  if (typeof exitCode === "number" && exitCode !== 0) {
    return {
      ok: false,
      failureKind: "soft",
      error: `bash exited with code ${exitCode}`,
    };
  }

  return { ok: true };
}

function summarizeReadOrEditFailure(result: unknown, toolName: string): ToolFailureSummary {
  const success = getBooleanField(result, "success");
  if (success === false) {
    const error = isRecord(result) ? result["error"] : undefined;
    const message = getStringField(error, "message");
    return {
      ok: false,
      failureKind: "soft",
      error: message ?? `${toolName} failed`,
    };
  }
  return { ok: true };
}

function summarizeSearchFailure(result: unknown, toolName: string): ToolFailureSummary {
  const error = getStringField(result, "error");
  if (error) {
    return {
      ok: false,
      failureKind: "soft",
      error: `${toolName} failed: ${error}`,
    };
  }
  return { ok: true };
}

function summarizeApplyPatchFailure(result: unknown): ToolFailureSummary {
  const status = getStringField(result, "status");
  if (status === "failed") {
    const output = getStringField(result, "output");
    return {
      ok: false,
      failureKind: "soft",
      error: output ?? "apply_patch failed",
    };
  }
  return { ok: true };
}

function summarizeBatchFailure(result: unknown): ToolFailureSummary {
  const ok = getBooleanField(result, "ok");
  if (ok === false) {
    const failed = getNumberField(result, "failed");
    const total = getNumberField(result, "total");
    const suffix =
      typeof failed === "number" && typeof total === "number" ? ` (${failed}/${total} failed)` : "";
    return {
      ok: false,
      failureKind: "soft",
      error: `batch failed${suffix}`,
    };
  }
  return { ok: true };
}

function summarizeSubagentFailure(result: unknown): ToolFailureSummary {
  const ok = getBooleanField(result, "ok");
  if (ok === false) {
    const detail = getStringField(result, "detail");
    const status = getStringField(result, "status");
    return {
      ok: false,
      failureKind: "soft",
      error: detail ?? (status ? `subagent ${status}` : "subagent failed"),
    };
  }
  return { ok: true };
}

export const BUILTIN_LEVEL1_TOOL_FAILURE_SUMMARIZERS: Record<
  string,
  (result: unknown) => ToolFailureSummary
> = {
  bash: summarizeBashFailure,
  read_file: (result) => summarizeReadOrEditFailure(result, "read_file"),
  edit_file: (result) => summarizeReadOrEditFailure(result, "edit_file"),
  glob: (result) => summarizeSearchFailure(result, "glob"),
  grep: (result) => summarizeSearchFailure(result, "grep"),
  apply_patch: summarizeApplyPatchFailure,
  batch: summarizeBatchFailure,
  subagent_delegate: summarizeSubagentFailure,
};

export function summarizeToolFailure(params: {
  toolName: string;
  isError: boolean;
  result: unknown;
  toolSpecs?: ReadonlyMap<string, Level1ToolSpec<unknown>>;
}): ToolFailureSummary {
  const { toolName, isError, result, toolSpecs } = params;

  if (isError) {
    return {
      ok: false,
      failureKind: "hard",
      error: defaultErrorFromResult(result),
    };
  }

  const specSummary = toolSpecs?.get(toolName)?.summarizeFailure;
  if (specSummary) {
    return specSummary({ isError: false, result });
  }

  const builtin = BUILTIN_LEVEL1_TOOL_FAILURE_SUMMARIZERS[toolName];
  return builtin ? builtin(result) : { ok: true };
}

export function formatToolLogPreview(params: {
  toolName: string;
  value: unknown;
  untruncated?: boolean;
}): string {
  const { toolName, value, untruncated } = params;
  const maxChars = untruncated || toolName === "batch" ? undefined : DEFAULT_PREVIEW_MAX_CHARS;
  return toSerializablePreview(value, maxChars);
}

export function extractBatchChildFailureEntries(params: {
  args: unknown;
  result: unknown;
}): BatchChildFailureEntry[] {
  if (!isRecord(params.result)) return [];

  const rawResults = params.result["results"];
  if (!Array.isArray(rawResults)) return [];

  const rawCalls = isRecord(params.args) ? params.args["tool_calls"] : undefined;
  const calls = Array.isArray(rawCalls) ? rawCalls : [];

  const out: BatchChildFailureEntry[] = [];
  for (let i = 0; i < rawResults.length; i++) {
    const resultItem = rawResults[i];
    const itemOk = getBooleanField(resultItem, "ok");
    if (itemOk !== false) continue;

    const call = calls[i];
    const toolFromResult = getStringField(resultItem, "tool");
    const toolFromCall = getStringField(call, "tool");
    const toolName = toolFromResult ?? toolFromCall ?? "unknown";

    const error =
      getStringField(resultItem, "error") ??
      getStringField(resultItem, "output") ??
      "batch child failed";

    const args = isRecord(call) && "parameters" in call ? call["parameters"] : call;

    out.push({
      index: i,
      toolCallId: getStringField(resultItem, "toolCallId"),
      toolName,
      error,
      args,
      result: resultItem,
    });
  }

  return out;
}
