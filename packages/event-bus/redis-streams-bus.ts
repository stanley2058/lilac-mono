import type Redis from "ioredis";
import SuperJSON from "superjson";
import { Panic, Result, TaggedError, type Result as ResultType } from "better-result";
import { z } from "zod";
import { createLogger, errorMessage } from "@stanley2058/lilac-utils";
import type { Logger } from "@stanley2058/simple-module-logger";

import type { RawBus } from "./raw-bus";
import {
  EventDeliveryStartFailed,
  EventPostCommitObservationFailed,
  EventDeliveryStopFailed,
  EventDeliveryStopped,
  EventDeliveryTransportFailed,
  type EventDeliveryDoneError,
  type RawDeliveryAction,
  type RawDeliveryDependencies,
  type RawDeliveryHandler,
} from "./event-delivery";
import {
  checkedDeadLetterAcceptance,
  createAttemptsExhaustedDeadLetterReason,
  createManagedEventDeadLetterRecord,
  createTailEventDeadLetterRecord,
  EventDeadLetterAcceptFailed,
  type EventDeadLetterAcceptance,
  type EventDeadLetterReason,
  type EventTransportEvidence,
} from "./event-dead-letter";
import {
  RedisConnectionPool,
  type RedisConnectionPoolOptions,
  type RedisConnectionPoolAutoscaleOptions,
  type RedisLease,
} from "./redis-connection-pool";
import {
  MANAGED_REDIS_HEARTBEAT_MS,
  managedRedisPhysicalGroup,
  panic as signalEventBusPanic,
  RedisManagedDelivery,
  type ManagedClaim,
  type ManagedExhaustionFailure,
  type ManagedLease,
  type ManagedTerminalMaterial,
} from "./redis-managed-delivery";
import type {
  Cursor,
  FetchOptions,
  Offset,
  PublishOptions,
  PublishMessage,
  RawMessageDecodeOutcome,
  RawClaimedRequestPublishOutcome,
  RedisMessageDecodeIssue,
  RedisWireKnownField,
  RedisWireValueEvidence,
  SubscriptionOptions,
  Topic,
  RequestPublicationClaim,
  RequestPublicationClaimAbandonment,
  RequestPublicationClaimAcquisition,
  RequestPublicationConfirmation,
} from "./types";
import { lilacEventTypes } from "./lilac-spec";

const DEFAULT_MAX_MESSAGES = 50;
const DEFAULT_BLOCK_MS = 1000;
const OUTPUT_STREAM_TTL_SECONDS = 24 * 60 * 60;
export const REQUEST_PUBLICATION_CLAIM_TTL_MS = 30_000;
const TRIM_DEBOUNCE_MS = 100;
const TAIL_REPLAY_TOPICS = new Set<Topic>(["evt.request", "evt.adapter"]);
const MAX_EVIDENCE_VALUES = 32;
const MAX_INLINE_SOURCE_VALUE_CHARS = 1024;
const QUIET_PUBLISH_TYPES = new Set<string>([
  lilacEventTypes.EvtAgentOutputDeltaReasoning,
  lilacEventTypes.EvtAgentOutputDeltaText,
]);
const STRING_HEADERS_SCHEMA = z.record(z.string(), z.string());
const REDIS_STREAM_ID_PATTERN = /^\d+-\d+$/;
const HANDLER_FAILURE_SCHEMA = z.object({
  kind: z.literal("handler-error"),
  errorTag: z.string(),
  errorMessage: z.string(),
});
const DEAD_LETTER_REASON_SCHEMA = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("contract-invalid"),
    diagnostic: z.literal("event_bus.contract_invalid"),
    stage: z.enum(["transport", "envelope", "event_type", "headers", "topic", "key", "payload"]),
    eventType: z.string().optional(),
    issues: z.array(z.string()),
  }),
  HANDLER_FAILURE_SCHEMA,
  z.object({
    kind: z.literal("attempts-exhausted"),
    finalFailure: z.union([HANDLER_FAILURE_SCHEMA, z.object({ kind: z.literal("lease-expired") })]),
  }),
]);

type CapturedRedisStreamsFailure =
  | { readonly kind: "panic"; readonly panic: Panic }
  | {
      readonly kind: "ordinary";
      readonly restoreCause: () => unknown;
      readonly error: Error;
      readonly closedConnection: boolean;
    };

type RedisStreamsFailureSettlement = () => CapturedRedisStreamsFailure;

function captureRedisStreamsFailure(cause: unknown): RedisStreamsFailureSettlement {
  return () => {
    const inspected = Result.try({
      try: (): Panic | undefined => (Panic.is(cause) ? cause : undefined),
      catch: () => undefined,
    });
    const panic = inspected.match({
      ok: (value) => value,
      err: () => undefined,
    });
    if (panic) return { kind: "panic", panic };
    const error = Result.try({
      try: () => (cause instanceof Error ? cause : new Error("Opaque Redis streams failure")),
      catch: () => new Error("Opaque Redis streams failure"),
    }).match({ ok: (value) => value, err: (value) => value });
    const closedConnection = Result.try({
      try: () => error.name === "Error" && error.message === "Connection is closed.",
      catch: () => false,
    }).match({ ok: (closed) => closed, err: () => false });
    return {
      kind: "ordinary",
      restoreCause: () => cause,
      error,
      closedConnection,
    };
  };
}

function settleRedisStreamsCapture<T>(
  result: ResultType<T, RedisStreamsFailureSettlement>,
): ResultType<T, CapturedRedisStreamsFailure> {
  return result.mapError((settle) => settle());
}

function ownedRedisStreamsFailure(error: Error): CapturedRedisStreamsFailure {
  return {
    kind: "ordinary",
    restoreCause: () => error,
    error,
    closedConnection: false,
  };
}

function disconnectRedisClient(redis: Redis | null): void {
  redis?.disconnect();
}

function redisStreamsOutcome<T, E>(
  result: ResultType<T, E>,
): { readonly kind: "ok"; readonly value: T } | { readonly kind: "error"; readonly error: E } {
  return result.match<
    { readonly kind: "ok"; readonly value: T } | { readonly kind: "error"; readonly error: E }
  >({
    ok: (value) => ({ kind: "ok", value }),
    err: (error) => ({ kind: "error", error }),
  });
}

function isClosedRedisConnectionFailure(failure: CapturedRedisStreamsFailure): boolean {
  return failure.kind === "ordinary" && failure.closedConnection;
}

const XADD_WITH_EXPIRY_SCRIPT = `
local id = redis.call("XADD", KEYS[1], unpack(ARGV, 2))
redis.call("EXPIRE", KEYS[1], ARGV[1])
local server_time = redis.call("TIME")
local deadline = (tonumber(server_time[1]) * 1000) + math.floor(tonumber(server_time[2]) / 1000) + (tonumber(ARGV[1]) * 1000)
return {id, tostring(deadline)}
`;

const ACQUIRE_REQUEST_PUBLICATION_CLAIM_SCRIPT = `
local acquired = redis.call("SET", KEYS[1], ARGV[1], "PX", ARGV[2], "NX")
if acquired then return 1 end
return 0
`;

const CLAIMED_REQUEST_XADD_SCRIPT = `
local claim = redis.call("GET", KEYS[2])
if not claim or claim ~= ARGV[1] then return {"fenced"} end
local existing = redis.call("GET", KEYS[3])
if existing then return {"observed", existing} end
local id = redis.call("XADD", KEYS[1], unpack(ARGV, 2))
redis.call("SET", KEYS[3], id)
return {"published", id}
`;

const CONFIRM_REQUEST_PUBLICATION_SCRIPT = `
local claim = redis.call("GET", KEYS[2])
if not claim or claim ~= ARGV[1] then return "fenced" end
local marker = redis.call("GET", KEYS[1])
if not marker then
  redis.call("DEL", KEYS[2])
  return "absent"
end
if marker ~= ARGV[2] then return "mismatch" end
redis.call("DEL", KEYS[1], KEYS[2])
return "confirmed"
`;

const ABANDON_REQUEST_PUBLICATION_CLAIM_SCRIPT = `
local claim = redis.call("GET", KEYS[1])
if not claim then return "absent" end
if claim ~= ARGV[1] then return "fenced" end
if redis.call("EXISTS", KEYS[2]) == 1 then return "marker-present" end
redis.call("DEL", KEYS[1])
return "abandoned"
`;

const READ_OUTPUT_STREAM_EXPIRY_SCRIPT = `
local expires_at = redis.call("PEXPIRETIME", KEYS[1])
if expires_at == -2 then return {"absent"} end
if expires_at == -1 then return {"uncertain"} end
local server_time = redis.call("TIME")
local server_now = (tonumber(server_time[1]) * 1000) + math.floor(tonumber(server_time[2]) / 1000)
if expires_at <= server_now then return {"absent"} end
return {"present", tostring(expires_at)}
`;

const TRIM_ACKNOWLEDGED_PREFIX_SCRIPT = `
local groups = redis.call("XINFO", "GROUPS", KEYS[1])
if #groups == 0 then return 0 end

local function component_less_than(left, right)
  if string.len(left) ~= string.len(right) then return string.len(left) < string.len(right) end
  return left < right
end

local function less_than(left, right)
  local left_dash = string.find(left, "-", 1, true)
  local right_dash = string.find(right, "-", 1, true)
  local left_time = string.sub(left, 1, left_dash - 1)
  local right_time = string.sub(right, 1, right_dash - 1)
  if left_time ~= right_time then return component_less_than(left_time, right_time) end
  local left_sequence = string.sub(left, left_dash + 1)
  local right_sequence = string.sub(right, right_dash + 1)
  return component_less_than(left_sequence, right_sequence)
end

local watermark = nil
for _, fields in ipairs(groups) do
  local name = nil
  local pending = nil
  local last_delivered_id = nil
  for index = 1, #fields, 2 do
    if fields[index] == "name" then name = fields[index + 1] end
    if fields[index] == "pending" then pending = fields[index + 1] end
    if fields[index] == "last-delivered-id" then last_delivered_id = fields[index + 1] end
  end
  if not name or pending == nil or not last_delivered_id then return 0 end

  local boundary = last_delivered_id
  if pending > 0 then
    local pending_summary = redis.call("XPENDING", KEYS[1], name)
    boundary = pending_summary[2]
    if not boundary then return 0 end
  end
  if boundary == "0-0" then return 0 end
  if not watermark or less_than(boundary, watermark) then watermark = boundary end
end

return redis.call("XTRIM", KEYS[1], "MINID", "=", watermark)
`;

const TRIM_BEFORE_CHECKPOINT_SCRIPT = `
if redis.call("TYPE", KEYS[1]).ok ~= "stream" then return 0 end

local function component_less_than(left, right)
  if string.len(left) ~= string.len(right) then return string.len(left) < string.len(right) end
  return left < right
end

local function less_than(left, right)
  local left_dash = string.find(left, "-", 1, true)
  local right_dash = string.find(right, "-", 1, true)
  local left_time = string.sub(left, 1, left_dash - 1)
  local right_time = string.sub(right, 1, right_dash - 1)
  if left_time ~= right_time then return component_less_than(left_time, right_time) end
  return component_less_than(string.sub(left, left_dash + 1), string.sub(right, right_dash + 1))
end

local watermark = ARGV[1]
if watermark == "0-0" then return 0 end
local groups = redis.call("XINFO", "GROUPS", KEYS[1])
for _, fields in ipairs(groups) do
  local name = nil
  local pending = nil
  local last_delivered_id = nil
  for index = 1, #fields, 2 do
    if fields[index] == "name" then name = fields[index + 1] end
    if fields[index] == "pending" then pending = fields[index + 1] end
    if fields[index] == "last-delivered-id" then last_delivered_id = fields[index + 1] end
  end
  if not name or pending == nil or not last_delivered_id then return 0 end
  local boundary = last_delivered_id
  if pending > 0 then
    local pending_summary = redis.call("XPENDING", KEYS[1], name)
    boundary = pending_summary[2]
    if not boundary then return 0 end
  end
  if boundary == "0-0" then return 0 end
  if less_than(boundary, watermark) then watermark = boundary end
end

local retained = redis.call("XREVRANGE", KEYS[1], watermark, "-", "COUNT", ARGV[2])
if #retained < tonumber(ARGV[2]) then return 0 end
local cutoff = retained[#retained][1]
return redis.call("XTRIM", KEYS[1], "MINID", "=", cutoff)
`;

