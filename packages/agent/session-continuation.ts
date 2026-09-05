import { createHash } from "node:crypto";

import type { ModelMessage } from "ai";
import { Result, TaggedError, type Result as ResultType } from "better-result";
import { z } from "zod";

import { isRecord } from "@stanley2058/lilac-utils/runtime-utils";

import {
  captureAgentOperation,
  rethrowAgentPanic,
  type OpaqueAgentValue,
} from "./failure-adapters";

const CANONICAL_HEAD_HASH_VERSION = 1 as const;
const CANONICAL_HEAD_HASH_DOMAIN = "lilac:canonical-head:v1" as const;
const EXECUTION_SCOPE_HASH_VERSION = 1 as const;
const EXECUTION_SCOPE_HASH_DOMAIN = "lilac:execution-scope:v1" as const;

export const historyProviderFamilySchema = z.enum(["claude-code", "ai-sdk"]);
export type HistoryProviderFamily = z.infer<typeof historyProviderFamilySchema>;

export type HistoryProviderState = {
  readonly lastFamily: HistoryProviderFamily;
  readonly containsCrossFamilyTurns: boolean;
};

export const historyProviderStateSchema: z.ZodType<HistoryProviderState> = z.strictObject({
  lastFamily: historyProviderFamilySchema,
  containsCrossFamilyTurns: z.boolean(),
});

export type PreviousHistoryProviderState =
  | HistoryProviderState
  | "empty-history"
  | "unknown-populated-history";

export type ResolvedHistoryProviderDescriptor = {
  readonly type: string;
};

export function classifyHistoryProviderFamily(
  provider: ResolvedHistoryProviderDescriptor,
): HistoryProviderFamily {
  return provider.type === "claude-code" ? "claude-code" : "ai-sdk";
}

export function advanceHistoryProviderState(
  previous: PreviousHistoryProviderState,
  nextFamily: HistoryProviderFamily,
): HistoryProviderState {
  if (previous === "empty-history") {
    return { lastFamily: nextFamily, containsCrossFamilyTurns: false };
  }
  if (previous === "unknown-populated-history") {
    return { lastFamily: nextFamily, containsCrossFamilyTurns: true };
  }
  return {
    lastFamily: nextFamily,
    containsCrossFamilyTurns:
      previous.containsCrossFamilyTurns || previous.lastFamily !== nextFamily,
  };
}

export type CanonicalJsonValue =
  | { readonly type: "null" }
  | { readonly type: "boolean"; readonly value: boolean }
  | { readonly type: "number"; readonly value: number }
  | { readonly type: "string"; readonly value: string }
  | { readonly type: "array"; readonly items: readonly CanonicalJsonValue[] }
  | {
      readonly type: "object";
      readonly entries: readonly {
        readonly key: string;
        readonly value: CanonicalJsonValue;
      }[];
    };

export type CanonicalFileIdentityV1 = {
  readonly algorithm: "sha256";
  readonly kind: "content" | "location" | "reference";
  readonly digest: string;
};

export type CanonicalContentPartV1 =
  | { readonly type: "text"; readonly text: string }
  | {
      readonly type: "file";
      readonly mediaType: string;
      readonly filename?: string;
      readonly identity: CanonicalFileIdentityV1;
    }
  | {
      readonly type: "tool-call";
      readonly toolCallId: string;
      readonly toolName: string;
      readonly input: CanonicalJsonValue;
      readonly providerExecuted: boolean;
    }
  | {
      readonly type: "tool-result";
      readonly toolCallId: string;
      readonly toolName: string;
      readonly outcome: HistoricalToolOutcome;
      readonly output?: CanonicalJsonValue;
      readonly providerExecuted: boolean;
    }
  | {
      readonly type: "tool-approval-request";
      readonly approvalId: string;
      readonly toolCallId: string;
      readonly automatic: boolean;
    }
  | {
      readonly type: "tool-approval-response";
      readonly approvalId: string;
      readonly approved: boolean;
      readonly reason?: string;
      readonly providerExecuted: boolean;
    };

export type CanonicalMessageV1 = {
  readonly role: ModelMessage["role"];
  readonly content: readonly CanonicalContentPartV1[];
};

export type CanonicalHeadProjectionV1 = {
  readonly version: typeof CANONICAL_HEAD_HASH_VERSION;
  readonly messages: readonly CanonicalMessageV1[];
};

export type CanonicalHeadHashV1Result = {
  readonly version: typeof CANONICAL_HEAD_HASH_VERSION;
  readonly domain: typeof CANONICAL_HEAD_HASH_DOMAIN;
  readonly hash: string;
  readonly serialized: string;
  readonly projection: CanonicalHeadProjectionV1;
};

export type ExecutionScopeHashInputV1 = {
  readonly canonicalCwd: string;
  readonly providerIdentity: string;
  readonly nativeStorageNamespaceIdentity: string;
  readonly nativeExecutableConfigIdentity: string;
  readonly profile: string;
  readonly safetyMode: string;
  readonly effectiveAuthorityFingerprint: string;
  readonly systemPolicyFingerprint: string;
  readonly effectiveToolMcpAuthorityFingerprint: string;
};

