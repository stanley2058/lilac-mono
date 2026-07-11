import { createLogger, type CoreConfig } from "@stanley2058/lilac-utils";
import type { NormalizeToolResultOutputFn, ToolResultOutput } from "@stanley2058/lilac-agent";
import { stripVTControlCharacters } from "node:util";

import type { ToolResultArtifactStore } from "./tool-result-artifact-store";
import { redactSecrets } from "../tools/bash-safety/format";

const TRUNCATION_MARKER = "[tool result truncated:";
const GENERATED_TRUNCATION_ENVELOPE =
  /^(?<head>[\s\S]*)\n\n\[tool result truncated: \d+ characters omitted\]\n(?:Complete output: tool-result:\/\/[0-9a-f-]{36}\nUse read_file with this URI and start: \{ "type": "offset", "offset": 0 \}\. Reuse the returned nextStart unchanged while more content remains\.|The complete output could not be retained\. Re-run the tool with narrower output if needed\.)\n\n(?<tail>[\s\S]*)$/u;
const UNSERIALIZABLE_JSON_OUTPUT = "[tool result is not JSON-serializable]";

type NormalizerOwner = {
  sessionId: string;
  requestId: string;
};

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function sanitizeText(value: string): string {
  const withoutTerminalControls = stripVTControlCharacters(value);
  const withoutUnsafeControls = Array.from(withoutTerminalControls)
    .filter((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code === 0x09 || code === 0x0a || code >= 0x20;
    })
    .join("");
  return redactSecrets(withoutUnsafeControls);
}

function buildTruncatedText(value: string, maxPreviewBytes: number, uri?: string): string {
  const head = takeUtf8Prefix(value, Math.ceil(maxPreviewBytes / 2));
  const tail = takeUtf8Suffix(value, Math.floor(maxPreviewBytes / 2));
  const omittedCharacters = Math.max(
    0,
    Array.from(value).length - Array.from(head).length - Array.from(tail).length,
  );
  const retrieval = uri
    ? `Complete output: ${uri}\nUse read_file with this URI and start: { "type": "offset", "offset": 0 }. Reuse the returned nextStart unchanged while more content remains.`
    : "The complete output could not be retained. Re-run the tool with narrower output if needed.";

  return `${head}\n\n${TRUNCATION_MARKER} ${omittedCharacters} characters omitted]\n${retrieval}\n\n${tail}`;
}

function isGeneratedTruncationEnvelope(value: string, maxPreviewBytes: number): boolean {
  const match = GENERATED_TRUNCATION_ENVELOPE.exec(value);
  if (!match?.groups) return false;
  return (
    utf8Bytes(match.groups["head"] ?? "") + utf8Bytes(match.groups["tail"] ?? "") <= maxPreviewBytes
  );
}

function takeUtf8Prefix(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  let bytes = 0;
  let output = "";
  for (const character of value) {
    const characterBytes = utf8Bytes(character);
    if (bytes + characterBytes > maxBytes) break;
    output += character;
    bytes += characterBytes;
  }
  return output;
}

function takeUtf8Suffix(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  const characters = Array.from(value);
  let bytes = 0;
  let output = "";
  for (let index = characters.length - 1; index >= 0; index -= 1) {
    const character = characters[index]!;
    const characterBytes = utf8Bytes(character);
    if (bytes + characterBytes > maxBytes) break;
    output = character + output;
    bytes += characterBytes;
  }
  return output;
}

