import { createLogger } from "@stanley2058/lilac-utils";
import type { ToolModelMessage } from "ai";
import { stripVTControlCharacters } from "node:util";

import type { ToolResultArtifactStore } from "./tool-result-artifact-store";

const GENERATED_OVERFLOW_REFERENCE =
  /^\[tool result overflow\]\nThe tool completed, but its output exceeded the inline limit\.\n(?:Complete captured output: tool-result:\/\/[0-9a-f-]{36}\nUse read_file with this URI and start: \{ "type": "offset", "offset": 0 \}\. Reuse nextStart unchanged while more content remains\. Do not re-run the original tool\.|The complete output could not be retained\. Narrow the request or re-run the tool\.)$/u;
const UNSERIALIZABLE_JSON_OUTPUT = "[tool result is not JSON-serializable]";

export type ToolResultOutput = Extract<
  ToolModelMessage["content"][number],
  { type: "tool-result" }
>["output"];

export type NormalizeToolResultOutputFn = (
  output: ToolResultOutput,
  context: { toolCallId: string; toolName: string },
) => ToolResultOutput | Promise<ToolResultOutput>;

export type ToolResultOutputNormalizerConfig = {
  maxInlineBytes: number;
  artifactTtlMs: number;
  maxArtifactBytesPerScope: number;
  maxArtifactBytes?: number;
};

export type LegacyToolResultOutputNormalizerConfig = {
  maxPreviewBytes: number;
  artifactTtlMs: number;
  artifactMaxBytesPerSession: number;
  maxArtifactBytes?: number;
};

export type ToolResultOutputNormalizerOwner = (
  | { scopeId: string; sessionId?: string }
  | { scopeId?: string; sessionId: string }
) & { requestId: string };

export type ToolResultOutputNormalizerOptions = {
  artifacts?: ToolResultArtifactStore;
  owner: ToolResultOutputNormalizerOwner;
  getOutputConfig: () => ToolResultOutputNormalizerConfig | LegacyToolResultOutputNormalizerConfig;
  sanitize?: (value: string) => string;
};

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function removeUnsafeControls(value: string): string {
  const withoutTerminalControls = stripVTControlCharacters(value);
  const withoutUnsafeControls = Array.from(withoutTerminalControls)
    .filter((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code === 0x09 || code === 0x0a || code >= 0x20;
    })
    .join("");
  return withoutUnsafeControls
    .replace(
      /\b([A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASS|KEY|CREDENTIALS)[A-Z0-9_]*)=([^\s]+)/giu,
      "$1=<redacted>",
    )
    .replace(/(['"]?\s*authorization\s*:\s*)([^'"\n]+)(['"]?)/giu, "$1<redacted>$3")
    .replace(/(https?:\/\/)([^\s/:@]+):([^\s@]+)@/giu, "$1<redacted>:<redacted>@")
    .replace(
      /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{8,}|sk-[A-Za-z0-9_-]{8,}|AIza[A-Za-z0-9_-]{8,})\b/gu,
      "<redacted>",
    );
}

function buildOverflowReference(uri?: string): string {
  return uri
    ? `[tool result overflow]\nThe tool completed, but its output exceeded the inline limit.\nComplete captured output: ${uri}\nUse read_file with this URI and start: { "type": "offset", "offset": 0 }. Reuse nextStart unchanged while more content remains. Do not re-run the original tool.`
    : "[tool result overflow]\nThe tool completed, but its output exceeded the inline limit.\nThe complete output could not be retained. Narrow the request or re-run the tool.";
}

function resolveConfig(
  config: ToolResultOutputNormalizerConfig | LegacyToolResultOutputNormalizerConfig,
): ToolResultOutputNormalizerConfig {
  if ("maxInlineBytes" in config) return config;
  return {
    maxInlineBytes: config.maxPreviewBytes,
    artifactTtlMs: config.artifactTtlMs,
    maxArtifactBytesPerScope: config.artifactMaxBytesPerSession,
    ...(config.maxArtifactBytes === undefined ? {} : { maxArtifactBytes: config.maxArtifactBytes }),
  };
}

function ownerScopeId(owner: ToolResultOutputNormalizerOwner): string {
  const scopeId = owner.scopeId ?? owner.sessionId;
  if (!scopeId) throw new Error("Tool result normalizer owner scopeId is required");
  return scopeId;
}

export function createOverflowReferenceNormalizer(
  params: ToolResultOutputNormalizerOptions,
): NormalizeToolResultOutputFn {
  const logger = createLogger({ module: "tool-result-output" });

  async function normalizeCapturedText(
    value: string,
    context: { toolCallId: string; toolName: string },
  ): Promise<{ value: string; overflow: boolean }> {
    if (GENERATED_OVERFLOW_REFERENCE.test(value)) return { value, overflow: true };
    const config = resolveConfig(params.getOutputConfig());
    const overflow = utf8Bytes(value) > config.maxInlineBytes;
    value = removeUnsafeControls(value);
    if (params.sanitize) value = removeUnsafeControls(params.sanitize(value));
    if (!overflow) return { value, overflow: false };

    let uri: string | undefined;
    try {
      const artifact = await params.artifacts?.create({
        scopeId: ownerScopeId(params.owner),
        requestId: params.owner.requestId,
        ...context,
        content: value,
        ttlMs: config.artifactTtlMs,
        maxBytesPerScope: config.maxArtifactBytesPerScope,
        ...(config.maxArtifactBytes === undefined
          ? {}
          : { maxArtifactBytes: config.maxArtifactBytes }),
      });
      uri = artifact?.uri;
    } catch (error) {
      logger.warn("tool.artifact.write_failed", {
        toolName: context.toolName,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    logger.info("tool.result.overflow", {
      toolName: context.toolName,
      originalBytes: utf8Bytes(value),
      artifactStored: uri !== undefined,
    });

    return { value: buildOverflowReference(uri), overflow: true };
  }

  return async (output, context) => {
    if (output.type === "text" || output.type === "error-text") {
      const normalized = await normalizeCapturedText(output.value, context);
      if (!normalized.overflow) return { ...output, value: normalized.value };
      return { type: "error-text", value: normalized.value };
    }

    if (output.type === "execution-denied") {
      if (!output.reason) return output;
      const normalized = await normalizeCapturedText(output.reason, context);
      return { ...output, reason: normalized.value };
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
      if (utf8Bytes(serialized) <= resolveConfig(params.getOutputConfig()).maxInlineBytes) {
        return output;
      }
      const reference = await normalizeCapturedText(serialized, context);
      return { type: "error-text", value: reference.value };
    }

    if (output.type === "content") {
      let serialized: string | undefined;
      try {
        serialized = JSON.stringify(output.value, null, 2);
      } catch {
        serialized = undefined;
      }
      if (serialized === undefined)
        return { type: "error-text", value: UNSERIALIZABLE_JSON_OUTPUT };
      if (utf8Bytes(serialized) <= resolveConfig(params.getOutputConfig()).maxInlineBytes) {
        return output;
      }
      const reference = await normalizeCapturedText(serialized, context);
      return { type: "error-text", value: reference.value };
    }

    return output;
  };
}

export const createToolResultOutputNormalizer = createOverflowReferenceNormalizer;