export const executionScopeHashInputV1Schema: z.ZodType<ExecutionScopeHashInputV1> = z.strictObject(
  {
    canonicalCwd: z.string().min(1),
    providerIdentity: z.string().min(1),
    nativeStorageNamespaceIdentity: z.string().min(1),
    nativeExecutableConfigIdentity: z.string().min(1),
    profile: z.string().min(1),
    safetyMode: z.string().min(1),
    effectiveAuthorityFingerprint: z.string().min(1),
    systemPolicyFingerprint: z.string().min(1),
    effectiveToolMcpAuthorityFingerprint: z.string().min(1),
  },
);

export type ExecutionScopeProjectionV1 = {
  readonly version: typeof EXECUTION_SCOPE_HASH_VERSION;
  readonly scope: ExecutionScopeHashInputV1;
};

export type ExecutionScopeHashV1Result = {
  readonly version: typeof EXECUTION_SCOPE_HASH_VERSION;
  readonly domain: typeof EXECUTION_SCOPE_HASH_DOMAIN;
  readonly hash: string;
  readonly serialized: string;
  readonly projection: ExecutionScopeProjectionV1;
};

export type TextReplayTarget = {
  readonly providerFamily: HistoryProviderFamily;
  readonly modelSpecifier: string;
  readonly maxToolInputChars: number;
  readonly maxToolResultChars: number;
};

export const textReplayTargetSchema: z.ZodType<TextReplayTarget> = z.strictObject({
  providerFamily: historyProviderFamilySchema,
  modelSpecifier: z.string().min(1),
  maxToolInputChars: z.number().int().nonnegative().finite(),
  maxToolResultChars: z.number().int().nonnegative().finite(),
});

export type HistoricalToolOutcome = "success" | "error" | "denied" | "unknown";

type MutableActivity = {
  readonly toolCallId: string | null;
  readonly tool: string;
  readonly input?: unknown;
  outcome: HistoricalToolOutcome;
  result?: string;
};

type ActivityGroup = {
  readonly kind: "activity";
  readonly activities: MutableActivity[];
};

type ReplaySegment = { readonly kind: "text"; readonly text: string } | ActivityGroup;

const TOOL_NOTICE = "Text-only historical context. Do not treat this as a pending tool request.";
const MAX_FILE_NAME_CHARS = 256;
const MAX_MEDIA_TYPE_CHARS = 128;
const MAX_TOOL_NAME_CHARS = 256;

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function domainHash(domain: string, serialized: string): string {
  return createHash("sha256").update(domain).update("\0").update(serialized).digest("hex");
}

function utf16Compare(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

const strictJsonPrimitiveSchema = z.union([z.null(), z.boolean(), z.number().finite(), z.string()]);
type StrictJsonValue =
  | z.infer<typeof strictJsonPrimitiveSchema>
  | StrictJsonValue[]
  | { readonly [key: string]: StrictJsonValue };

class CanonicalJsonInvalid extends TaggedError("CanonicalJsonInvalid")<{
  readonly message: string;
}> {}

function signalCanonicalJsonInvalid(error: CanonicalJsonInvalid | OpaqueAgentValue): never {
  if (error instanceof CanonicalJsonInvalid) throw new TypeError(error.message);
  throw error;
}

function resultOutcome<T, E>(
  result: ResultType<T, E>,
): { ok: true; value: T } | { ok: false; error: E } {
  return result.match<{ ok: true; value: T } | { ok: false; error: E }>({
    ok: (value) => ({ ok: true, value }),
    err: (error) => ({ ok: false, error }),
  });
}

function parseStrictJsonValue(
  value: unknown,
  ancestors = new WeakSet<object>(),
): ResultType<StrictJsonValue, CanonicalJsonInvalid> {
  const primitive = strictJsonPrimitiveSchema.safeParse(value);
  if (primitive.success) {
    return Result.ok(
      typeof primitive.data === "number" && Object.is(primitive.data, -0) ? 0 : primitive.data,
    );
  }
  if (!Array.isArray(value) && !isRecord(value)) {
    return Result.err(
      new CanonicalJsonInvalid({ message: "Canonical values must be strict JSON" }),
    );
  }
  if (ancestors.has(value)) {
    return Result.err(
      new CanonicalJsonInvalid({ message: "Canonical JSON values must not contain cycles" }),
    );
  }
  ancestors.add(value);
  const parsedValue = captureAgentOperation(() => {
    if (Array.isArray(value)) {
      const result: StrictJsonValue[] = [];
      for (const item of value) {
        const parsed = resultOutcome(parseStrictJsonValue(item, ancestors));
        if (!parsed.ok) return Result.err(parsed.error);
        result.push(parsed.value);
      }
      return Result.ok(result);
    }
    const prototype = Object.getPrototypeOf(value);
    if (
      (prototype !== Object.prototype && prototype !== null) ||
      typeof value["toJSON"] === "function"
    ) {
      return Result.err(
        new CanonicalJsonInvalid({
          message: "Canonical JSON objects must be plain data objects",
        }),
      );
    }
    const entries: Array<[string, StrictJsonValue]> = [];
    for (const key of Object.keys(value)) {
      const parsed = resultOutcome(parseStrictJsonValue(value[key], ancestors));
      if (!parsed.ok) return Result.err(parsed.error);
      entries.push([key, parsed.value]);
    }
    return Result.ok(Object.fromEntries(entries));
  });
  ancestors.delete(value);
  const parsedOutcome = resultOutcome(parsedValue);
  if (!parsedOutcome.ok) {
    rethrowAgentPanic(parsedOutcome.error);
    return signalCanonicalJsonInvalid(parsedOutcome.error);
  }
  return parsedOutcome.value;
}

function requireStrictJsonValue(value: OpaqueAgentValue): StrictJsonValue {
  const parsed = resultOutcome(parseStrictJsonValue(value));
  if (!parsed.ok) return signalCanonicalJsonInvalid(parsed.error);
  return parsed.value;
}

function sortCanonicalJsonValue(value: StrictJsonValue): StrictJsonValue {
  if (value === null || typeof value !== "object") {
    return typeof value === "number" && Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) return value.map(sortCanonicalJsonValue);
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => utf16Compare(left, right))
      .map(([key, item]): [string, StrictJsonValue] => [key, sortCanonicalJsonValue(item)]),
  );
}

