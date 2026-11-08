import { isRecord } from "@stanley2058/lilac-utils";
import { z } from "zod";

import { redactSecrets } from "../../../tools/bash-safety/format";
import { bashInputSchema, bashOutputSchema } from "../../../tools/bash";
import {
  editedPathsForDisplay,
  formatToolArgsForDisplayWithSpecs,
} from "../../../tools/tool-args-display";
import { formatToolLogPreview } from "./tool-failure-logging";

export type NativeToolActivityResult = {
  detail?: string;
  output?: string;
  exitCode?: number;
  file?: { path: string; mediaType: string };
};

const LABEL_ARGS_CHARS = 8192;

const READ_TOOLS = new Set(["read", "read_file", "readFile"]);

const OUTPUT_PREVIEW_CHARS = 4_000;

function textContent(result: unknown): string | undefined {
  if (!isRecord(result) || !Array.isArray(result["content"])) return undefined;
  const texts = result["content"].flatMap((item) =>
    isRecord(item) && item["type"] === "text" && typeof item["text"] === "string"
      ? [item["text"]]
      : [],
  );
  return texts.length ? texts.join("\n") : undefined;
}

type BashExecutionError = NonNullable<z.output<typeof bashOutputSchema>["executionError"]>;

function bashExecutionErrorText(error: BashExecutionError): string {
  switch (error.type) {
    case "blocked":
      return `Blocked: ${error.reason}`;
    case "aborted":
      return "Canceled";
    case "timeout":
      return `Timed out after ${Math.round(error.timeoutMs / 1000)}s`;
    case "exception":
      return error.message;
  }
}

function preview(text: string): NativeToolActivityResult {
  const trimmed = text.trim();
  // Redact before truncating so the cut cannot split a secret out of the redactor's reach.
  return trimmed ? { output: redactSecrets(trimmed).slice(0, OUTPUT_PREVIEW_CHARS) } : {};
}

function bashActivityResult(output: z.output<typeof bashOutputSchema>): NativeToolActivityResult {
  const { stdout, stderr, exitCode, executionError } = output;
  const text = [stdout, stderr, executionError && bashExecutionErrorText(executionError)]
    .filter((part) => part?.trim())
    .join("\n");
  return { ...preview(text), exitCode };
}

function readActivityResult(result: Record<string, unknown>): NativeToolActivityResult {
  const error = result["error"];
  if (result["success"] === false && isRecord(error) && typeof error["message"] === "string")
    return preview(error["message"]);
  const path = result["resolvedPath"];
  const mediaType = result["mimeType"];
  if (result["kind"] === "attachment" && typeof path === "string" && typeof mediaType === "string")
    return { file: { path, mediaType } };
  for (const key of ["numberedContent", "hashlineContent"]) {
    const content = result[key];
    if (typeof content === "string") return preview(content);
  }
  return {};
}

export function nativeToolActivityResult(params: {
  toolName: string;
  event: { readonly result: unknown };
}): NativeToolActivityResult {
  const { toolName } = params;
  const result = params.event.result;
  const bash = toolName === "bash" ? bashOutputSchema.safeParse(result) : undefined;
  if (bash?.success) return bashActivityResult(bash.data);
  if (READ_TOOLS.has(toolName) && isRecord(result)) return readActivityResult(result);
  if (result === undefined || result === null) return {};
  if (typeof result === "string") return preview(result);
  const text = textContent(result);
  if (text !== undefined) return preview(text);
  return preview(formatToolLogPreview({ toolName, value: result }));
}

export function nativeToolActivityLabel(params: {
  toolName: string;
  event: { readonly args: unknown };
}): string {
  const args = formatToolArgsForDisplayWithSpecs(
    params.toolName,
    undefined,
    undefined,
    undefined,
    params.event,
    LABEL_ARGS_CHARS,
  );
  return `${params.toolName}${args}`;
}

/**
 * Display labels collapse whitespace and truncate paths, so expanded commands and edited-file
 * counts come from the original arguments.
 */
const syncToolInputSchema = z.looseObject({ mode: z.literal("sync") });

/** Sync subagents and questions hold the run open without doing work of their own. */
export function nativeToolOnlyWaits(params: {
  toolName: string;
  event: { readonly args: unknown };
}): boolean {
  return (
    (params.toolName === "subagent_delegate" || params.toolName === "question") &&
    syncToolInputSchema.safeParse(params.event.args).success
  );
}

export function nativeToolActivityDetail(params: {
  toolName: string;
  event: { readonly args: unknown };
}): NativeToolActivityResult {
  const paths = editedPathsForDisplay(params.toolName, params.event.args);
  if (paths.length) return { detail: `${params.toolName} ${paths.join("\n")}` };
  if (params.toolName !== "bash") return {};
  const input = bashInputSchema.safeParse(params.event.args);
  if (!input.success || !input.data.command.trim()) return {};
  return { detail: `bash ${redactSecrets(input.data.command)}` };
}