const RETIRE_CONSUMER_GROUP_SCRIPT = `
if redis.call("TYPE", KEYS[1]).ok ~= "stream" then return 0 end
local groups = redis.call("XINFO", "GROUPS", KEYS[1])
local found = false
for _, fields in ipairs(groups) do
  for index = 1, #fields, 2 do
    if fields[index] == "name" and fields[index + 1] == ARGV[1] then found = true end
  end
end
if not found then return 0 end
if ARGV[2] ~= "1" then return -1 end
return redis.call("XGROUP", "DESTROY", KEYS[1], ARGV[1])
`;

function randomConsumerId(): string {
  // Bun + modern Node both support this.
  return crypto.randomUUID();
}

function redisIdForOffset(offset: Offset): string {
  switch (offset.type) {
    case "begin":
      return "0-0";
    case "now":
      return "$";
    case "cursor":
      return offset.cursor;
  }
}

function redisIdForOptionalOffset(offset: Offset | undefined): string {
  if (offset === undefined) return "$";
  return redisIdForOffset(offset);
}

type RedisReadEntry = {
  readonly id: string;
  readonly message: RawMessageDecodeOutcome;
  readonly evidence: EventTransportEvidence;
};
type RedisResponseDecodeResult<T> =
  | { readonly status: "ok"; readonly value: T }
  | { readonly status: "error"; readonly message: string };

function isRedisStreamId(value: string): boolean {
  return REDIS_STREAM_ID_PATTERN.test(value);
}