function wrapCanonicalJsonValue(value: StrictJsonValue): CanonicalJsonValue {
  if (value === null) return { type: "null" };
  if (typeof value === "boolean") return { type: "boolean", value };
  if (typeof value === "number") {
    return { type: "number", value: Object.is(value, -0) ? 0 : value };
  }
  if (typeof value === "string") return { type: "string", value };
  if (Array.isArray(value)) {
    return { type: "array", items: value.map(wrapCanonicalJsonValue) };
  }
  return {
    type: "object",
    entries: Object.entries(value)
      .sort(([left], [right]) => utf16Compare(left, right))
      .map(([key, item]) => ({ key, value: wrapCanonicalJsonValue(item) })),
  };
}

function normalizeCanonicalValue(value: unknown): CanonicalJsonValue {
  return wrapCanonicalJsonValue(requireStrictJsonValue(value));
}

export function canonicalJsonStringify(value: unknown): string {
  return JSON.stringify(sortCanonicalJsonValue(requireStrictJsonValue(value)));
}

function fileIdentity(data: unknown): CanonicalFileIdentityV1 {
  if (valueIsUrlData(data)) {
    return { algorithm: "sha256", kind: "location", digest: sha256(data) };
  }
  if (typeof data === "string") {
    return { algorithm: "sha256", kind: "content", digest: fileStringContentDigest(data) };
  }
  if (data instanceof URL) {
    return { algorithm: "sha256", kind: "location", digest: sha256(data.toString()) };
  }
  if (data instanceof ArrayBuffer) {
    return { algorithm: "sha256", kind: "content", digest: sha256(new Uint8Array(data)) };
  }
  if (ArrayBuffer.isView(data)) {
    return {
      algorithm: "sha256",
      kind: "content",
      digest: sha256(new Uint8Array(data.buffer, data.byteOffset, data.byteLength)),
    };
  }
  if (isRecord(data)) {
    if (data["type"] === "url" && data["url"] instanceof URL) {
      return { algorithm: "sha256", kind: "location", digest: sha256(data["url"].toString()) };
    }
    if (data["type"] === "reference" || "providerReference" in data || "fileId" in data) {
      return {
        algorithm: "sha256",
        kind: "reference",
        digest: sha256(canonicalJsonStringify(data)),
      };
    }
    if (data["type"] === "data") return fileIdentity(data["data"]);
    if (data["type"] === "text" && typeof data["text"] === "string") {
      return { algorithm: "sha256", kind: "content", digest: sha256(data["text"]) };
    }
    return {
      algorithm: "sha256",
      kind: "reference",
      digest: sha256(canonicalJsonStringify(data)),
    };
  }
  return { algorithm: "sha256", kind: "content", digest: sha256(canonicalJsonStringify(data)) };
}

function valueIsUrlData(value: unknown): value is string {
  return typeof value === "string" && /^[a-z][a-z0-9+.-]*:\/\//i.test(value);
}

function fileStringContentDigest(value: string): string {
  const dataUrl = /^data:[^,]*,(.*)$/is.exec(value);
  if (dataUrl) {
    const payload = dataUrl[1] ?? "";
    if (/^data:[^,]*;base64,/i.test(value)) return sha256(Buffer.from(payload, "base64"));
    const decoded = resultOutcome(captureAgentOperation(() => decodeURIComponent(payload)));
    if (decoded.ok) return sha256(decoded.value);
    rethrowAgentPanic(decoded.error);
    return sha256(payload);
  }
  return sha256(Buffer.from(value, "base64"));
}