export function createToolResultOutputNormalizer(params: {
  artifacts?: ToolResultArtifactStore;
  owner: NormalizerOwner;
  getOutputConfig: () => CoreConfig["tools"]["output"];
}): NormalizeToolResultOutputFn {
  const logger = createLogger({ module: "tool-result-output" });

  async function normalizeText(
    value: string,
    context: { toolCallId: string; toolName: string },
  ): Promise<string> {
    value = sanitizeText(value);
    const config = params.getOutputConfig();
    if (
      utf8Bytes(value) <= config.maxPreviewBytes ||
      isGeneratedTruncationEnvelope(value, config.maxPreviewBytes)
    ) {
      return value;
    }

    let uri: string | undefined;
    try {
      const artifact = await params.artifacts?.create({
        ...params.owner,
        ...context,
        content: value,
        ttlMs: config.artifactTtlMs,
        maxBytesPerSession: config.artifactMaxBytesPerSession,
      });
      uri = artifact?.uri;
    } catch (error) {
      logger.warn("tool.artifact.write_failed", {
        toolName: context.toolName,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    const head = takeUtf8Prefix(value, Math.ceil(config.maxPreviewBytes / 2));
    const tail = takeUtf8Suffix(value, Math.floor(config.maxPreviewBytes / 2));

    logger.info("tool.result.truncated", {
      toolName: context.toolName,
      originalBytes: utf8Bytes(value),
      previewBytes: utf8Bytes(head) + utf8Bytes(tail),
      originalCharacters: Array.from(value).length,
      previewCharacters: Array.from(head).length + Array.from(tail).length,
      artifactStored: uri !== undefined,
    });

    return buildTruncatedText(value, config.maxPreviewBytes, uri);
  }

  return async (output, context) => {
    if (
      context.bypassGenericOutputNormalizer === true &&
      context.toolName === "subagent_delegate" &&
      (output.type === "json" || output.type === "error-json") &&
      output.value !== null &&
      typeof output.value === "object" &&
      !Array.isArray(output.value) &&
      typeof output.value.finalText === "string"
    ) {
      return {
        ...output,
        value: {
          ...output.value,
          finalText: await normalizeText(output.value.finalText, {
            toolCallId: context.toolCallId,
            toolName: "subagent_result",
          }),
        },
      };
    }
    if (context.bypassGenericOutputNormalizer === true) return output;

    if (output.type === "text" || output.type === "error-text") {
      return { ...output, value: await normalizeText(output.value, context) };
    }

    if (output.type === "execution-denied") {
      if (!output.reason) return output;
      return { ...output, reason: await normalizeText(output.reason, context) };
    }

    if (output.type === "json" || output.type === "error-json") {
      let serialized: string | undefined;
      try {
        serialized = JSON.stringify(output.value, null, 2);
      } catch {
        serialized = undefined;
      }
      if (serialized === undefined) {
        return output.type === "error-json"
          ? { type: "error-text", value: UNSERIALIZABLE_JSON_OUTPUT }
          : { type: "text", value: UNSERIALIZABLE_JSON_OUTPUT };
      }
      if (utf8Bytes(serialized) <= params.getOutputConfig().maxPreviewBytes) {
        return output;
      }
      const preview = await normalizeText(serialized, context);
      return output.type === "error-json"
        ? { type: "error-text", value: preview }
        : { type: "text", value: preview };
    }

    if (output.type === "content") {
      const textParts = output.value.filter((part) => part.type === "text");
      const combinedText = textParts.map((part) => part.text).join("\n\n");
      if (utf8Bytes(combinedText) <= params.getOutputConfig().maxPreviewBytes) return output;
      const normalizedText = await normalizeText(combinedText, context);
      let insertedText = false;
      const value: typeof output.value = [];
      for (const part of output.value) {
        if (part.type !== "text") {
          value.push(part);
          continue;
        }
        if (insertedText) continue;
        insertedText = true;
        value.push({ ...part, text: normalizedText });
      }
      return { ...output, value };
    }

    return output;
  };
}

export function normalizeSubagentFinalTextForSnapshot(
  finalText: string,
  maxPreviewBytes: number,
): string {
  const sanitized = sanitizeText(finalText);
  if (
    utf8Bytes(sanitized) <= maxPreviewBytes ||
    isGeneratedTruncationEnvelope(sanitized, maxPreviewBytes)
  ) {
    return sanitized;
  }
  return buildTruncatedText(sanitized, maxPreviewBytes);
}

export async function normalizeSubagentFinalText(params: {
  normalize: NormalizeToolResultOutputFn;
  finalText: string;
  toolCallId: string;
}): Promise<string> {
  const normalized = await params.normalize(
    { type: "text", value: params.finalText },
    { toolCallId: params.toolCallId, toolName: "subagent_result" },
  );
  return normalized.type === "text" ? normalized.value : params.finalText;
}

export type { ToolResultOutput };