function isRedisCount(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

const redisStreamEntrySchema = z
  .array(z.unknown())
  .length(2)
  .pipe(z.tuple([z.unknown(), z.unknown()]))
  .transform(([id, fields]) => ({ id, fields }));
const redisReadStreamSchema = z
  .array(z.unknown())
  .length(2)
  .pipe(z.tuple([z.unknown(), z.array(redisStreamEntrySchema)]))
  .transform(([streamKey, entries]) => ({ streamKey, entries }));
const redisReadResponseSchema = z
  .array(z.unknown())
  .length(1)
  .pipe(z.tuple([redisReadStreamSchema]))
  .transform(([stream]) => stream)
  .nullable();
const redisRangeResponseSchema = z
  .array(z.unknown())
  .length(1)
  .pipe(z.tuple([redisStreamEntrySchema]))
  .transform(([entry]) => entry);
const redisWatermarkEntrySchema = z
  .array(z.unknown())
  .length(2)
  .pipe(z.tuple([z.unknown(), z.array(z.unknown())]))
  .transform(([id, fields]) => ({ id, fields }));
const redisWatermarkResponseSchema = z
  .array(redisWatermarkEntrySchema)
  .max(1)
  .transform(([entry]) => ({ entry: entry ?? null }));
const redisPendingSummarySchema = z
  .array(z.unknown())
  .min(3)
  .pipe(
    z
      .tuple([
        z.number().refine(isRedisCount),
        z.string().refine(isRedisStreamId).nullable(),
        z.unknown(),
      ])
      .rest(z.unknown()),
  )
  .transform(([count, oldestId]) => ({ count, oldestId }));
const redisOldestPendingEntrySchema = z
  .array(z.unknown())
  .min(3)
  .pipe(z.tuple([z.unknown(), z.unknown(), z.number().refine(isRedisCount)]).rest(z.unknown()))
  .transform(([, , oldestIdleMs]) => ({ oldestIdleMs }));
const redisOldestPendingResponseSchema = z
  .array(z.unknown())
  .length(1)
  .pipe(z.tuple([redisOldestPendingEntrySchema]))
  .transform(([entry]) => entry);
const redisCleanupPendingPresenceSchema = z
  .array(z.unknown())
  .transform((entries) => ({ hasPendingEntries: entries.length > 0 }));

function decodeRedisReadResponse(
  response: unknown,
  topic: Topic,
  expectedStreamKey: string,
  logger?: Logger,
): RedisResponseDecodeResult<readonly RedisReadEntry[]> {
  const decoded = redisReadResponseSchema.safeParse(response);
  if (!decoded.success) {
    let message = "Redis XREAD returned an invalid stream collection";
    if (decoded.error.issues.some((issue) => issue.path.length >= 3)) {
      message = "Redis XREAD returned an invalid message entry";
    } else if (decoded.error.issues.some((issue) => issue.path.length > 0)) {
      message = "Redis XREAD returned an invalid stream entry";
    }
    return { status: "error", message };
  }
  if (decoded.data === null) return { status: "ok", value: [] };
  if (decoded.data.streamKey !== expectedStreamKey) {
    return {
      status: "error",
      message: "Redis XREAD returned an invalid stream entry",
    };
  }

  const entries: RedisReadEntry[] = [];
  for (const entry of decoded.data.entries) {
    if (typeof entry.id !== "string" || !isRedisStreamId(entry.id)) {
      return {
        status: "error",
        message: "Redis XREAD returned an invalid message id",
      };
    }
    entries.push({
      id: entry.id,
      message: decodeMessage(topic, decoded.data.streamKey, entry.id, entry.fields, logger),
      evidence: redisTransportEvidence(topic, decoded.data.streamKey, entry.id, entry.fields),
    });
  }
  return { status: "ok", value: entries };
}

function decodeRedisRangeResponse(
  response: unknown,
  topic: Topic,
  streamKey: string,
  expectedId: string,
  logger?: Logger,
): RedisResponseDecodeResult<RedisReadEntry> {
  const decoded = redisRangeResponseSchema.safeParse(response);
  if (!decoded.success) {
    return {
      status: "error",
      message: decoded.error.issues.some((issue) => issue.path.length > 0)
        ? "Redis XRANGE returned an invalid source entry"
        : "Redis XRANGE did not return exactly one source entry",
    };
  }
  if (
    decoded.data.id !== expectedId ||
    typeof decoded.data.id !== "string" ||
    !isRedisStreamId(decoded.data.id)
  ) {
    return {
      status: "error",
      message: "Redis XRANGE returned an invalid source entry",
    };
  }
  return {
    status: "ok",
    value: {
      id: decoded.data.id,
      message: decodeMessage(topic, streamKey, decoded.data.id, decoded.data.fields, logger),
      evidence: redisTransportEvidence(topic, streamKey, decoded.data.id, decoded.data.fields),
    },
  };
}

function decodeRedisWatermarkResponse(
  response: unknown,
): RedisResponseDecodeResult<{ readonly watermark: string | null }> {
  const decoded = redisWatermarkResponseSchema.safeParse(response);
  if (!decoded.success) {
    let message = "Redis XREVRANGE returned an invalid entry collection";
    if (decoded.error.issues.some((issue) => issue.path.length > 0)) {
      message = "Redis XREVRANGE returned an invalid entry";
    } else if (decoded.error.issues.some((issue) => issue.code === "too_big")) {
      message = "Redis XREVRANGE returned too many entries";
    }
    return { status: "error", message };
  }
  if (decoded.data.entry === null) return { status: "ok", value: { watermark: null } };
  if (typeof decoded.data.entry.id !== "string" || !isRedisStreamId(decoded.data.entry.id)) {
    return {
      status: "error",
      message: "Redis XREVRANGE returned an invalid entry",
    };
  }
  return { status: "ok", value: { watermark: decoded.data.entry.id } };
}

type RedisPendingSummaryValue = {
  readonly count: number;
  readonly oldestId: string | null;
};

function decodeRedisPendingSummary(
  response: unknown,
): RedisResponseDecodeResult<RedisPendingSummaryValue> {
  const decoded = redisPendingSummarySchema.safeParse(response);
  if (!decoded.success) {
    return {
      status: "error",
      message: decoded.error.issues.some((issue) => issue.path.length > 0)
        ? "Redis XPENDING returned invalid summary fields"
        : "Redis XPENDING returned an invalid summary",
    };
  }
  return { status: "ok", value: decoded.data };
}

function decodeRedisOldestPendingIdle(
  response: unknown,
): RedisResponseDecodeResult<{ readonly oldestIdleMs: number }> {
  const decoded = redisOldestPendingResponseSchema.safeParse(response);
  if (!decoded.success) {
    return {
      status: "error",
      message: "Redis XPENDING returned an invalid oldest entry",
    };
  }
  return { status: "ok", value: decoded.data };
}

function decodeRedisCleanupPendingPresence(
  response: unknown,
): RedisResponseDecodeResult<{ readonly hasPendingEntries: boolean }> {
  const decoded = redisCleanupPendingPresenceSchema.safeParse(response);
  if (!decoded.success) {
    return {
      status: "error",
      message: "Redis XPENDING returned an invalid cleanup response",
    };
  }
  return { status: "ok", value: decoded.data };
}

class RedisPendingInspectionFailed extends TaggedError("RedisPendingInspectionFailed")<{
  readonly message: string;
}> {}

async function captureRedisPendingSummary(
  redis: Redis,
  streamKey: string,
  group: string,
): Promise<
  ResultType<{ count: number; oldestIdleMs: number | null }, RedisPendingInspectionFailed>
> {
  const inspectPending = async () => {
    const summary = decodeRedisPendingSummary((await redis.xpending(streamKey, group)) as unknown);
    if (summary.status === "error") {
      return Result.err(new RedisPendingInspectionFailed({ message: summary.message }));
    }
    if (summary.value.count === 0) return Result.ok({ count: 0, oldestIdleMs: null });
    const oldest = decodeRedisOldestPendingIdle(
      (await redis.xpending(streamKey, group, "-", "+", 1)) as unknown,
    );
    if (oldest.status === "error") {
      return Result.err(new RedisPendingInspectionFailed({ message: oldest.message }));
    }
    return Result.ok({
      count: summary.value.count,
      oldestIdleMs: oldest.value.oldestIdleMs,
    });
  };
  const inspected = settleRedisStreamsCapture(
    await Result.tryPromise({
      try: inspectPending,
      catch: captureRedisStreamsFailure,
    }),
  );
  const outcome = redisStreamsOutcome(inspected);
  if (outcome.kind === "ok") return outcome.value;
  return Result.err(
    new RedisPendingInspectionFailed({
      message: "Redis pending inspection failed",
    }),
  );
}

type RedisFieldsDecodeResult =
  | { status: "ok"; value: { readonly fields: Record<string, string> } }
  | { status: "error"; issues: readonly RedisMessageDecodeIssue[] };

type SuperJsonDecodeResult = { status: "ok"; value: unknown } | { status: "error" };

function redisWireRole(index: number, fieldsAreArray: boolean): RedisWireValueEvidence["role"] {
  if (!fieldsAreArray) return "entry";
  return index % 2 === 0 ? "field-name" : "field-value";
}

function redisWireKnownField(value: string): RedisWireKnownField | undefined {
  switch (value) {
    case "type":
    case "ts":
    case "data":
    case "headers":
    case "key":
      return value;
    default:
      return undefined;
  }
}

function redisWireStringKind(
  value: string,
  role: RedisWireValueEvidence["role"],
  field: RedisWireKnownField | undefined,
): Extract<RedisWireValueEvidence, { kind: "string" }>["valueKind"] {
  if (value.length === 0) return "empty";
  if (role === "field-name") return field === undefined ? "unknown-field-name" : "known-field-name";
  if (/data:/iu.test(value)) return "data-url";
  if (/\bdataBase64\b/u.test(value)) return "managed-binary-field";
  if (value.length >= 8 && value.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/u.test(value)) {
    return "base64";
  }
  if (/^\s*\{/u.test(value) || /^\s*\[/u.test(value)) return "structured";
  return "text";
}

function boundWireValue(
  value: unknown,
  index: number,
  fieldsAreArray: boolean,
  field: RedisWireKnownField | undefined,
): RedisWireValueEvidence {
  const path = `fields[${index}]`;
  const role = redisWireRole(index, fieldsAreArray);
  const context = { path, role, ...(field === undefined ? {} : { field }) };
  if (value === null) return { kind: "non-string", ...context, valueType: "null" };
  if (Array.isArray(value)) return { kind: "non-string", ...context, valueType: "array" };
  switch (typeof value) {
    case "bigint":
      return { kind: "non-string", ...context, valueType: "bigint" };
    case "boolean":
      return { kind: "non-string", ...context, valueType: "boolean" };
    case "function":
      return { kind: "non-string", ...context, valueType: "function" };
    case "number":
      return { kind: "non-string", ...context, valueType: "number" };
    case "object":
      return { kind: "non-string", ...context, valueType: "object" };
    case "symbol":
      return { kind: "non-string", ...context, valueType: "symbol" };
    case "undefined":
      return { kind: "non-string", ...context, valueType: "undefined" };
    case "string":
      return {
        kind: "string",
        ...context,
        valueKind: redisWireStringKind(value, role, field),
        charLength: value.length,
      };
  }
  return { kind: "non-string", ...context, valueType: "undefined" };
}

function boundWireEvidence(fields: unknown): {
  fields: readonly RedisWireValueEvidence[];
  omittedValueCount: number;
} {
  const fieldsAreArray = Array.isArray(fields);
  const values: readonly unknown[] = fieldsAreArray ? fields : [fields];
  const evidence: RedisWireValueEvidence[] = [];
  let currentField: RedisWireKnownField | undefined;
  for (const [index, value] of values.slice(0, MAX_EVIDENCE_VALUES).entries()) {
    if (fieldsAreArray && index % 2 === 0) {
      currentField = typeof value === "string" ? redisWireKnownField(value) : undefined;
    }
    evidence.push(boundWireValue(value, index, fieldsAreArray, currentField));
  }
  return {
    fields: evidence,
    omittedValueCount: Math.max(0, values.length - MAX_EVIDENCE_VALUES),
  };
}

function redisTransportEvidence(
  topic: Topic,
  streamKey: string,
  id: string,
  fields: unknown,
): EventTransportEvidence {
  const source = {
    transport: "redis-streams" as const,
    streamKey,
    topic,
    messageId: id,
  };
  const preview = boundWireEvidence(fields);
  if (
    Array.isArray(fields) &&
    fields.length <= MAX_EVIDENCE_VALUES &&
    fields.every(
      (value) => typeof value === "string" && value.length <= MAX_INLINE_SOURCE_VALUE_CHARS,
    )
  ) {
    return {
      source,
      wire: { kind: "bounded-complete", fields: preview.fields },
    };
  }

  return {
    source,
    wire: {
      kind: "controlled-reference",
      locator: { kind: "redis-stream-entry", streamKey, messageId: id },
      preview,
    },
  };
}

function deliveryAction(value: RawDeliveryAction): RawDeliveryAction {
  if (typeof value !== "object" || value === null) {
    throw new Panic({
      message: "Event delivery handler returned a non-object action",
    });
  }
  const disposition = Reflect.get(value, "disposition");
  switch (disposition) {
    case "commit":
    case "park-pending":
    case "stop":
      return value;
    case "retry": {
      const failure = Reflect.get(value, "failure");
      if (!HANDLER_FAILURE_SCHEMA.safeParse(failure).success) {
        throw new Panic({
          message: "Retry disposition has an invalid handler failure",
        });
      }
      return value;
    }
    case "dead-letter": {
      const reason = Reflect.get(value, "reason");
      if (!DEAD_LETTER_REASON_SCHEMA.safeParse(reason).success) {
        throw new Panic({
          message: "Dead-letter disposition has an invalid reason",
        });
      }
      return value;
    }
    default:
      throw new Panic({
        message: "Event delivery handler returned an unknown disposition",
      });
  }
}

function decodeRedisFields(fields: unknown): RedisFieldsDecodeResult {
  if (!Array.isArray(fields)) {
    return {
      status: "error",
      issues: [{ field: "entry", reason: "fields_not_array" }],
    };
  }

  const issues: RedisMessageDecodeIssue[] = [];
  if (fields.length % 2 !== 0) {
    issues.push({ field: "entry", reason: "odd_field_count" });
  }
  const record: Record<string, string> = {};
  let key: string | undefined;
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index];
    if (typeof field !== "string") {
      issues.push({ field: "entry", reason: "non_string_field", index });
    }
    if (index % 2 === 0) {
      key = typeof field === "string" ? field : undefined;
    } else {
      if (key !== undefined && typeof field === "string") record[key] = field;
      key = undefined;
    }
  }
  if (issues.length > 0) return { status: "error", issues };
  return { status: "ok", value: { fields: record } };
}

function decodeSuperJson(value: string): SuperJsonDecodeResult {
  const captured = settleRedisStreamsCapture(
    Result.try({
      try: () => {
        const decoded = SuperJSON.parse(value);
        return () => decoded;
      },
      catch: captureRedisStreamsFailure,
    }),
  );
  return captured.match<SuperJsonDecodeResult>({
    ok: (restore) => ({ status: "ok", value: restore() }),
    err: () => ({ status: "error" }),
  });
}

function decodeMessage(
  topic: Topic,
  streamKey: string,
  id: string,
  fields: unknown,
  logger?: Logger,
): RawMessageDecodeOutcome {
  const failure = (issues: readonly RedisMessageDecodeIssue[]): RawMessageDecodeOutcome => {
    const evidence = boundWireEvidence(fields);
    logger?.warn("event_bus.transport_decode_failed", {
      topic,
      messageId: id,
      issues: issues.map((issue) => ({
        field: issue.field,
        reason: issue.reason,
      })),
      evidenceValueCount: evidence.fields.length,
      evidenceOmittedValueCount: evidence.omittedValueCount,
      evidenceRedacted: true,
    });
    return {
      _tag: "RedisMessageDecodeFailure",
      topic,
      id,
      error: {
        source: { transport: "redis-streams", streamKey, topic, messageId: id },
        issues,
        evidence,
      },
    };
  };

  const fieldsResult = decodeRedisFields(fields);
  if (fieldsResult.status === "error") return failure(fieldsResult.issues);
  const record = fieldsResult.value.fields;

  let typeResult:
    | { status: "ok"; value: string }
    | { status: "error"; issue: RedisMessageDecodeIssue };
  const typeRaw = record["type"];
  if (typeRaw === undefined) {
    typeResult = {
      status: "error",
      issue: { field: "type", reason: "missing" },
    };
  } else if (typeRaw.length === 0) {
    typeResult = { status: "error", issue: { field: "type", reason: "empty" } };
  } else {
    typeResult = { status: "ok", value: typeRaw };
  }

  const tsRaw = record["ts"];
  const tsNumber = tsRaw === undefined || tsRaw.trim().length === 0 ? NaN : Number(tsRaw);
  let tsResult:
    | { status: "ok"; value: number }
    | { status: "error"; issue: RedisMessageDecodeIssue };
  if (tsRaw === undefined) {
    tsResult = { status: "error", issue: { field: "ts", reason: "missing" } };
  } else if (!Number.isFinite(tsNumber)) {
    tsResult = {
      status: "error",
      issue: { field: "ts", reason: "invalid_number" },
    };
  } else {
    tsResult = { status: "ok", value: tsNumber };
  }

  const dataRaw = record["data"];
  let dataResult:
    | { status: "ok"; value: unknown }
    | { status: "error"; issue: RedisMessageDecodeIssue };
  if (dataRaw === undefined) {
    dataResult = {
      status: "error",
      issue: { field: "data", reason: "missing" },
    };
  } else {
    const decoded = decodeSuperJson(dataRaw);
    dataResult =
      decoded.status === "ok"
        ? decoded
        : {
            status: "error",
            issue: { field: "data", reason: "invalid_superjson" },
          };
  }

  const headersRaw = record["headers"];
  let headersResult:
    | { status: "ok"; value: Record<string, string> | undefined }
    | { status: "error"; issue: RedisMessageDecodeIssue };
  if (headersRaw === undefined) {
    headersResult = { status: "ok", value: undefined };
  } else {
    const decoded = decodeSuperJson(headersRaw);
    if (decoded.status === "error") {
      headersResult = {
        status: "error",
        issue: { field: "headers", reason: "invalid_superjson" },
      };
    } else {
      const parsed = STRING_HEADERS_SCHEMA.safeParse(decoded.value);
      if (parsed.success) {
        headersResult = { status: "ok", value: parsed.data };
      } else {
        headersResult = {
          status: "error",
          issue: { field: "headers", reason: "not_string_record" },
        };
      }
    }
  }

  if (
    typeResult.status === "error" ||
    tsResult.status === "error" ||
    dataResult.status === "error" ||
    headersResult.status === "error"
  ) {
    const issues: RedisMessageDecodeIssue[] = [];
    if (typeResult.status === "error") issues.push(typeResult.issue);
    if (tsResult.status === "error") issues.push(tsResult.issue);
    if (dataResult.status === "error") issues.push(dataResult.issue);
    if (headersResult.status === "error") issues.push(headersResult.issue);
    return failure(issues);
  }

  return {
    topic,
    id,
    type: typeResult.value,
    ts: tsResult.value,
    key: record["key"],
    headers: headersResult.value,
    data: dataResult.value,
  };
}

async function ensureGroup(options: {
  redis: Redis;
  streamKey: string;
  group: string;
  startId: string;
  logger?: Logger;
}): Promise<ResultType<boolean, RedisConsumerGroupEnsureFailed>> {
  const createGroup = async (): Promise<ResultType<boolean, RedisConsumerGroupEnsureFailed>> => {
    const created = await options.redis.xgroup(
      "CREATE",
      options.streamKey,
      options.group,
      options.startId,
      "MKSTREAM",
    );
    if (created !== "OK") {
      return Result.err(
        new RedisConsumerGroupEnsureFailed({
          cause: new Error("Redis XGROUP CREATE returned an invalid response"),
          streamKey: options.streamKey,
          group: options.group,
          message: "Redis consumer-group initialization failed",
        }),
      );
    }

    options.logger?.info("created consumer group", {
      streamKey: options.streamKey,
      group: options.group,
      startId: options.startId,
    });
    return Result.ok(true);
  };
  const created = settleRedisStreamsCapture(
    await Result.tryPromise({
      try: createGroup,
      catch: captureRedisStreamsFailure,
    }),
  );
  const outcome = redisStreamsOutcome(created);
  if (outcome.kind === "ok") return outcome.value;
  if (outcome.error.kind === "panic") throw outcome.error.panic;
  const failure = outcome.error;
  const msg = Result.try({
    try: () => errorMessage(failure.error),
    catch: () => "Redis consumer-group initialization failed",
  }).match({
    ok: (message) => message,
    err: () => "Redis consumer-group initialization failed",
  });
  if (msg.includes("BUSYGROUP")) {
    options.logger?.debug("consumer group exists", {
      streamKey: options.streamKey,
      group: options.group,
    });
    return Result.ok(false);
  }
  return Result.err(
    new RedisConsumerGroupEnsureFailed({
      cause: failure.restoreCause(),
      streamKey: options.streamKey,
      group: options.group,
      message: "Redis consumer-group initialization failed",
    }),
  );
}

class RedisConsumerGroupEnsureFailed extends TaggedError("RedisConsumerGroupEnsureFailed")<{
  readonly cause: unknown;
  readonly streamKey: string;
  readonly group: string;
  readonly message: string;
}> {}

/** Options for `RedisStreamsBus`. */
export type RedisStreamsBusOptions = {
  /** Connected ioredis instance. */
  redis: Redis;
  /**
   * Stream key prefix.
   *
   * Defaults to `lilac:event-bus`.
   */
  keyPrefix?: string;

  /**
   * If true, `close()` will call `redis.quit()`.
   *
   * Default: false (assume the caller owns the shared Redis client).
   */
  ownsRedis?: boolean;

  /**
   * Pool config for subscription connections.
   *
   * Subscriptions use blocking `XREAD`/`XREADGROUP`, which would otherwise block
   * publishes on a shared ioredis connection.
   */
  subscriberPool?: {
    /** Initial max duplicated clients used by subscriptions. Default: 16. */
    max?: number;
    /** Optional background warm-up count. Default: 0. */
    warm?: number;
    /** Optional autoscaling config (default disabled). */
    autoscale?: RedisConnectionPoolAutoscaleOptions;
  };
};

// Ephemeral owners stay fenced after expiry; durable groups survive and can register again.
const SUBSCRIPTION_REGISTER_SCRIPT = `
redis.call('SET', KEYS[1], '1', 'PX', 60000)
redis.call('HSET', KEYS[2], ARGV[1], KEYS[1])
return 1
`;
const SUBSCRIPTION_MAINTAIN_SCRIPT = `
if not redis.call('SET', KEYS[1], '1', 'PX', 60000, 'XX') then return {'expired'} end
local page = redis.call('HSCAN', KEYS[2], ARGV[1], 'COUNT', 64)
local destroyed = {}
for i = 1, #page[2], 2 do
  local field = page[2][i]
  local owner = page[2][i+1]
  if redis.call('EXISTS', owner) == 0 then
    local identity = cjson.decode(field)
    local group = identity[1]
    local groups = {}
    if redis.call('EXISTS', KEYS[3]) == 1 then groups = redis.call('XINFO', 'GROUPS', KEYS[3]) end
    local exists = false
    for _, info in ipairs(groups) do
      if info[2] == group then exists = true end
    end
    local removable = not exists
    if identity[3] then
      if exists then redis.call('XGROUP', 'DESTROY', KEYS[3], group) end
      table.insert(destroyed, {field, group})
      removable = false
    elseif exists then
      local pending = redis.call('XPENDING', KEYS[3], group, '-', '+', 1, identity[2])
      if #pending == 0 then
        redis.call('XGROUP', 'DELCONSUMER', KEYS[3], group, identity[2])
        removable = true
      end
    end
    if removable then redis.call('HDEL', KEYS[2], field) end
  end
end
return {page[1], destroyed}
`;
const subscriptionMaintenanceResponse = z.union([
  z.tuple([z.literal("expired")]),
  z.tuple([z.string(), z.array(z.tuple([z.string(), z.string()]))]),
]);

function decodeSubscriptionMaintenance(value: unknown) {
  return subscriptionMaintenanceResponse.safeParse(value);
}

/** Redis Streams-backed implementation of `RawBus`. */
export class RedisStreamsBus implements RawBus {
  private readonly redis: Redis;
  private readonly keyPrefix: string;
  private readonly ownsRedis: boolean;
  private readonly logger: Logger;
  private readonly subPool: RedisConnectionPool;
  private readonly ownerId = randomConsumerId();
  private readonly trimTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly activeTrims = new Set<Promise<void>>();
  private readonly activeSubscriptionStops = new Set<
    () => Promise<ResultType<void, EventDeliveryStopFailed>>
  >();
  private acknowledgedTrimPanic: Panic | null = null;
  private closing = false;

  /** Create a new bus using an existing ioredis client. */
  constructor(options: RedisStreamsBusOptions) {
    this.redis = options.redis;
    this.keyPrefix = options.keyPrefix ?? "lilac:event-bus";
    this.ownsRedis = options.ownsRedis ?? false;
    this.logger = createLogger({
      module: "event-bus:redis-streams",
    });

    const poolCfg = options.subscriberPool;
    const max = poolCfg?.max ?? 16;
    const warm = poolCfg?.warm ?? 0;
    const poolOpts: RedisConnectionPoolOptions = {
      base: this.redis,
      max,
      warm,
      autoscale: poolCfg?.autoscale,
      logger: this.logger,
      label: "event-bus:subscribe",
    };

    this.subPool = new RedisConnectionPool(poolOpts);
  }

  private streamKey(topic: Topic): string {
    if (topic === "cmd.request" || this.isOutputTopic(topic)) {
      return `${this.keyPrefix}:v2:${topic}`;
    }
    return `${this.keyPrefix}:${topic}`;
  }

  private requestPublicationKey(requestDeliveryId: string): string {
    return `${this.keyPrefix}:v2:request-publication:${requestDeliveryId}`;
  }

  private requestPublicationClaimKey(requestDeliveryId: string): string {
    return `${this.keyPrefix}:v2:request-publication-claim:${requestDeliveryId}`;
  }

  private isOutputTopic(topic: Topic): boolean {
    return topic.startsWith("out.req.");
  }

  private async observePendingEntries(
    topic: Topic,
    streamKey: string,
    group: string,
    trigger: "parked" | "subscription_start",
  ): Promise<void> {
    const inspected = await captureRedisPendingSummary(this.redis, streamKey, group);
    const report = inspected.match<() => void>({
      err: () => () => {
        this.logger.warn("event_bus.pending_inspection_failed", {
          topic,
          group,
          trigger,
        });
      },
      ok:
        ({ count: pendingCount, oldestIdleMs }) =>
        () => {
          if (pendingCount === 0) return;
          this.logger.warn("event_bus.pending_entries", {
            topic,
            group,
            trigger,
            pendingCount,
            oldestPendingIdleMs: oldestIdleMs,
          });
        },
    });
    report();
  }

  private scheduleAcknowledgedTrim(topic: Topic, streamKey: string): void {
    if (
      this.closing ||
      this.isOutputTopic(topic) ||
      TAIL_REPLAY_TOPICS.has(topic) ||
      this.trimTimers.has(streamKey)
    ) {
      return;
    }

    const timer = setTimeout(() => {
      this.trimTimers.delete(streamKey);
      this.startAcknowledgedTrim(topic, streamKey);
    }, TRIM_DEBOUNCE_MS);
    timer.unref?.();
    this.trimTimers.set(streamKey, timer);
  }

  private startAcknowledgedTrim(topic: Topic, streamKey: string): void {
    const activeTrim = this.captureAcknowledgedTrim(topic, streamKey);
    this.activeTrims.add(activeTrim);
    void activeTrim.then(() => this.activeTrims.delete(activeTrim));
  }

  private async captureAcknowledgedTrim(topic: Topic, streamKey: string): Promise<void> {
    const trimmed = settleRedisStreamsCapture(
      await Result.tryPromise({
        try: () => this.trimAcknowledgedPrefix(topic, streamKey),
        catch: captureRedisStreamsFailure,
      }),
    );
    trimmed.match({
      ok: () => undefined,
      err: (failure) => {
        if (failure.kind === "panic") {
          if (this.acknowledgedTrimPanic === null) this.acknowledgedTrimPanic = failure.panic;
          return;
        }
        this.logger.error("event_bus.trim_failed", { topic }, failure.error);
      },
    });
  }

  async flushPendingTrims(): Promise<void> {
    for (const [streamKey, timer] of this.trimTimers) {
      clearTimeout(timer);
      this.trimTimers.delete(streamKey);
      this.startAcknowledgedTrim(streamKey.slice(this.keyPrefix.length + 1), streamKey);
    }
    await Promise.allSettled(this.activeTrims);
    if (this.acknowledgedTrimPanic !== null) throw this.acknowledgedTrimPanic;
  }

  private async trimAcknowledgedPrefix(topic: Topic, streamKey: string): Promise<void> {
    const trimmed = await this.redis.eval(TRIM_ACKNOWLEDGED_PREFIX_SCRIPT, 1, streamKey);
    if (typeof trimmed !== "number" || !isRedisCount(trimmed)) {
      throw new Panic({ message: "Redis XTRIM returned an invalid count" });
    }
    if (trimmed > 0) {
      this.logger.debug("event_bus.trimmed", { topic, trimmed });
    }
  }

  async trimBeforeCheckpoint(
    topic: Topic,
    checkpoint: Cursor,
    safetyMargin: number,
  ): Promise<number> {
    const retainedCount = Math.max(1, Math.floor(safetyMargin));
    const trimmed = await this.redis.eval(
      TRIM_BEFORE_CHECKPOINT_SCRIPT,
      1,
      this.streamKey(topic),
      checkpoint,
      String(retainedCount),
    );
    if (typeof trimmed !== "number" || !isRedisCount(trimmed)) {
      throw new Panic({ message: "Redis XTRIM returned an invalid count" });
    }
    if (trimmed > 0) {
      this.logger.debug("event_bus.checkpoint_trimmed", {
        topic,
        checkpoint,
        trimmed,
      });
    }
    return trimmed;
  }

  async retireConsumerGroup(
    topic: Topic,
    group: string,
    confirmSingleVersionRollout: boolean,
  ): Promise<"absent" | "destroyed"> {
    const result = await this.redis.eval(
      RETIRE_CONSUMER_GROUP_SCRIPT,
      1,
      this.streamKey(topic),
      group,
      confirmSingleVersionRollout ? "1" : "0",
    );
    if (result === -1) {
      throw new Error(
        `Refusing to retire consumer group ${group} without a confirmed single-version rollout`,
      );
    }
    if (result === 0) return "absent";
    if (result === 1) return "destroyed";
    throw new Panic({
      message: "Redis XGROUP DESTROY returned an invalid result",
    });
  }

  /** Publish a message via `XADD`. */
  async publish<TData>(
    msg: PublishMessage<TData>,
    opts: PublishOptions,
  ): Promise<import("./types").PublishReceipt> {
    const streamKey = this.streamKey(opts.topic);
    const ts = Date.now();
    const startedAt = Date.now();

    const fields: string[] = [
      "type",
      opts.type,
      "ts",
      String(ts),
      "data",
      SuperJSON.stringify(msg.data ?? null),
    ];

    if (opts.key) {
      fields.push("key", opts.key);
    }

    if (opts.headers) {
      fields.push("headers", SuperJSON.stringify(opts.headers));
    }

    const xaddArgs = ["*", ...fields];
    let published: unknown;
    if (this.isOutputTopic(opts.topic)) {
      published = await this.redis.eval(
        XADD_WITH_EXPIRY_SCRIPT,
        1,
        streamKey,
        String(OUTPUT_STREAM_TTL_SECONDS),
        ...xaddArgs,
      );
    } else {
      published = await this.redis.xadd(streamKey, ...xaddArgs);
    }

    let id: unknown = published;
    let duplicate = false;
    let replayDeadline: number | undefined;
    if (this.isOutputTopic(opts.topic)) {
      if (!Array.isArray(published) || published.length !== 2) {
        throw new Panic({
          message: "Redis output XADD returned an invalid receipt",
        });
      }
      id = published[0];
      const deadlineValue = published[1];
      replayDeadline =
        typeof deadlineValue === "string" ? Number.parseInt(deadlineValue, 10) : Number.NaN;
      if (!Number.isSafeInteger(replayDeadline) || replayDeadline < 0) {
        throw new Panic({
          message: "Redis output XADD returned an invalid replay deadline",
        });
      }
    }

    if (typeof id !== "string" || !isRedisStreamId(id)) {
      throw new Panic({ message: "Redis XADD returned invalid id" });
    }

    if (!QUIET_PUBLISH_TYPES.has(opts.type)) {
      this.logger.debug("event_bus.publish", {
        topic: opts.topic,
        type: opts.type,
        key: opts.key,
        messageId: id,
        hasHeaders: Boolean(opts.headers),
        durationMs: Date.now() - startedAt,
      });
    }

    return {
      id,
      cursor: id,
      duplicate,
      ...(replayDeadline === undefined ? {} : { replayDeadline }),
    };
  }

  async acquireRequestPublicationClaim(
    requestDeliveryId: string,
  ): Promise<RequestPublicationClaimAcquisition> {
    const token = crypto.randomUUID();
    const acquired = await this.redis.eval(
      ACQUIRE_REQUEST_PUBLICATION_CLAIM_SCRIPT,
      1,
      this.requestPublicationClaimKey(requestDeliveryId),
      token,
      String(REQUEST_PUBLICATION_CLAIM_TTL_MS),
    );
    if (acquired === 0) return { status: "contended" };
    if (acquired === 1) {
      return { status: "acquired", claim: { requestDeliveryId, token } };
    }
    return signalEventBusPanic(
      new Panic({
        message: "Redis request publication claim returned an invalid receipt",
      }),
    );
  }

  async publishClaimedRequest<TData>(
    msg: PublishMessage<TData>,
    opts: PublishOptions,
    claim: RequestPublicationClaim,
  ): Promise<RawClaimedRequestPublishOutcome> {
    const streamKey = this.streamKey(opts.topic);
    const fields: string[] = [
      "type",
      opts.type,
      "ts",
      String(Date.now()),
      "data",
      SuperJSON.stringify(msg.data ?? null),
    ];
    if (opts.key) fields.push("key", opts.key);
    if (opts.headers) fields.push("headers", SuperJSON.stringify(opts.headers));

    const result = await this.redis.eval(
      CLAIMED_REQUEST_XADD_SCRIPT,
      3,
      streamKey,
      this.requestPublicationClaimKey(claim.requestDeliveryId),
      this.requestPublicationKey(claim.requestDeliveryId),
      claim.token,
      "*",
      ...fields,
    );
    if (!Array.isArray(result) || (result.length !== 1 && result.length !== 2)) {
      return signalEventBusPanic(
        new Panic({
          message: "Redis claimed request XADD returned an invalid receipt",
        }),
      );
    }
    if (result[0] === "fenced" && result.length === 1) return { status: "fenced" };
    if (
      (result[0] !== "published" && result[0] !== "observed") ||
      typeof result[1] !== "string" ||
      !isRedisStreamId(result[1])
    ) {
      return signalEventBusPanic(
        new Panic({
          message: "Redis claimed request XADD returned invalid fields",
        }),
      );
    }
    const id = result[1];
    return {
      status: "published",
      receipt: { id, cursor: id, duplicate: result[0] === "observed" },
    };
  }

  async confirmRequestPublication(
    claim: RequestPublicationClaim,
    expectedStreamId: string,
  ): Promise<RequestPublicationConfirmation> {
    const confirmed = await this.redis.eval(
      CONFIRM_REQUEST_PUBLICATION_SCRIPT,
      2,
      this.requestPublicationKey(claim.requestDeliveryId),
      this.requestPublicationClaimKey(claim.requestDeliveryId),
      claim.token,
      expectedStreamId,
    );
    if (
      confirmed === "absent" ||
      confirmed === "confirmed" ||
      confirmed === "fenced" ||
      confirmed === "mismatch"
    ) {
      return confirmed;
    }
    return signalEventBusPanic(
      new Panic({
        message: "Redis request publication confirmation returned an invalid receipt",
      }),
    );
  }

  async abandonRequestPublicationClaim(
    claim: RequestPublicationClaim,
  ): Promise<RequestPublicationClaimAbandonment> {
    const abandoned = await this.redis.eval(
      ABANDON_REQUEST_PUBLICATION_CLAIM_SCRIPT,
      2,
      this.requestPublicationClaimKey(claim.requestDeliveryId),
      this.requestPublicationKey(claim.requestDeliveryId),
      claim.token,
    );
    if (
      abandoned === "abandoned" ||
      abandoned === "absent" ||
      abandoned === "fenced" ||
      abandoned === "marker-present"
    ) {
      return abandoned;
    }
    return signalEventBusPanic(
      new Panic({
        message: "Redis request publication abandon returned an invalid receipt",
      }),
    );
  }

  async readOutputStreamExpiry(topic: Topic): Promise<import("./types").RawOutputStreamExpiry> {
    const observed = await this.redis.eval(
      READ_OUTPUT_STREAM_EXPIRY_SCRIPT,
      1,
      this.streamKey(topic),
    );
    if (!Array.isArray(observed) || observed.length < 1 || observed.length > 2) {
      return { kind: "uncertain", reason: "invalid-transport-response" };
    }
    if (observed.length === 1 && observed[0] === "absent") return { kind: "absent" };
    if (observed.length === 1 && observed[0] === "uncertain") {
      return { kind: "uncertain", reason: "stream-has-no-expiry" };
    }
    const expiresAt =
      observed[0] === "present" && typeof observed[1] === "string"
        ? Number.parseInt(observed[1], 10)
        : Number.NaN;
    if (!Number.isSafeInteger(expiresAt) || expiresAt < 0) {
      return { kind: "uncertain", reason: "invalid-transport-response" };
    }
    return { kind: "present", expiresAt };
  }

  /** Fetch messages via `XREAD` (non-durable, no consumer group). */
  async fetch(topic: Topic, opts: FetchOptions) {
    const streamKey = this.streamKey(topic);
    const limit = opts.limit ?? DEFAULT_MAX_MESSAGES;

    const startId = redisIdForOffset(opts.offset);

    const res = (await this.redis.xread(
      "COUNT",
      String(limit),
      "STREAMS",
      streamKey,
      startId,
    )) as unknown;

    const messages: Array<{
      msg: RawMessageDecodeOutcome;
      cursor: Cursor;
      evidence: EventTransportEvidence;
    }> = [];

    const decodedResponse = decodeRedisReadResponse(res, topic, streamKey, this.logger);
    if (decodedResponse.status === "error") throw new Error(decodedResponse.message);
    for (const entry of decodedResponse.value) {
      messages.push({
        msg: entry.message,
        cursor: entry.id,
        evidence: entry.evidence,
      });
    }

    const next = messages.length > 0 ? messages[messages.length - 1]!.cursor : undefined;
    return { messages, next };
  }

  async watermark(topic: Topic): Promise<Cursor | null> {
    const entries = (await this.redis.xrevrange(
      this.streamKey(topic),
      "+",
      "-",
      "COUNT",
      1,
    )) as unknown;
    const decoded = decodeRedisWatermarkResponse(entries);
    if (decoded.status === "error") throw new Error(decoded.message);
    return decoded.value.watermark;
  }

  /** Subscribe with transport-owned delivery actions and typed operational Results. */
  async subscribe(
    topic: Topic,
    opts: SubscriptionOptions,
    handler: RawDeliveryHandler,
    dependencies: RawDeliveryDependencies = {},
  ): Promise<
    ResultType<
      {
        readonly done: Promise<ResultType<void, EventDeliveryDoneError>>;
        stop(): Promise<ResultType<void, EventDeliveryStopFailed>>;
      },
      EventDeliveryStartFailed
    >
  > {
    const streamKey = this.streamKey(topic);
    if (opts.mode !== "tail" && this.isOutputTopic(topic)) {
      return Result.err(
        new EventDeliveryStartFailed({
          cause: new Error("Expiring output streams support tail subscriptions only"),
          topic,
          message: "Durable Redis delivery is not supported for output streams",
        }),
      );
    }

    const abortController = new AbortController();
    const acquired = await this.subPool.acquire();
    const lease = acquired.match<RedisLease | EventDeliveryStartFailed>({
      ok: (value) => value,
      err: (error) =>
        new EventDeliveryStartFailed({
          cause: error,
          topic,
          message: "Failed to acquire a Redis delivery connection",
        }),
    });
    if (EventDeliveryStartFailed.is(lease)) {
      return Result.err(lease);
    }

    const subRedis = lease.redis;
    let disconnectOnStop = false;
    let releaseUnhealthy = false;
    let group: string | null = null;
    let consumerId: string | null = null;
    let managedDelivery: RedisManagedDelivery | null = null;
    let managedRedisClient: Redis | null = null;
    let createdGroup = false;
    const subscriptionOwnerKey = `${streamKey}:subscription-owner:${this.ownerId}:${randomConsumerId()}`;
    const subscriptionRegistryKey = `${streamKey}:subscription-owners:v1`;
    let maintenanceTimer: ReturnType<typeof setInterval> | undefined;
    let maintenanceCursor = "0";
    let maintenancePending: Promise<void> | undefined;
    let maintenanceFailure: CapturedRedisStreamsFailure | undefined;
    const maintainSubscription = async (): Promise<void> => {
      const response = decodeSubscriptionMaintenance(
        await this.redis.eval(
          SUBSCRIPTION_MAINTAIN_SCRIPT,
          3,
          subscriptionOwnerKey,
          subscriptionRegistryKey,
          streamKey,
          maintenanceCursor,
        ),
      );
      if (!response.success)
        return signalEventBusPanic("Invalid subscription maintenance response");
      if (response.data[0] === "expired" && response.data.length === 1) {
        if (!ephemeral && group && consumerId) {
          await this.redis.eval(
            SUBSCRIPTION_REGISTER_SCRIPT,
            2,
            subscriptionOwnerKey,
            subscriptionRegistryKey,
            JSON.stringify([group, consumerId, ephemeral]),
          );
          return;
        }
        maintenanceFailure = ownedRedisStreamsFailure(
          new Error("Subscription owner lease expired"),
        );
        abortController.abort();
        releaseUnhealthy = true;
        subRedis.disconnect();
        return;
      }
      maintenanceCursor = response.data[0];
      const destroyed = response.data[1] ?? [];
      for (const [registration, abandonedGroup] of destroyed) {
        await new RedisManagedDelivery(
          this.redis,
          streamKey,
          abandonedGroup,
          "reaper",
          this.ownerId,
        ).clearAllState();
        await this.redis.hdel(subscriptionRegistryKey, registration);
      }
    };
    const tickMaintenance = (): void => {
      if (maintenancePending || abortController.signal.aborted) return;
      maintenancePending = Result.tryPromise({
        try: maintainSubscription,
        catch: captureRedisStreamsFailure,
      }).then(async (captured) => {
        const failure = settleRedisStreamsCapture(captured).match({
          ok: () => undefined,
          err: (error) => error,
        });
        maintenancePending = undefined;
        if (!failure) return;
        abortController.abort();
        releaseUnhealthy = true;
        subRedis.disconnect();
        maintenanceFailure = failure;
        this.logger.error("event_bus.subscription_maintenance_failed", { topic });
        if (failure.kind === "panic") await reportFatal(failure.panic, "0-0", "delivery-action");
      });
    };
    const ephemeral = opts.mode !== "tail" && Boolean(opts.ephemeral);
    const ephemeralIncarnation = ephemeral ? randomConsumerId() : undefined;
    const tailMaxMessages =
      opts.mode === "tail" ? (opts.batch?.maxMessages ?? DEFAULT_MAX_MESSAGES) : 1;
    const blockMs = Math.min(Math.max(1, opts.batch?.maxWaitMs ?? DEFAULT_BLOCK_MS), 1_000);

    const initializeDelivery = async (): Promise<ResultType<void, EventDeliveryStartFailed>> => {
      if (opts.mode === "work" || opts.mode === "fanout") {
        consumerId = opts.consumerId ?? randomConsumerId();
        group = managedRedisPhysicalGroup(
          opts.mode,
          opts.subscriptionId,
          ephemeral,
          ephemeralIncarnation,
        );
        const ensuredGroup = await ensureGroup({
          redis: subRedis,
          streamKey,
          group,
          startId: opts.startFrom === "beginning" ? "0" : "$",
          logger: this.logger,
        });
        const initializedGroup = ensuredGroup.match<boolean | EventDeliveryStartFailed>({
          ok: (value) => value,
          err: (error) =>
            new EventDeliveryStartFailed({
              cause: error,
              topic,
              message: "Failed to initialize Redis delivery",
            }),
        });
        if (EventDeliveryStartFailed.is(initializedGroup)) {
          return Result.err(initializedGroup);
        }
        createdGroup = initializedGroup;
        await this.redis.eval(
          SUBSCRIPTION_REGISTER_SCRIPT,
          2,
          subscriptionOwnerKey,
          subscriptionRegistryKey,
          JSON.stringify([group, consumerId, ephemeral]),
        );
        await maintainSubscription();
        maintenanceTimer = setInterval(tickMaintenance, 10_000);
        maintenanceTimer.unref();
        if (opts.ephemeral && !createdGroup) {
          return Result.err(
            new EventDeliveryStartFailed({
              cause: new Error(`Ephemeral consumer group already exists: ${group}`),
              topic,
              message: "Failed to initialize Redis delivery",
            }),
          );
        }
        if (!createdGroup) {
          void this.observePendingEntries(topic, streamKey, group, "subscription_start");
        }
        managedRedisClient = this.redis.duplicate();
        managedDelivery = new RedisManagedDelivery(
          managedRedisClient,
          streamKey,
          group,
          consumerId,
          this.ownerId,
        );
      }
      return Result.ok(undefined);
    };
    const cleanupFailedInitialization = async (): Promise<
      CapturedRedisStreamsFailure | undefined
    > => {
      const rollbackCreatedGroup = async (
        physicalGroup: string,
      ): Promise<CapturedRedisStreamsFailure | undefined> => {
        const destroyed = settleRedisStreamsCapture(
          await Result.tryPromise({
            try: async (): Promise<boolean> =>
              (await subRedis.xgroup("DESTROY", streamKey, physicalGroup)) === 1,
            catch: captureRedisStreamsFailure,
          }),
        );
        return destroyed.match<CapturedRedisStreamsFailure | undefined>({
          ok: (removed) => {
            if (removed) {
              createdGroup = false;
              return undefined;
            }
            return ownedRedisStreamsFailure(
              new Error(
                "Redis XGROUP DESTROY returned an invalid initialization rollback response",
              ),
            );
          },
          err: (failure) => failure,
        });
      };
      clearInterval(maintenanceTimer);
      await maintenancePending;
      const rolledBack =
        ephemeral && createdGroup && group !== null ? await rollbackCreatedGroup(group) : undefined;
      const disconnected = settleRedisStreamsCapture(
        Result.try({
          try: () => disconnectRedisClient(managedRedisClient),
          catch: captureRedisStreamsFailure,
        }),
      ).match<CapturedRedisStreamsFailure | undefined>({
        ok: () => undefined,
        err: (failure) => failure,
      });
      const released = await Result.tryPromise({
        try: () => lease.release({ unhealthy: true }),
        catch: captureRedisStreamsFailure,
      }).then((result) =>
        settleRedisStreamsCapture(result).match<CapturedRedisStreamsFailure | undefined>({
          ok: () => undefined,
          err: (failure) => failure,
        }),
      );
      if (rolledBack?.kind === "panic") return rolledBack;
      if (disconnected?.kind === "panic") return disconnected;
      if (released?.kind === "panic") return released;
      return rolledBack ?? disconnected ?? released;
    };
    const initialized = settleRedisStreamsCapture(
      await Result.tryPromise({
        try: initializeDelivery,
        catch: captureRedisStreamsFailure,
      }),
    );
    const capturedInitializeFailure = initialized.match({
      ok: () => undefined,
      err: (failure) => failure,
    });
    if (capturedInitializeFailure) {
      const cleanupFailure = await cleanupFailedInitialization();
      if (capturedInitializeFailure.kind === "panic") {
        return signalEventBusPanic(capturedInitializeFailure.panic);
      }
      if (cleanupFailure?.kind === "panic") return signalEventBusPanic(cleanupFailure.panic);
      return Result.err(
        new EventDeliveryStartFailed({
          cause: capturedInitializeFailure.restoreCause(),
          topic,
          message: "Failed to initialize Redis delivery",
        }),
      );
    }
    const setupError = initialized.match({
      ok: (result) => result.match({ ok: () => undefined, err: (error) => error }),
      err: () => undefined,
    });
    if (setupError) {
      const cleanupFailure = await cleanupFailedInitialization();
      if (cleanupFailure?.kind === "panic") return signalEventBusPanic(cleanupFailure.panic);
      return Result.err(setupError);
    }

    const reportFatal = async (
      cause: unknown,
      cursor: Cursor,
      phase: "handler" | "dead-letter" | "delivery-action",
    ): Promise<void> => {
      const report = async () => dependencies.reportFatal?.report(cause, { topic, cursor, phase });
      const reported = settleRedisStreamsCapture(
        await Result.tryPromise({
          try: report,
          catch: captureRedisStreamsFailure,
        }),
      );
      const reportFailure = reported.match({
        ok: () => undefined,
        err: (failure) => failure,
      });
      if (reportFailure) {
        dependencies.logger?.error("event_bus.fatal_report_failed", {
          topic,
          cursor,
          phase,
        });
        this.logger.error(
          "event_bus.fatal_report_failed",
          { topic, cursor, phase },
          reportFailure.kind === "panic" ? reportFailure.panic : reportFailure.restoreCause(),
        );
      }
    };

    type EntryHandlingResult =
      | { readonly status: "advance" }
      | { readonly status: "park" }
      | { readonly status: "stop"; readonly error: EventDeliveryStopped }
      | {
          readonly status: "post-commit-error";
          readonly error: EventPostCommitObservationFailed;
        }
      | {
          readonly status: "transport-error";
          readonly error: EventDeliveryTransportFailed;
        };

    const handleTailEntry = async (entry: RedisReadEntry): Promise<EntryHandlingResult> => {
      const id = entry.id;
      const invokeTailHandler = async () =>
        deliveryAction(
          await handler(entry.message, {
            cursor: id,
            mode: "tail",
            evidence: entry.evidence,
          }),
        );
      const handled = settleRedisStreamsCapture(
        await Result.tryPromise({
          try: invokeTailHandler,
          catch: captureRedisStreamsFailure,
        }),
      );
      const handlerOutcome = redisStreamsOutcome(handled);
      if (handlerOutcome.kind === "error") {
        const handlerFailure = handlerOutcome.error;
        const phase = handlerFailure.kind === "panic" ? "delivery-action" : "handler";
        const cause =
          handlerFailure.kind === "panic" ? handlerFailure.panic : handlerFailure.restoreCause();
        await reportFatal(cause, id, phase);
        throw handlerFailure.kind === "panic"
          ? handlerFailure.panic
          : handlerFailure.restoreCause();
      }
      const action = handlerOutcome.value;

      switch (action.disposition) {
        case "commit":
          return { status: "advance" };
        case "park-pending":
          return {
            status: "stop",
            error: new EventDeliveryStopped({
              reason: "tail-cannot-park",
              topic,
              cursor: id,
              message: "Tail delivery stopped because park-pending is not durable in tail mode",
            }),
          };
        case "retry":
          return {
            status: "stop",
            error: new EventDeliveryStopped({
              reason: "tail-cannot-park",
              topic,
              cursor: id,
              message: "Tail delivery stopped because retry is not supported in tail mode",
            }),
          };
        case "stop":
          return {
            status: "stop",
            error: new EventDeliveryStopped({
              reason: "requested",
              topic,
              cursor: id,
              message: "Event delivery policy requested stop",
            }),
          };
        case "dead-letter": {
          let accepted: ResultType<EventDeadLetterAcceptance, EventDeadLetterAcceptFailed>;
          if (!dependencies.deadLetter) {
            accepted = Result.err(
              new EventDeadLetterAcceptFailed({
                cause: new Error("No event dead-letter adapter is configured"),
                message: "No event dead-letter adapter is configured",
              }),
            );
          } else {
            const deadLetter = dependencies.deadLetter;
            const acceptDeadLetter = async () =>
              checkedDeadLetterAcceptance(
                await deadLetter.accept(
                  createTailEventDeadLetterRecord({
                    topic,
                    cursor: id,
                    reason: action.reason,
                    evidence: entry.evidence,
                  }),
                ),
              );
            const deadLettered = settleRedisStreamsCapture(
              await Result.tryPromise({
                try: acceptDeadLetter,
                catch: captureRedisStreamsFailure,
              }),
            );
            const deadLetterOutcome = redisStreamsOutcome(deadLettered);
            if (deadLetterOutcome.kind === "error") {
              const deadLetterFailure = deadLetterOutcome.error;
              const cause =
                deadLetterFailure.kind === "panic"
                  ? deadLetterFailure.panic
                  : deadLetterFailure.restoreCause();
              await reportFatal(cause, id, "dead-letter");
              throw deadLetterFailure.kind === "panic"
                ? deadLetterFailure.panic
                : deadLetterFailure.restoreCause();
            }
            accepted = deadLetterOutcome.value;
          }

          return accepted.match<EntryHandlingResult>({
            ok: () => ({ status: "advance" }),
            err: () => {
              dependencies.logger?.error("event_bus.dead_letter_failed", {
                topic,
                cursor: id,
                mode: opts.mode,
              });
              return {
                status: "stop",
                error: new EventDeliveryStopped({
                  reason: "dead-letter-failed",
                  topic,
                  cursor: id,
                  message: "Tail delivery stopped after dead-letter acceptance failed",
                }),
              };
            },
          });
        }
      }
    };

    const readFailure = (cause: unknown, cursor?: Cursor): EventDeliveryTransportFailed =>
      new EventDeliveryTransportFailed({
        cause,
        operation: "read",
        topic,
        cursor,
        message: "Redis delivery read failed",
      });

    type ActiveAttempt = { shutdown(): void };
    let activeAttempt: ActiveAttempt | null = null;

    const runTailLoop = async (): Promise<ResultType<void, EventDeliveryDoneError>> => {
      if (opts.mode !== "tail") {
        throw new Panic({
          message: "Tail delivery loop started for a durable subscription",
        });
      }
      let cursor = redisIdForOptionalOffset(opts.offset);
      while (!abortController.signal.aborted) {
        const read = settleRedisStreamsCapture(
          await Result.tryPromise({
            try: () =>
              subRedis.xread(
                "COUNT",
                String(tailMaxMessages),
                "BLOCK",
                String(blockMs),
                "STREAMS",
                streamKey,
                cursor,
              ),
            catch: captureRedisStreamsFailure,
          }),
        );
        const readError = read.match({
          ok: () => undefined,
          err: (failure) => failure,
        });
        if (readError) {
          if (readError.kind === "panic") throw readError.panic;
          if (
            disconnectOnStop &&
            abortController.signal.aborted &&
            isClosedRedisConnectionFailure(readError)
          ) {
            return Result.ok(undefined);
          }
          releaseUnhealthy = true;
          return Result.err(readFailure(readError.restoreCause(), cursor));
        }
        const response: unknown = read.match({
          ok: (value) => value,
          err: () => undefined,
        });

        const decodedResponse = decodeRedisReadResponse(response, topic, streamKey, this.logger);
        if (decodedResponse.status === "error") {
          releaseUnhealthy = true;
          return Result.err(readFailure(new Error(decodedResponse.message), cursor));
        }
        for (const entry of decodedResponse.value) {
          const handled = await handleTailEntry(entry);
          if (handled.status === "stop") return Result.err(handled.error);
          if (handled.status === "transport-error") return Result.err(handled.error);
          if (handled.status === "park") {
            throw new Panic({
              message: "Tail delivery produced an impossible park action",
            });
          }
          cursor = entry.id;
        }
      }
      return Result.ok(undefined);
    };

    let shutdownTransportFailure: EventDeliveryTransportFailed | null = null;
    const runDurableLoop = async (): Promise<ResultType<void, EventDeliveryDoneError>> => {
      if (
        opts.mode === "tail" ||
        group === null ||
        consumerId === null ||
        managedDelivery === null
      ) {
        throw new Panic({
          message: "Managed Redis delivery started without durable identities",
        });
      }
      const mode = opts.mode;
      const physicalGroup = group;
      const durableConsumerId = consumerId;
      const managed = managedDelivery;

      type CapturedTransport<T> =
        | { readonly status: "ok"; readonly value: T }
        | {
            readonly status: "error";
            readonly error: EventDeliveryTransportFailed;
          };
      const captureTransport = async <T>(
        operation: () => Promise<T>,
        operationName: "read" | "ack",
        cursor: Cursor | undefined,
        message: string,
      ): Promise<CapturedTransport<T>> => {
        const captured = settleRedisStreamsCapture(
          await Result.tryPromise({
            try: operation,
            catch: captureRedisStreamsFailure,
          }),
        );
        const outcome = redisStreamsOutcome(captured);
        if (outcome.kind === "ok") return { status: "ok", value: outcome.value };
        if (outcome.error.kind === "panic") throw outcome.error.panic;
        const error = new EventDeliveryTransportFailed({
          cause: outcome.error.restoreCause(),
          operation: operationName,
          topic,
          cursor,
          message,
        });
        // Stop disconnects the managed client to unblock commands. Only that closure is normal shutdown.
        if (abortController.signal.aborted && isClosedRedisConnectionFailure(outcome.error)) {
          shutdownTransportFailure = error;
        }
        return { status: "error", error };
      };

      type LeaseLoss =
        | { readonly kind: "shutdown" }
        | { readonly kind: "stale" }
        | {
            readonly kind: "error";
            readonly failure: CapturedRedisStreamsFailure;
          };
      const startLeaseHeartbeat = (id: Cursor, initialLease: ManagedLease) => {
        const attemptController = new AbortController();
        const lossResolvers = Promise.withResolvers<LeaseLoss>();
        let loss: LeaseLoss | null = null;
        let lease = initialLease;
        let stopped = false;
        let timer: ReturnType<typeof setTimeout> | null = null;
        let heartbeatTask: Promise<void> | null = null;

        const lose = (nextLoss: LeaseLoss): void => {
          if (loss !== null) return;
          loss = nextLoss;
          stopped = true;
          if (timer !== null) clearTimeout(timer);
          timer = null;
          attemptController.abort();
          lossResolvers.resolve(nextLoss);
        };
        const schedule = (): void => {
          if (stopped) return;
          timer = setTimeout(() => {
            timer = null;
            heartbeatTask = (async () => {
              const heartbeated = settleRedisStreamsCapture(
                await Result.tryPromise({
                  try: () => managed.heartbeat(id, lease),
                  catch: captureRedisStreamsFailure,
                }),
              );
              const heartbeatOutcome = redisStreamsOutcome(heartbeated);
              if (heartbeatOutcome.kind === "error") {
                lose({ kind: "error", failure: heartbeatOutcome.error });
                return;
              }
              const heartbeat = heartbeatOutcome.value;
              if (heartbeat.status === "stale") {
                lose({ kind: "stale" });
                return;
              }
              lease = heartbeat.lease;
              schedule();
            })();
            void heartbeatTask;
          }, MANAGED_REDIS_HEARTBEAT_MS);
          timer.unref?.();
        };
        const control: ActiveAttempt = {
          shutdown: () => lose({ kind: "shutdown" }),
        };
        activeAttempt = control;
        schedule();

        return {
          signal: attemptController.signal,
          loss: lossResolvers.promise,
          currentLoss: (): LeaseLoss | null => loss,
          close: async (): Promise<void> => {
            stopped = true;
            if (timer !== null) clearTimeout(timer);
            timer = null;
            await heartbeatTask;
            if (activeAttempt === control) activeAttempt = null;
          },
        };
      };

      const handleLeaseLoss = async (id: Cursor, loss: LeaseLoss): Promise<EntryHandlingResult> => {
        if (loss.kind === "shutdown" || loss.kind === "stale") return { status: "advance" };
        if (loss.failure.kind === "panic") {
          await reportFatal(loss.failure.panic, id, "delivery-action");
          throw loss.failure.panic;
        }
        return {
          status: "transport-error",
          error: new EventDeliveryTransportFailed({
            cause: loss.failure.restoreCause(),
            operation: "read",
            topic,
            cursor: id,
            message: "Redis delivery heartbeat failed",
          }),
        };
      };

      const loadRecoveryEntry = async (id: Cursor): Promise<CapturedTransport<RedisReadEntry>> =>
        captureTransport(
          async () => {
            if (!managedRedisClient) {
              throw new Panic({
                message: "Managed Redis recovery connection is unavailable",
              });
            }
            const response = (await managedRedisClient.xrange(
              streamKey,
              id,
              id,
              "COUNT",
              1,
            )) as unknown;
            const decoded = decodeRedisRangeResponse(response, topic, streamKey, id, this.logger);
            if (decoded.status === "error") throw new Error(decoded.message);
            return decoded.value;
          },
          "read",
          id,
          "Redis delivery source recovery failed",
        );

      const deadLetterManaged = async (
        entry: RedisReadEntry,
        lease: ManagedLease,
        reason: EventDeadLetterReason,
      ): Promise<EntryHandlingResult> => {
        const scope = startLeaseHeartbeat(entry.id, lease);
        type Preparation =
          | {
              readonly status: "prepared";
              readonly material: ManagedTerminalMaterial;
            }
          | {
              readonly status: "failed";
              readonly failure: CapturedRedisStreamsFailure;
            };
        const deadLetter = dependencies.deadLetter;
        const prepareDeadLetter = async (): Promise<ManagedTerminalMaterial> => {
          const recordedAt = await deadLetter!.serverTimeMs();
          const record = createManagedEventDeadLetterRecord({
            topic,
            cursor: entry.id,
            mode,
            physicalGroup,
            attempt: lease.attempt,
            recordedAt,
            reason,
            evidence: entry.evidence,
          });
          return await deadLetter!.prepare(record);
        };
        const preparation: Promise<Preparation> = deadLetter
          ? Result.tryPromise({
              try: prepareDeadLetter,
              catch: captureRedisStreamsFailure,
            }).then((prepared) =>
              settleRedisStreamsCapture(prepared).match({
                ok: (material): Preparation => ({
                  status: "prepared",
                  material,
                }),
                err: (failure): Preparation => ({
                  status: "failed",
                  failure,
                }),
              }),
            )
          : Promise.resolve({
              status: "failed",
              failure: ownedRedisStreamsFailure(
                new Error("No event dead-letter adapter is configured"),
              ),
            });
        const completed = await Promise.race([
          preparation,
          scope.loss.then(
            (lost): Preparation | { readonly status: "lease-lost"; loss: LeaseLoss } => ({
              status: "lease-lost",
              loss: lost,
            }),
          ),
        ]);
        await scope.close();
        const currentLoss = scope.currentLoss();
        if (currentLoss !== null) return handleLeaseLoss(entry.id, currentLoss);
        if (completed.status === "lease-lost") return handleLeaseLoss(entry.id, completed.loss);
        if (completed.status === "failed") {
          if (completed.failure.kind === "panic") {
            await reportFatal(completed.failure.panic, entry.id, "dead-letter");
            throw completed.failure.panic;
          }
          dependencies.logger?.error("event_bus.dead_letter_failed", {
            topic,
            cursor: entry.id,
            mode,
          });
          return {
            status: "transport-error",
            error: new EventDeliveryTransportFailed({
              cause: completed.failure.restoreCause(),
              operation: "ack",
              topic,
              cursor: entry.id,
              message: "Redis managed dead-letter preparation failed",
            }),
          };
        }
        if (abortController.signal.aborted) return { status: "advance" };

        const finalizeDeadLetter = async (): Promise<EntryHandlingResult> => {
          const staged = await managed.stageTerminal(entry.id, lease, completed.material);
          if (staged.status === "stale") return { status: "advance" };
          const finalized = await managed.finalizeTerminal(entry.id, lease);
          if (finalized.status === "stale") return { status: "advance" };
          this.scheduleAcknowledgedTrim(topic, streamKey);
          return { status: "advance" };
        };
        const finalized = settleRedisStreamsCapture(
          await Result.tryPromise({
            try: finalizeDeadLetter,
            catch: captureRedisStreamsFailure,
          }),
        );
        const finalizeOutcome = redisStreamsOutcome(finalized);
        if (finalizeOutcome.kind === "error") {
          if (finalizeOutcome.error.kind === "panic") {
            await reportFatal(finalizeOutcome.error.panic, entry.id, "dead-letter");
            throw finalizeOutcome.error.panic;
          }
          return {
            status: "transport-error",
            error: new EventDeliveryTransportFailed({
              cause: finalizeOutcome.error.restoreCause(),
              operation: "ack",
              topic,
              cursor: entry.id,
              message: "Redis managed dead-letter finalization failed",
            }),
          };
        }
        return finalizeOutcome.value;
      };

      const beginDeadLetterManaged = async (
        entry: RedisReadEntry,
        ownership: ManagedLease | ManagedClaim,
        reason: EventDeadLetterReason,
      ): Promise<EntryHandlingResult> => {
        const preparing = await captureTransport(
          () => managed.beginTerminal(entry.id, ownership, reason),
          "ack",
          entry.id,
          "Redis managed terminal preparation transition failed",
        );
        if (preparing.status === "error") {
          return { status: "transport-error", error: preparing.error };
        }
        if (preparing.value.status === "stale") return { status: "advance" };
        return deadLetterManaged(entry, preparing.value.lease, preparing.value.reason);
      };

      const handleManagedEntry = async (
        entry: RedisReadEntry,
        lease: ManagedLease,
      ): Promise<EntryHandlingResult> => {
        const scope = startLeaseHeartbeat(entry.id, lease);
        type HandlerCompletion =
          | { readonly status: "action"; readonly action: RawDeliveryAction }
          | {
              readonly status: "defect";
              readonly failure: CapturedRedisStreamsFailure;
            };
        const invokeHandler = async (): Promise<RawDeliveryAction> =>
          deliveryAction(
            await handler(entry.message, {
              cursor: entry.id,
              mode,
              evidence: entry.evidence,
              deliveryId: lease.deliveryId,
              attempt: lease.attempt,
              leaseDeadline: lease.leaseDeadline,
              signal: scope.signal,
            }),
          );
        const handlerCompletion: Promise<HandlerCompletion> = Result.tryPromise({
          try: invokeHandler,
          catch: captureRedisStreamsFailure,
        }).then(async (invoked) =>
          settleRedisStreamsCapture(invoked).match<Promise<HandlerCompletion>>({
            ok: async (action) => ({
              status: "action",
              action,
            }),
            err: async (failure) => {
              const phase = failure.kind === "panic" ? "delivery-action" : "handler";
              await reportFatal(
                failure.kind === "panic" ? failure.panic : failure.restoreCause(),
                entry.id,
                phase,
              );
              return { status: "defect", failure };
            },
          }),
        );
        const completed = await Promise.race([
          handlerCompletion,
          scope.loss.then(
            (lost): HandlerCompletion | { readonly status: "lease-lost"; loss: LeaseLoss } => ({
              status: "lease-lost",
              loss: lost,
            }),
          ),
        ]);
        await scope.close();
        const currentLoss = scope.currentLoss();
        if (currentLoss !== null) return handleLeaseLoss(entry.id, currentLoss);
        if (completed.status === "lease-lost") return handleLeaseLoss(entry.id, completed.loss);
        if (completed.status === "defect") {
          if (completed.failure.kind === "panic") {
            throw completed.failure.panic;
          }
          throw completed.failure.restoreCause();
        }
        if (abortController.signal.aborted) return { status: "advance" };
        const action = completed.action;

        switch (action.disposition) {
          case "commit": {
            const committed = await captureTransport(
              () => managed.commit(entry.id, lease),
              "ack",
              entry.id,
              "Redis managed delivery commit failed",
            );
            if (committed.status === "error") {
              return { status: "transport-error", error: committed.error };
            }
            if (committed.value.status === "committed") {
              this.scheduleAcknowledgedTrim(topic, streamKey);
              if (action.observePostCommit !== undefined) {
                const observed = settleRedisStreamsCapture(
                  await Result.tryPromise({
                    try: action.observePostCommit,
                    catch: captureRedisStreamsFailure,
                  }),
                );
                const observationOutcome = redisStreamsOutcome(observed);
                if (observationOutcome.kind === "error") {
                  const failure = observationOutcome.error;
                  if (failure.kind === "panic") throw failure.panic;
                  return {
                    status: "post-commit-error",
                    error: new EventPostCommitObservationFailed({
                      cause: failure.restoreCause(),
                      topic,
                      cursor: entry.id,
                      message: "Post-commit observation failed",
                    }),
                  };
                }
                const result = observationOutcome.value;
                const observationError = result.match({
                  ok: () => undefined,
                  err: (error) => error,
                });
                if (observationError !== undefined) {
                  return {
                    status: "post-commit-error",
                    error: observationError,
                  };
                }
              }
            }
            return { status: "advance" };
          }
          case "retry": {
            const retried = await captureTransport(
              () => managed.scheduleRetry(entry.id, lease, action.failure),
              "ack",
              entry.id,
              "Redis managed delivery retry scheduling failed",
            );
            if (retried.status === "error") {
              return { status: "transport-error", error: retried.error };
            }
            if (retried.value.status === "exhausted") {
              return beginDeadLetterManaged(
                entry,
                retried.value.lease,
                createAttemptsExhaustedDeadLetterReason({
                  finalFailure: retried.value.finalFailure,
                }),
              );
            }
            return { status: "advance" };
          }
          case "park-pending": {
            const parked = await captureTransport(
              () => managed.park(entry.id, lease),
              "ack",
              entry.id,
              "Redis managed delivery parking failed",
            );
            if (parked.status === "error") {
              return { status: "transport-error", error: parked.error };
            }
            if (parked.value.status === "parked") {
              void this.observePendingEntries(topic, streamKey, physicalGroup, "parked");
              return { status: "park" };
            }
            return { status: "advance" };
          }
          case "dead-letter":
            return beginDeadLetterManaged(entry, lease, action.reason);
          case "stop":
            return {
              status: "stop",
              error: new EventDeliveryStopped({
                reason: "requested",
                topic,
                cursor: entry.id,
                message: "Event delivery policy requested stop",
              }),
            };
        }
      };

      const invokeManagedEntry = async (
        entry: RedisReadEntry,
        claim: ManagedClaim,
      ): Promise<EntryHandlingResult> => {
        if (abortController.signal.aborted) return { status: "advance" };
        const begun = await captureTransport(
          () => managed.beginInvocation(entry.id, claim),
          "read",
          entry.id,
          "Redis managed invocation transition failed",
        );
        if (begun.status === "error") return { status: "transport-error", error: begun.error };
        if (begun.value.status === "stale") return { status: "advance" };
        if (begun.value.status === "exhausted") {
          throw new Panic({
            message: "Managed recovery attempted a sixth invocation",
          });
        }
        if (abortController.signal.aborted) return { status: "advance" };
        return handleManagedEntry(entry, begun.value.lease);
      };

      const handleExhausted = async (
        id: Cursor,
        lease: ManagedLease,
        finalFailure: ManagedExhaustionFailure,
      ): Promise<EntryHandlingResult> => {
        const loaded = await loadRecoveryEntry(id);
        if (loaded.status === "error") {
          return { status: "transport-error", error: loaded.error };
        }
        return beginDeadLetterManaged(
          loaded.value,
          lease,
          createAttemptsExhaustedDeadLetterReason({ finalFailure }),
        );
      };

      let recoveryBatchSize = 0;
      while (!abortController.signal.aborted) {
        const recovered = await captureTransport(
          () => managed.claimRecoverable(),
          "read",
          undefined,
          "Redis managed delivery recovery failed",
        );
        if (recovered.status === "error") return Result.err(recovered.error);

        let recoveryHandled: EntryHandlingResult | null = null;
        const recovery = recovered.value;
        switch (recovery.status) {
          case "none":
            break;
          case "terminal": {
            const recoveryId = recovery.id;
            const recoveryLease = recovery.lease;
            const finalized = await captureTransport(
              () => managed.finalizeTerminal(recoveryId, recoveryLease),
              "ack",
              recoveryId,
              "Redis managed terminal recovery failed",
            );
            if (finalized.status === "error") return Result.err(finalized.error);
            if (finalized.value.status === "finalized") {
              this.scheduleAcknowledgedTrim(topic, streamKey);
            }
            recoveryHandled = { status: "advance" };
            break;
          }
          case "prepare-terminal": {
            const loaded = await loadRecoveryEntry(recovery.id);
            if (loaded.status === "error") return Result.err(loaded.error);
            recoveryHandled = await deadLetterManaged(
              loaded.value,
              recovery.lease,
              recovery.reason,
            );
            break;
          }
          case "exhausted":
            recoveryHandled = await handleExhausted(
              recovery.id,
              recovery.lease,
              recovery.finalFailure,
            );
            break;
          case "claimed": {
            const loaded = await loadRecoveryEntry(recovery.id);
            if (loaded.status === "error") return Result.err(loaded.error);
            recoveryHandled = await invokeManagedEntry(loaded.value, recovery.claim);
            break;
          }
        }
        if (recoveryHandled?.status === "stop") return Result.err(recoveryHandled.error);
        if (recoveryHandled?.status === "transport-error") {
          return Result.err(recoveryHandled.error);
        }
        if (recoveryHandled?.status === "post-commit-error") {
          return Result.err(recoveryHandled.error);
        }
        if (abortController.signal.aborted) break;
        if (recoveryHandled && ++recoveryBatchSize < 64) continue;
        recoveryBatchSize = 0;

        const read = settleRedisStreamsCapture(
          await Result.tryPromise({
            try: () =>
              subRedis.xreadgroup(
                "GROUP",
                physicalGroup,
                durableConsumerId,
                "COUNT",
                "1",
                "BLOCK",
                String(blockMs),
                "STREAMS",
                streamKey,
                ">",
              ),
            catch: captureRedisStreamsFailure,
          }),
        );
        const readError = read.match({
          ok: () => undefined,
          err: (failure) => failure,
        });
        if (readError) {
          if (maintenanceFailure) {
            if (maintenanceFailure.kind === "panic") throw maintenanceFailure.panic;
            return Result.err(readFailure(maintenanceFailure.restoreCause()));
          }
          if (readError.kind === "panic") throw readError.panic;
          if (
            disconnectOnStop &&
            abortController.signal.aborted &&
            isClosedRedisConnectionFailure(readError)
          ) {
            return Result.ok(undefined);
          }
          releaseUnhealthy = true;
          return Result.err(readFailure(readError.restoreCause()));
        }
        const response: unknown = read.match({
          ok: (value) => value,
          err: () => undefined,
        });

        const decodedResponse = decodeRedisReadResponse(response, topic, streamKey, this.logger);
        if (decodedResponse.status === "error") {
          releaseUnhealthy = true;
          return Result.err(readFailure(new Error(decodedResponse.message)));
        }
        for (const entry of decodedResponse.value) {
          if (abortController.signal.aborted) break;
          const begun = await captureTransport(
            () => managed.beginFresh(entry.id),
            "read",
            entry.id,
            "Redis managed fresh delivery initialization failed",
          );
          if (begun.status === "error") return Result.err(begun.error);
          if (begun.value.status === "stale") continue;
          const handled = await invokeManagedEntry(entry, begun.value.claim);
          if (handled.status === "stop") return Result.err(handled.error);
          if (handled.status === "transport-error") return Result.err(handled.error);
          if (handled.status === "post-commit-error") return Result.err(handled.error);
        }
      }
      if (maintenanceFailure) {
        if (maintenanceFailure.kind === "panic") throw maintenanceFailure.panic;
        return Result.err(readFailure(maintenanceFailure.restoreCause()));
      }
      return Result.ok(undefined);
    };

    const runLoop = async (): Promise<ResultType<void, EventDeliveryDoneError>> => {
      const result = await (opts.mode === "tail" ? runTailLoop() : runDurableLoop());
      return result.tryRecover((error) => {
        if (error === shutdownTransportFailure && !maintenanceFailure) return Result.ok(undefined);
        return Result.err(error);
      });
    };

    type CleanupAttempt =
      | { readonly status: "ok" }
      | {
          readonly status: "error";
          readonly failure: CapturedRedisStreamsFailure;
        };
    let leaseCleanup: Promise<CleanupAttempt> | null = null;
    const cleanupLease = (): Promise<CleanupAttempt> => {
      const releaseLease = async (): Promise<void> => {
        managedRedisClient?.disconnect();
        await lease.release({
          unhealthy: disconnectOnStop || releaseUnhealthy,
        });
      };
      leaseCleanup ??= Result.tryPromise({
        try: releaseLease,
        catch: captureRedisStreamsFailure,
      }).then((released) =>
        settleRedisStreamsCapture(released).match({
          ok: (): CleanupAttempt => ({ status: "ok" }),
          err: (failure): CleanupAttempt => ({
            status: "error",
            failure,
          }),
        }),
      );
      return leaseCleanup;
    };

    type LoopCompletion =
      | { readonly status: "completed" }
      | {
          readonly status: "defect";
          readonly failure: CapturedRedisStreamsFailure;
        };
    let settleLoopCompletion!: (completion: LoopCompletion) => void;
    const loopCompletion = new Promise<LoopCompletion>((resolve) => {
      settleLoopCompletion = resolve;
    });
    const running: Promise<ResultType<void, EventDeliveryDoneError>> = runLoop()
      .finally(async () => {
        await cleanupLease();
      })
      .then(async (loopResult) => {
        const released = await cleanupLease();
        if (released.status === "error") {
          if (released.failure.kind === "panic") {
            return signalEventBusPanic(released.failure.panic);
          }
          return Result.err(
            new EventDeliveryTransportFailed({
              cause: released.failure.restoreCause(),
              operation: "cleanup",
              topic,
              message: "Redis delivery lease cleanup failed",
            }),
          );
        }
        return loopResult;
      });
    void Result.tryPromise({
      try: () => running,
      catch: captureRedisStreamsFailure,
    }).then((captured) => {
      settleRedisStreamsCapture(captured).match({
        ok: () => settleLoopCompletion({ status: "completed" }),
        err: (failure) => settleLoopCompletion({ status: "defect", failure }),
      });
    });

    const cleanupGroup = async (): Promise<CleanupAttempt> => {
      const cleanGroup = async (): Promise<CleanupAttempt> => {
        clearInterval(maintenanceTimer);
        await maintenancePending;
        if (group && consumerId) {
          await this.redis.del(subscriptionOwnerKey);
          if (ephemeral && createdGroup) {
            if (!ephemeralGroupDestroyed) {
              const destroyed = await this.redis.xgroup("DESTROY", streamKey, group);
              if (destroyed !== 1) {
                return {
                  status: "error",
                  failure: ownedRedisStreamsFailure(
                    new Error("Redis XGROUP DESTROY returned an invalid cleanup response"),
                  ),
                };
              }
              ephemeralGroupDestroyed = true;
            }
            await new RedisManagedDelivery(
              this.redis,
              streamKey,
              group,
              consumerId,
              this.ownerId,
            ).clearAllState();
            this.scheduleAcknowledgedTrim(topic, streamKey);
          } else {
            const pending = (await this.redis.xpending(
              streamKey,
              group,
              "-",
              "+",
              1,
              consumerId,
            )) as unknown;
            const pendingPresence = decodeRedisCleanupPendingPresence(pending);
            if (pendingPresence.status === "error") {
              return {
                status: "error",
                failure: ownedRedisStreamsFailure(new Error(pendingPresence.message)),
              };
            }
            if (!pendingPresence.value.hasPendingEntries) {
              const removed = await this.redis.xgroup("DELCONSUMER", streamKey, group, consumerId);
              if (typeof removed !== "number" || !isRedisCount(removed)) {
                return {
                  status: "error",
                  failure: ownedRedisStreamsFailure(
                    new Error("Redis XGROUP DELCONSUMER returned an invalid cleanup response"),
                  ),
                };
              }
            }
          }
        }
        return { status: "ok" };
      };
      const cleaned = settleRedisStreamsCapture(
        await Result.tryPromise({
          try: cleanGroup,
          catch: captureRedisStreamsFailure,
        }),
      );
      return cleaned.match<CleanupAttempt>({
        ok: (result) => result,
        err: (failure) => ({
          status: "error",
          failure,
        }),
      });
    };

    let ephemeralGroupDestroyed = false;
    let stopSequence = Promise.resolve();
    type StopDeliverySettlement =
      | {
          readonly kind: "result";
          readonly result: ResultType<void, EventDeliveryStopFailed>;
        }
      | {
          readonly kind: "failure";
          readonly failure: CapturedRedisStreamsFailure;
        };
    const stop = async (): Promise<ResultType<void, EventDeliveryStopFailed>> => {
      const previousStop = stopSequence;
      const stopTurn = Promise.withResolvers<void>();
      stopSequence = stopTurn.promise;
      await previousStop;
      const stopDelivery = async (): Promise<StopDeliverySettlement> => {
        abortController.abort();
        activeAttempt?.shutdown();
        managedRedisClient?.disconnect();
        if (blockMs > 500) {
          disconnectOnStop = true;
          subRedis.disconnect();
        }
        const completedLoop = await loopCompletion;
        const groupCleanup = await cleanupGroup();
        const released = await cleanupLease();

        if (maintenanceFailure) {
          this.activeSubscriptionStops.delete(stop);
          return { kind: "failure", failure: maintenanceFailure };
        }
        if (completedLoop.status === "defect") {
          this.activeSubscriptionStops.delete(stop);
          return { kind: "failure", failure: completedLoop.failure };
        }
        if (groupCleanup.status === "error") {
          if (groupCleanup.failure.kind === "panic") {
            this.activeSubscriptionStops.delete(stop);
            return { kind: "failure", failure: groupCleanup.failure };
          }
          return {
            kind: "result",
            result: Result.err(
              new EventDeliveryStopFailed({
                cause: groupCleanup.failure.restoreCause(),
                topic,
                message: "Redis delivery cleanup failed",
              }),
            ),
          };
        }
        if (released.status === "error") {
          if (released.failure.kind === "panic") {
            this.activeSubscriptionStops.delete(stop);
            return { kind: "failure", failure: released.failure };
          }
          return {
            kind: "result",
            result: Result.err(
              new EventDeliveryStopFailed({
                cause: released.failure.restoreCause(),
                topic,
                message: "Redis delivery lease cleanup failed",
              }),
            ),
          };
        }
        this.activeSubscriptionStops.delete(stop);
        return { kind: "result", result: Result.ok(undefined) };
      };
      const stopped = settleRedisStreamsCapture(
        await Result.tryPromise({
          try: stopDelivery,
          catch: captureRedisStreamsFailure,
        }),
      );
      stopTurn.resolve();
      const outcome = redisStreamsOutcome(stopped);
      if (outcome.kind === "error") {
        if (outcome.error.kind === "panic") return signalEventBusPanic(outcome.error.panic);
        return Result.err(
          new EventDeliveryStopFailed({
            cause: outcome.error.restoreCause(),
            topic,
            message: "Redis delivery stop failed",
          }),
        );
      }
      if (outcome.value.kind === "failure") {
        if (outcome.value.failure.kind === "panic") {
          return signalEventBusPanic(outcome.value.failure.panic);
        }
        return Result.err(
          new EventDeliveryStopFailed({
            cause: outcome.value.failure.restoreCause(),
            topic,
            message: "Redis delivery stopped after a delivery defect",
          }),
        );
      }
      return outcome.value.result;
    };
    this.activeSubscriptionStops.add(stop);
    return Result.ok({
      done: running,
      stop,
    });
  }

  /** Close the bus (no-op unless `ownsRedis` was set). */
  async close(): Promise<void> {
    this.closing = true;
    const stopped = await Promise.allSettled(
      Array.from(this.activeSubscriptionStops, async (stop) => await stop()),
    );
    let stopFailure: unknown;
    for (const outcome of stopped) {
      if (outcome.status === "rejected") {
        stopFailure ??= outcome.reason;
      } else {
        outcome.value.match({
          ok: () => undefined,
          err: (error) => {
            stopFailure ??= error;
          },
        });
      }
    }
    for (const timer of this.trimTimers.values()) clearTimeout(timer);
    this.trimTimers.clear();
    await Promise.allSettled(this.activeTrims);
    await this.subPool.close();
    if (this.ownsRedis) {
      // Do not `disconnect()` because it drops queued commands; `quit()` is clean.
      await this.redis.quit();
    }

    if (stopFailure !== undefined) throw stopFailure;
    if (this.acknowledgedTrimPanic !== null) throw this.acknowledgedTrimPanic;
  }
}

/** Convenience factory for `RedisStreamsBus`. */
export function createRedisStreamsBus(options: RedisStreamsBusOptions): RedisStreamsBus {
  return new RedisStreamsBus(options);
}