function projectResultContentItem(item: unknown): StrictJsonValue | null {
  if (!isRecord(item) || typeof item["type"] !== "string") {
    return requireStrictJsonValue(item);
  }
  const type = item["type"];
  if (type === "custom") return null;
  if (type === "text" && typeof item["text"] === "string") {
    return { type: "text", text: item["text"] };
  }
  if (type.includes("file") || type.startsWith("image")) {
    let data: unknown;
    if (item["fileId"] !== undefined) {
      data = { type: "reference", reference: item["fileId"] };
    } else if (item["providerReference"] !== undefined) {
      data = { type: "reference", reference: item["providerReference"] };
    } else if (item["reference"] !== undefined) {
      data = { type: "reference", reference: item["reference"] };
    } else {
      data = item["url"] ?? item["data"];
    }
    const projected: Record<string, StrictJsonValue> = {
      type: "file",
      mediaType:
        typeof item["mediaType"] === "string" ? item["mediaType"] : "application/octet-stream",
      identity: fileIdentity(data),
    };
    if (typeof item["filename"] === "string") projected["filename"] = item["filename"];
    return requireStrictJsonValue(projected);
  }
  const projected: Array<[string, StrictJsonValue]> = [];
  for (const key of Object.keys(item).sort(utf16Compare)) {
    if (key === "providerOptions" || key === "providerMetadata") continue;
    projected.push([key, requireStrictJsonValue(item[key])]);
  }
  return Object.fromEntries(projected);
}

function toolOutputProjection(output: unknown): {
  readonly outcome: HistoricalToolOutcome;
  readonly output?: CanonicalJsonValue;
} {
  if (!isRecord(output) || typeof output["type"] !== "string") {
    return { outcome: "unknown", output: normalizeCanonicalValue(output) };
  }
  switch (output["type"]) {
    case "text":
      return { outcome: "success", output: normalizeCanonicalValue(output["value"]) };
    case "json":
      return { outcome: "success", output: normalizeCanonicalValue(output["value"]) };
    case "error-text":
    case "error-json":
      return { outcome: "error", output: normalizeCanonicalValue(output["value"]) };
    case "execution-denied":
      return output["reason"] === undefined
        ? { outcome: "denied" }
        : { outcome: "denied", output: normalizeCanonicalValue(output["reason"]) };
    case "content": {
      const value = Array.isArray(output["value"])
        ? output["value"].flatMap((item) => {
            const projected = projectResultContentItem(item);
            return projected === null ? [] : [projected];
          })
        : requireStrictJsonValue(output["value"]);
      return { outcome: "success", output: normalizeCanonicalValue(value) };
    }
    default:
      return { outcome: "unknown" };
  }
}

function projectFilePart(part: {
  readonly data?: unknown;
  readonly image?: unknown;
  readonly mediaType?: string;
  readonly filename?: string;
}): CanonicalContentPartV1 {
  return {
    type: "file",
    mediaType: part.mediaType ?? "image",
    ...(part.filename === undefined ? {} : { filename: part.filename }),
    identity: fileIdentity(part.data ?? part.image),
  };
}

export function projectCanonicalMessagesV1(
  messages: readonly ModelMessage[],
): CanonicalHeadProjectionV1 {
  return {
    version: CANONICAL_HEAD_HASH_VERSION,
    messages: messages.map((message): CanonicalMessageV1 => {
      if (message.role === "system") {
        return { role: "system", content: [{ type: "text", text: message.content }] };
      }
      if (message.role === "user") {
        const content =
          typeof message.content === "string"
            ? [{ type: "text" as const, text: message.content }]
            : message.content.map(
                (part): CanonicalContentPartV1 =>
                  part.type === "text" ? { type: "text", text: part.text } : projectFilePart(part),
              );
        return { role: "user", content };
      }
      if (message.role === "assistant") {
        if (typeof message.content === "string") {
          return { role: "assistant", content: [{ type: "text", text: message.content }] };
        }
        const content: CanonicalContentPartV1[] = [];
        for (const part of message.content) {
          if (part.type === "text") content.push({ type: "text", text: part.text });
          else if (part.type === "file") content.push(projectFilePart(part));
          else if (part.type === "tool-call") {
            content.push({
              type: "tool-call",
              toolCallId: part.toolCallId,
              toolName: part.toolName,
              input: normalizeCanonicalValue(part.input),
              providerExecuted: part.providerExecuted === true,
            });
          } else if (part.type === "tool-result") {
            const projected = toolOutputProjection(part.output);
            content.push({
              type: "tool-result",
              toolCallId: part.toolCallId,
              toolName: part.toolName,
              outcome: projected.outcome,
              ...(projected.output === undefined ? {} : { output: projected.output }),
              providerExecuted: false,
            });
          } else if (part.type === "tool-approval-request") {
            content.push({
              type: "tool-approval-request",
              approvalId: part.approvalId,
              toolCallId: part.toolCallId,
              automatic: part.isAutomatic === true,
            });
          }
        }
        return { role: "assistant", content };
      }

      const content: CanonicalContentPartV1[] = message.content.map((part) => {
        if (part.type === "tool-approval-response") {
          return {
            type: "tool-approval-response",
            approvalId: part.approvalId,
            approved: part.approved,
            ...(part.reason === undefined ? {} : { reason: part.reason }),
            providerExecuted: part.providerExecuted === true,
          };
        }
        const projected = toolOutputProjection(part.output);
        return {
          type: "tool-result",
          toolCallId: part.toolCallId,
          toolName: part.toolName,
          outcome: projected.outcome,
          ...(projected.output === undefined ? {} : { output: projected.output }),
          providerExecuted: false,
        };
      });
      return { role: "tool", content };
    }),
  };
}

export function hashCanonicalMessagesV1(
  messages: readonly ModelMessage[],
): CanonicalHeadHashV1Result {
  const projection = projectCanonicalMessagesV1(messages);
  const serialized = canonicalJsonStringify(projection);
  return {
    version: CANONICAL_HEAD_HASH_VERSION,
    domain: CANONICAL_HEAD_HASH_DOMAIN,
    hash: domainHash(CANONICAL_HEAD_HASH_DOMAIN, serialized),
    serialized,
    projection,
  };
}

export function hashExecutionScopeV1(input: ExecutionScopeHashInputV1): ExecutionScopeHashV1Result {
  const decodedInput = executionScopeHashInputV1Schema.safeParse(input);
  if (!decodedInput.success) {
    return signalCanonicalJsonInvalid(
      new CanonicalJsonInvalid({ message: "Execution scope input is invalid" }),
    );
  }
  const projection: ExecutionScopeProjectionV1 = {
    version: EXECUTION_SCOPE_HASH_VERSION,
    scope: decodedInput.data,
  };
  const serialized = canonicalJsonStringify(projection);
  return {
    version: EXECUTION_SCOPE_HASH_VERSION,
    domain: EXECUTION_SCOPE_HASH_DOMAIN,
    hash: domainHash(EXECUTION_SCOPE_HASH_DOMAIN, serialized),
    serialized,
    projection,
  };
}

function clip(
  value: string,
  maxChars: number,
): { readonly text: string; readonly truncated: boolean } {
  const characters = [...sanitizeXmlCharacters(value)];
  return {
    text: characters.slice(0, maxChars).join(""),
    truncated: characters.length > maxChars,
  };
}

function sanitizeXmlCharacters(value: string): string {
  let result = "";
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    const valid =
      codePoint === 0x09 ||
      codePoint === 0x0a ||
      codePoint === 0x0d ||
      (codePoint >= 0x20 && codePoint <= 0xd7ff) ||
      (codePoint >= 0xe000 && codePoint <= 0xfffd) ||
      (codePoint >= 0x10000 && codePoint <= 0x10ffff);
    result += valid ? character : "\ufffd";
  }
  return result;
}

function xmlEscape(value: string): string {
  return sanitizeXmlCharacters(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function fileDescription(part: {
  readonly mediaType?: string;
  readonly filename?: string;
}): string {
  const mediaType = clip(part.mediaType ?? "image", MAX_MEDIA_TYPE_CHARS).text;
  const filename =
    part.filename === undefined ? null : clip(part.filename, MAX_FILE_NAME_CHARS).text;
  return filename === null
    ? `[Historical file: media-type=${JSON.stringify(mediaType)}]`
    : `[Historical file: name=${JSON.stringify(filename)}; media-type=${JSON.stringify(mediaType)}]`;
}

const REPLAY_METADATA_KEYS = new Set(["providerOptions", "providerMetadata"]);
const REPLAY_PAYLOAD_KEYS = new Set([
  "data",
  "fileId",
  "image",
  "providerReference",
  "reference",
  "url",
]);

function isRecognizedMediaRecord(value: Record<string, unknown>): boolean {
  const type = value["type"];
  if (typeof type === "string") {
    if (
      type === "file" ||
      type.includes("file-") ||
      type.startsWith("image-") ||
      type.startsWith("audio-") ||
      type.startsWith("video-")
    ) {
      return true;
    }
  }
  return (
    typeof value["mediaType"] === "string" && [...REPLAY_PAYLOAD_KEYS].some((key) => key in value)
  );
}

function sanitizeReplayValue(
  value: unknown,
  options: {
    readonly stripMetadata: boolean;
    readonly stripPayloads: boolean;
  },
  ancestors = new WeakSet<object>(),
): StrictJsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return `[${String(value)}]`;
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value === "bigint") return `[BigInt ${value.toString()}]`;
  if (typeof value === "undefined") return "[Unavailable value]";
  if (typeof value === "symbol") return "[Unsupported symbol]";
  if (typeof value === "function") return "[Unsupported function]";
  if (value instanceof URL)
    return options.stripPayloads ? "[URL payload omitted]" : value.toString();
  if (value instanceof Date) {
    return Number.isFinite(value.getTime()) ? value.toISOString() : "[Invalid date]";
  }
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return "[Binary payload omitted]";

  if (ancestors.has(value)) return "[Circular value omitted]";
  ancestors.add(value);
  if (Array.isArray(value)) {
    const result: StrictJsonValue[] = [];
    for (let index = 0; index < value.length; index += 1) {
      const sanitized:
        | { ok: true; value: StrictJsonValue }
        | { ok: false; error: OpaqueAgentValue } = resultOutcome(
        captureAgentOperation(
          (): StrictJsonValue => sanitizeReplayValue(value[index], options, ancestors),
        ),
      );
      if (sanitized.ok) result.push(sanitized.value);
      else {
        rethrowAgentPanic(sanitized.error);
        result.push("[Unreadable value]");
      }
    }
    ancestors.delete(value);
    return result;
  }
  if (!isRecord(value)) {
    ancestors.delete(value);
    return "[Unsupported object]";
  }
  if (options.stripPayloads && isRecognizedMediaRecord(value)) {
    ancestors.delete(value);
    return fileDescription({
      mediaType:
        typeof value["mediaType"] === "string" ? value["mediaType"] : "application/octet-stream",
      ...(typeof value["filename"] === "string" ? { filename: value["filename"] } : {}),
    });
  }
  const entries: Array<[string, StrictJsonValue]> = [];
  for (const key of Object.keys(value).sort(utf16Compare)) {
    if (options.stripMetadata && REPLAY_METADATA_KEYS.has(key)) continue;
    if (options.stripPayloads && REPLAY_PAYLOAD_KEYS.has(key)) {
      entries.push([key, "[Payload omitted]"]);
      continue;
    }
    const sanitized: { ok: true; value: StrictJsonValue } | { ok: false; error: OpaqueAgentValue } =
      resultOutcome(
        captureAgentOperation(
          (): StrictJsonValue => sanitizeReplayValue(value[key], options, ancestors),
        ),
      );
    if (sanitized.ok) entries.push([key, sanitized.value]);
    else {
      rethrowAgentPanic(sanitized.error);
      entries.push([key, "[Unreadable value]"]);
    }
  }
  ancestors.delete(value);
  return Object.fromEntries(entries);
}

function safeReplayJsonStringify(
  value: unknown,
  options: {
    readonly stripMetadata: boolean;
    readonly stripPayloads: boolean;
  },
): string {
  return canonicalJsonStringify(sanitizeReplayValue(value, options));
}

function toolInputText(input: unknown): string {
  const serialized = resultOutcome(captureAgentOperation(() => canonicalJsonStringify(input)));
  if (serialized.ok) return serialized.value;
  rethrowAgentPanic(serialized.error);
  return safeReplayJsonStringify(input, { stripMetadata: true, stripPayloads: true });
}

function toolOutputValueText(value: unknown): string {
  return safeReplayJsonStringify(value, { stripMetadata: true, stripPayloads: true });
}

function outputText(output: unknown): {
  readonly outcome: HistoricalToolOutcome;
  readonly text?: string;
} {
  if (!isRecord(output) || typeof output["type"] !== "string") {
    return { outcome: "unknown", text: toolOutputValueText(output) };
  }
  switch (output["type"]) {
    case "text":
      return typeof output["value"] === "string"
        ? { outcome: "success", text: output["value"] }
        : { outcome: "unknown", text: toolOutputValueText(output["value"]) };
    case "json":
      return { outcome: "success", text: toolOutputValueText(output["value"]) };
    case "error-text":
      return typeof output["value"] === "string"
        ? { outcome: "error", text: output["value"] }
        : { outcome: "error", text: toolOutputValueText(output["value"]) };
    case "error-json":
      return { outcome: "error", text: toolOutputValueText(output["value"]) };
    case "execution-denied":
      return typeof output["reason"] === "string"
        ? { outcome: "denied", text: output["reason"] }
        : { outcome: "denied" };
    case "content": {
      if (!Array.isArray(output["value"])) {
        return { outcome: "unknown", text: toolOutputValueText(output["value"]) };
      }
      const parts: string[] = [];
      for (const item of output["value"]) {
        switch (true) {
          case !isRecord(item) || typeof item["type"] !== "string":
            parts.push(toolOutputValueText(item));
            break;
          case item["type"] === "text" && typeof item["text"] === "string":
            parts.push(item["text"]);
            break;
          case item["type"].includes("file") || item["type"].startsWith("image"):
            parts.push(
              fileDescription({
                mediaType:
                  typeof item["mediaType"] === "string"
                    ? item["mediaType"]
                    : "application/octet-stream",
                ...(typeof item["filename"] === "string" ? { filename: item["filename"] } : {}),
              }),
            );
            break;
          case item["type"] !== "custom":
            parts.push(toolOutputValueText(item));
            break;
        }
      }
      return parts.length === 0
        ? { outcome: "success" }
        : { outcome: "success", text: parts.join("\n") };
    }
    default:
      return { outcome: "unknown", text: toolOutputValueText(output) };
  }
}

function renderActivityGroup(group: ActivityGroup, target: TextReplayTarget): string {
  const lines = ["<historical-tool-activity>", `  <notice>${TOOL_NOTICE}</notice>`];
  for (const activity of group.activities) {
    const tool = xmlEscape(clip(activity.tool, MAX_TOOL_NAME_CHARS).text);
    lines.push(`  <activity tool="${tool}" outcome="${activity.outcome}">`);
    if (activity.input !== undefined) {
      const input = clip(toolInputText(activity.input), target.maxToolInputChars);
      lines.push(
        `    <historical-input format="json" truncated="${input.truncated}">${xmlEscape(input.text)}</historical-input>`,
      );
    }
    if (activity.result !== undefined) {
      const result = clip(activity.result, target.maxToolResultChars);
      lines.push(
        `    <historical-result truncated="${result.truncated}">${xmlEscape(result.text)}</historical-result>`,
      );
    }
    lines.push("  </activity>");
  }
  lines.push("</historical-tool-activity>");
  return lines.join("\n");
}

function appendSegment(segments: ReplaySegment[], segment: ReplaySegment): void {
  if (segment.kind === "text" && segment.text.length === 0) return;
  segments.push(segment);
}

function ensureActivityGroup(segments: ReplaySegment[]): ActivityGroup {
  const last = segments.at(-1);
  if (last?.kind === "activity") return last;
  const group: ActivityGroup = { kind: "activity", activities: [] };
  segments.push(group);
  return group;
}

function addToolResult(activity: MutableActivity, output: unknown): void {
  const projected = outputText(output);
  activity.outcome = projected.outcome;
  if (projected.text !== undefined) activity.result = projected.text;
}

function addOrphanResult(group: ActivityGroup, part: unknown): void {
  const tool =
    isRecord(part) && typeof part["toolName"] === "string" ? part["toolName"] : "unknown";
  const hasOutput = isRecord(part) && "output" in part;
  const projected: { readonly outcome: HistoricalToolOutcome; readonly text?: string } = hasOutput
    ? outputText(part["output"])
    : { outcome: "unknown" };
  group.activities.push({
    toolCallId: null,
    tool,
    outcome: projected.outcome,
    ...(projected.text === undefined ? {} : { result: projected.text }),
  });
}

function addMalformedToolActivity(group: ActivityGroup, part: Record<string, unknown>): void {
  const input = part["input"];
  const output = part["output"];
  const projected: { readonly outcome: HistoricalToolOutcome; readonly text?: string } =
    output === undefined
      ? {
          outcome: "unknown",
          ...(typeof part["reason"] === "string" ? { text: part["reason"] } : {}),
        }
      : outputText(output);
  group.activities.push({
    toolCallId: typeof part["toolCallId"] === "string" ? part["toolCallId"] : null,
    tool: typeof part["toolName"] === "string" ? part["toolName"] : "unknown",
    ...(input === undefined
      ? {}
      : {
          input: sanitizeReplayValue(input, {
            stripMetadata: true,
            stripPayloads: true,
          }),
        }),
    outcome: projected.outcome,
    ...(projected.text === undefined ? {} : { result: projected.text }),
  });
}

function takeMatchingActivity(
  pending: Map<string, MutableActivity[]>,
  toolCallId: unknown,
  toolName: unknown,
): MutableActivity | undefined {
  if (typeof toolCallId !== "string" || typeof toolName !== "string") return undefined;
  const queue = pending.get(toolCallId);
  const index = queue?.findIndex((activity) => activity.tool === toolName) ?? -1;
  if (queue === undefined || index < 0) return undefined;
  return queue.splice(index, 1)[0];
}

function applyToolResultPart(
  group: ActivityGroup,
  pending: Map<string, MutableActivity[]>,
  part: Record<string, unknown>,
): void {
  const activity = takeMatchingActivity(pending, part["toolCallId"], part["toolName"]);
  if (activity === undefined || !("output" in part)) {
    addOrphanResult(group, part);
    return;
  }
  addToolResult(activity, part["output"]);
}

function applyApprovalResponsePart(
  group: ActivityGroup,
  approvals: Map<string, MutableActivity>,
  part: Record<string, unknown>,
): void {
  const approvalId = part["approvalId"];
  const approved = part["approved"];
  const activity = typeof approvalId === "string" ? approvals.get(approvalId) : undefined;
  if (typeof approved !== "boolean") {
    addMalformedToolActivity(group, part);
  } else if (activity !== undefined && !approved) {
    activity.outcome = "denied";
    if (typeof part["reason"] === "string") activity.result = part["reason"];
  } else if (activity === undefined) {
    group.activities.push({
      toolCallId: null,
      tool: "unknown",
      outcome: approved ? "unknown" : "denied",
      ...(typeof part["reason"] === "string" ? { result: part["reason"] } : {}),
    });
  }
}

function applyAdjacentToolPart(
  group: ActivityGroup,
  pending: Map<string, MutableActivity[]>,
  approvals: Map<string, MutableActivity>,
  part: unknown,
): void {
  if (!isRecord(part) || typeof part["type"] !== "string") {
    addOrphanResult(group, part);
  } else if (part["type"] === "tool-result") {
    applyToolResultPart(group, pending, part);
  } else if (part["type"] === "tool-approval-response") {
    applyApprovalResponsePart(group, approvals, part);
  } else {
    addMalformedToolActivity(group, part);
  }
}

function lowerAssistantExchange(
  message: Extract<ModelMessage, { role: "assistant" }>,
  adjacentTools: readonly Extract<ModelMessage, { role: "tool" }>[],
): ReplaySegment[] {
  if (typeof message.content === "string") {
    const segments: ReplaySegment[] = [{ kind: "text", text: message.content }];
    if (adjacentTools.length === 0) return segments;
    const group = ensureActivityGroup(segments);
    const pending = new Map<string, MutableActivity[]>();
    const approvals = new Map<string, MutableActivity>();
    for (const toolMessage of adjacentTools) {
      for (const part of toolMessage.content)
        applyAdjacentToolPart(group, pending, approvals, part);
    }
    return segments;
  }

  const segments: ReplaySegment[] = [];
  const pending = new Map<string, MutableActivity[]>();
  const approvals = new Map<string, MutableActivity>();
  for (const rawPart of message.content) {
    const part: unknown = rawPart;
    if (!isRecord(part) || typeof part["type"] !== "string") {
      addMalformedToolActivity(ensureActivityGroup(segments), {});
      continue;
    }
    switch (true) {
      case part["type"] === "text" && typeof part["text"] === "string": {
        appendSegment(segments, { kind: "text", text: part["text"] });
        break;
      }
      case part["type"] === "file": {
        appendSegment(segments, {
          kind: "text",
          text: fileDescription({
            mediaType: typeof part["mediaType"] === "string" ? part["mediaType"] : "image",
            ...(typeof part["filename"] === "string" ? { filename: part["filename"] } : {}),
          }),
        });
        break;
      }
      case part["type"] === "tool-call": {
        const toolCallId = typeof part["toolCallId"] === "string" ? part["toolCallId"] : null;
        if (toolCallId === null || typeof part["toolName"] !== "string") {
          addMalformedToolActivity(ensureActivityGroup(segments), part);
          continue;
        }
        const activity: MutableActivity = {
          toolCallId,
          tool: part["toolName"],
          ...(part["input"] === undefined ? {} : { input: part["input"] }),
          outcome: "unknown",
        };
        ensureActivityGroup(segments).activities.push(activity);
        const queue = pending.get(toolCallId) ?? [];
        queue.push(activity);
        pending.set(toolCallId, queue);
        break;
      }
      case part["type"] === "tool-result": {
        applyToolResultPart(ensureActivityGroup(segments), pending, part);
        break;
      }
      case part["type"] === "tool-approval-request": {
        const toolCallId = part["toolCallId"];
        const queue = typeof toolCallId === "string" ? pending.get(toolCallId) : undefined;
        const activity = queue?.[0];
        const approvalId = part["approvalId"];
        if (activity !== undefined && typeof approvalId === "string") {
          approvals.set(approvalId, activity);
        } else {
          const orphan: MutableActivity = {
            toolCallId: typeof toolCallId === "string" ? toolCallId : null,
            tool: "unknown",
            outcome: "unknown",
          };
          ensureActivityGroup(segments).activities.push(orphan);
          if (typeof approvalId === "string") approvals.set(approvalId, orphan);
        }
        break;
      }
      case part["type"] === "tool-approval-response": {
        applyApprovalResponsePart(ensureActivityGroup(segments), approvals, part);
        break;
      }
      case (typeof part["type"] === "string" && part["type"].startsWith("tool-")) ||
        "toolCallId" in part ||
        "approvalId" in part ||
        "approved" in part ||
        "output" in part: {
        addMalformedToolActivity(ensureActivityGroup(segments), part);
        break;
      }
    }
  }

  for (const toolMessage of adjacentTools) {
    for (const part of toolMessage.content) {
      applyAdjacentToolPart(ensureActivityGroup(segments), pending, approvals, part);
    }
  }
  return segments;
}

function renderSegments(segments: readonly ReplaySegment[], target: TextReplayTarget): string {
  return segments
    .flatMap((segment) => {
      if (segment.kind === "text") return segment.text.length === 0 ? [] : [segment.text];
      return segment.activities.length === 0 ? [] : [renderActivityGroup(segment, target)];
    })
    .join("\n\n");
}

function appendReplayMessage(
  output: Array<{ role: "user" | "assistant"; content: string }>,
  role: "user" | "assistant",
  content: string,
): void {
  if (content.length === 0) return;
  const previous = output.at(-1);
  if (previous?.role === role) previous.content = `${previous.content}\n\n${content}`;
  else output.push({ role, content });
}

export function preparePlainTextReplayForTarget(
  canonicalPrefix: readonly ModelMessage[],
  target: TextReplayTarget,
): ModelMessage[] {
  const parsedTarget = textReplayTargetSchema.parse(target);
  const output: Array<{ role: "user" | "assistant"; content: string }> = [];
  for (let index = 0; index < canonicalPrefix.length; index += 1) {
    const message = canonicalPrefix[index]!;
    if (message.role === "system") continue;
    if (message.role === "user") {
      let content: string;
      if (typeof message.content === "string") {
        content = message.content;
      } else {
        content = message.content
          .flatMap((part) => {
            if (part.type !== "text") return [fileDescription(part)];
            if (part.text.length === 0) return [];
            return [part.text];
          })
          .join("\n\n");
      }
      appendReplayMessage(output, "user", content);
      continue;
    }
    if (message.role === "assistant") {
      const adjacentTools: Extract<ModelMessage, { role: "tool" }>[] = [];
      let nextIndex = index + 1;
      while (canonicalPrefix[nextIndex]?.role === "tool") {
        const toolMessage = canonicalPrefix[nextIndex];
        if (toolMessage?.role === "tool") adjacentTools.push(toolMessage);
        nextIndex += 1;
      }
      appendReplayMessage(
        output,
        "assistant",
        renderSegments(lowerAssistantExchange(message, adjacentTools), parsedTarget),
      );
      index = nextIndex - 1;
      continue;
    }

    const group: ActivityGroup = { kind: "activity", activities: [] };
    const pending = new Map<string, MutableActivity[]>();
    const approvals = new Map<string, MutableActivity>();
    for (const part of message.content) {
      applyAdjacentToolPart(group, pending, approvals, part);
    }
    if (group.activities.length > 0) {
      appendReplayMessage(output, "assistant", renderActivityGroup(group, parsedTarget));
    }
  }
  return output;
}
