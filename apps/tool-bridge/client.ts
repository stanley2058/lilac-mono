/* oxlint-disable eslint/no-control-regex */

import { getBuildInfo, type BuildInfo } from "@stanley2058/lilac-utils/build-info";
import {
  serverToolExitCode,
  type ServerToolFailure,
  type ServerToolFailureKind,
} from "@stanley2058/lilac-plugin-runtime/types";
import { Panic, Result, TaggedError, type Result as ResultType } from "better-result";
import { z } from "zod";
import { createHash, randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import fs from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";

const BACKEND_URL = process.env.TOOL_SERVER_BACKEND_URL || "http://localhost:8080";
const BUILD_ID_LENGTH = 8;
const DEV_BUILD_ID = "dev";
const VERSION_FETCH_TIMEOUT_MS = 1_500;
const CURRENT_FILE = fileURLToPath(import.meta.url);
const MODULE_DIR = dirname(CURRENT_FILE);
const DEFAULT_OPERATOR_TOKEN_FILE = "/run/lilac/operator-token";

let buildIdPromise: Promise<string> | undefined;
let localVersionInfoPromise: Promise<LocalVersionInfo> | undefined;
let backendVersionInfoPromise: Promise<BackendVersionInfo | null> | undefined;
let operatorToken: string | undefined;
let operatorRequestId: string | undefined;

type ToolOutputFull = {
  callableId: string;
  name: string;
  description: string;
  shortInput: string[];
  input: string[];
  primaryPositional?: PrimaryPositional;
  hidden?: boolean;
};

type PrimaryPositional = {
  field: string;
  variadic?: boolean;
};

type LocalVersionInfo = BuildInfo & {
  build: string;
};

type JsonValue = z.output<typeof jsonValueSchema>;
type JsonObject = z.output<typeof jsonObjectSchema>;

export class BridgeArgumentInvalid extends TaggedError("BridgeArgumentInvalid")<{
  readonly message: string;
}> {}

export class BridgeExternalOperationFailed extends TaggedError("BridgeExternalOperationFailed")<{
  readonly operation: string;
  readonly cause: unknown;
  readonly message: string;
}> {}

export class BridgeRequestCancelled extends TaggedError("BridgeRequestCancelled")<{
  readonly operation: string;
  readonly cause: unknown;
  readonly message: string;
}> {}

export class BridgeResponseInvalid extends TaggedError("BridgeResponseInvalid")<{
  readonly boundary: string;
  readonly cause: z.ZodError;
  readonly message: string;
}> {}

export class BridgeJsonInvalid extends TaggedError("BridgeJsonInvalid")<{
  readonly source: string;
  readonly cause: unknown;
  readonly message: string;
}> {}

export class BridgeHttpFailed extends TaggedError("BridgeHttpFailed")<{
  readonly action: string;
  readonly status: number;
  readonly message: string;
}> {}

export class BridgeInternalFailure extends TaggedError("BridgeInternalFailure")<{
  readonly message: string;
}> {}

export class BridgeCleanupFailed extends TaggedError("BridgeCleanupFailed")<{
  readonly operation: string;
  readonly cause: unknown;
  readonly message: string;
}> {}

export class BridgeOperationAndCleanupFailed extends TaggedError(
  "BridgeOperationAndCleanupFailed",
)<{
  readonly operationError: BridgeClientError;
  readonly cleanupError: BridgeCleanupFailed;
  readonly message: string;
}> {}

export type BridgeClientError =
  | ServerToolFailure
  | BridgeArgumentInvalid
  | BridgeExternalOperationFailed
  | BridgeRequestCancelled
  | BridgeResponseInvalid
  | BridgeJsonInvalid
  | BridgeHttpFailed
  | BridgeInternalFailure
  | BridgeCleanupFailed
  | BridgeOperationAndCleanupFailed;

function signalBridgeDefect(defect: Panic): never {
  throw defect;
}

type CapturedBridgeFailure =
  | { readonly kind: "panic"; readonly panic: Panic }
  | { readonly kind: "ordinary"; readonly cause: Error };

function resultOutcome<T, E>(
  result: ResultType<T, E>,
): { ok: true; value: T } | { ok: false; error: E } {
  return result.match<{ ok: true; value: T } | { ok: false; error: E }>({
    ok: (value) => ({ ok: true, value }),
    err: (error) => ({ ok: false, error }),
  });
}

function captureBridgeFailure(cause: unknown): CapturedBridgeFailure {
  if (Panic.is(cause)) return { kind: "panic", panic: cause };
  return {
    kind: "ordinary",
    cause:
      cause instanceof Error ? cause : new Error("Opaque tool bridge external failure", { cause }),
  };
}

function captureBridgeOperation<T, E>(
  operation: () => Awaited<T>,
  mapError: (cause: Error) => E,
): ResultType<T, E> {
  const captured = Result.try<T, CapturedBridgeFailure>({
    try: operation,
    catch: captureBridgeFailure,
  });
  const continueCapture = captured.match<() => ResultType<T, E>>({
    ok: (value) => () => Result.ok(value),
    err: (failure) => () => {
      if (failure.kind === "panic") signalBridgeDefect(failure.panic);
      return Result.err(mapError(failure.cause));
    },
  });
  return continueCapture();
}

async function captureBridgeOperationAsync<T, E>(
  operation: () => Promise<T>,
  mapError: (cause: Error) => E,
): Promise<ResultType<T, E>> {
  const captured = await Result.tryPromise({ try: operation, catch: captureBridgeFailure });
  const continueCapture = captured.match<() => ResultType<T, E>>({
    ok: (value) => () => Result.ok(value),
    err: (failure) => () => {
      if (failure.kind === "panic") signalBridgeDefect(failure.panic);
      return Result.err(mapError(failure.cause));
    },
  });
  return continueCapture();
}

let callableIdsCache: string[] | undefined;

function lilacRequestHeaders(includeJson = false): Record<string, string> {
  const headers: Record<string, string> = includeJson ? { "Content-Type": "application/json" } : {};
  const values = [
    ["x-lilac-request-id", process.env.LILAC_REQUEST_ID],
    ["x-lilac-request-delivery-id", process.env.LILAC_REQUEST_DELIVERY_ID],
    ["x-lilac-session-id", process.env.LILAC_SESSION_ID],
    ["x-lilac-request-client", process.env.LILAC_REQUEST_CLIENT],
    ["x-lilac-cwd", process.cwd()],
    ["x-lilac-tool-call-id", process.env.LILAC_TOOL_CALL_ID],
    ["x-lilac-control-capability", process.env.LILAC_CONTROL_CAPABILITY],
    ["x-lilac-subagent-profile", process.env.LILAC_SUBAGENT_PROFILE],
    ["x-lilac-current-turn-user-id", process.env.LILAC_CURRENT_TURN_USER_ID],
  ] as const;
  for (const [name, value] of values) {
    if (value) headers[name] = value;
  }
  if (operatorToken) {
    headers["x-lilac-operator-token"] = operatorToken;
    headers["x-lilac-request-id"] = operatorRequestId ?? "operator";
    headers["x-lilac-tool-call-id"] = operatorRequestId ?? "operator";
  }
  return headers;
}

async function readFileText(
  filePath: string,
  operation: string,
): Promise<ResultType<string, BridgeExternalOperationFailed>> {
  return captureBridgeOperationAsync(
    () => fs.readFile(filePath, "utf8"),
    (cause) =>
      new BridgeExternalOperationFailed({
        cause,
        operation,
        message: `${operation} failed`,
      }),
  );
}

async function readFileBytes(
  filePath: string,
  operation: string,
): Promise<ResultType<Buffer, BridgeExternalOperationFailed>> {
  return captureBridgeOperationAsync(
    () => fs.readFile(filePath),
    (cause) =>
      new BridgeExternalOperationFailed({
        cause,
        operation,
        message: `${operation} failed`,
      }),
  );
}

async function enableOperatorMode(): Promise<ResultType<void, BridgeClientError>> {
  const tokenPath = process.env.LILAC_OPERATOR_TOKEN_FILE || DEFAULT_OPERATOR_TOKEN_FILE;
  const tokenFile = resultOutcome(await readFileText(tokenPath, "read operator token"));
  if (!tokenFile.ok) return Result.err(tokenFile.error);
  const token = tokenFile.value.trim();
  if (!/^[A-Za-z0-9_-]{43}$/u.test(token)) {
    return Result.err(
      new BridgeArgumentInvalid({ message: `Operator token file is malformed: ${tokenPath}` }),
    );
  }
  operatorToken = token;
  operatorRequestId = `operator:${randomUUID()}`;
  return Result.ok(undefined);
}

const jsonValueSchema = z.json();
const jsonObjectSchema = z.record(z.string(), jsonValueSchema);

const primaryPositionalSchema = z.object({
  field: z.string().min(1),
  variadic: z.boolean().optional(),
});

const toolOutputFullSchema = z.object({
  callableId: z.string().min(1),
  name: z.string(),
  description: z.string(),
  shortInput: z.array(z.string()),
  input: z.array(z.string()),
  primaryPositional: primaryPositionalSchema.optional(),
  hidden: z.boolean().optional(),
});

const toolListItemSchema = toolOutputFullSchema.omit({ input: true });

const listPayloadSchema = z.object({
  tools: z.array(toolListItemSchema),
});

const callableIdListPayloadSchema = z.object({
  tools: z.array(z.object({ callableId: z.string().min(1) })),
});

const errorPayloadSchema = z.object({
  message: z.string().optional(),
  error: jsonValueSchema.optional(),
});

const backendVersionPayloadSchema = z.object({
  ok: z.literal(true),
  version: z.string(),
  commit: z.string(),
  dirty: z.boolean().optional(),
  builtAt: z.string().optional(),
  plugins: z
    .object({
      loadedExternal: z.number().int().nonnegative(),
    })
    .optional(),
});

const serverToolFailureSchema: z.ZodType<ServerToolFailure> = z
  .object({
    kind: z.enum([
      "usage",
      "not_found",
      "denied",
      "conflict",
      "timeout",
      "unavailable",
      "cancelled",
      "internal",
    ]),
    code: z.string().min(1),
    message: z.string(),
    retryable: z.boolean(),
    details: jsonValueSchema.optional(),
  })
  .strict();

const toolCallPayloadSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("ok"), value: jsonValueSchema }).strict(),
  z.object({ status: z.literal("error"), error: serverToolFailureSchema }).strict(),
]);

const onboardingGpgGenerateSchema = z.object({ fingerprint: z.string().min(1) });
const onboardingGpgExportSchema = z.object({ publicKeyArmored: z.string().optional() });

type BackendVersionInfo = z.infer<typeof backendVersionPayloadSchema>;

type ToolCallPayload = z.output<typeof toolCallPayloadSchema>;

function invalidResponse(boundary: string, cause: z.ZodError): BridgeResponseInvalid {
  return new BridgeResponseInvalid({
    boundary,
    cause,
    message: `Backend returned an invalid ${boundary} response`,
  });
}

export function decodeListPayload(
  payload: JsonValue,
): ResultType<{ readonly tools: readonly Omit<ToolOutputFull, "input">[] }, BridgeResponseInvalid> {
  const parsed = listPayloadSchema.safeParse(payload);
  if (!parsed.success) return Result.err(invalidResponse("tool list", parsed.error));
  return Result.ok(parsed.data);
}

function decodeCallableIdListPayload(
  payload: JsonValue,
): ResultType<readonly string[], BridgeResponseInvalid> {
  const parsed = callableIdListPayloadSchema.safeParse(payload);
  if (!parsed.success) return Result.err(invalidResponse("callable ID list", parsed.error));
  return Result.ok(parsed.data.tools.map((item) => item.callableId));
}

export function decodeToolHelpPayload(
  payload: JsonValue,
): ResultType<ToolOutputFull, BridgeResponseInvalid> {
  const parsed = toolOutputFullSchema.safeParse(payload);
  if (!parsed.success) return Result.err(invalidResponse("tool help", parsed.error));
  return Result.ok(parsed.data);
}

export function decodeToolCallPayload(
  payload: JsonValue,
): ResultType<ToolCallPayload, BridgeResponseInvalid> {
  const parsed = toolCallPayloadSchema.safeParse(payload);
  if (!parsed.success) return Result.err(invalidResponse("tool call", parsed.error));
  return Result.ok(parsed.data);
}

export function decodeBackendVersionPayload(
  payload: JsonValue,
): ResultType<BackendVersionInfo, BridgeResponseInvalid> {
  const parsed = backendVersionPayloadSchema.safeParse(payload);
  if (!parsed.success) return Result.err(invalidResponse("version", parsed.error));
  return Result.ok(parsed.data);
}

function decodeOnboardingGpgGenerate(
  payload: JsonValue,
): ResultType<z.output<typeof onboardingGpgGenerateSchema>, BridgeResponseInvalid> {
  const parsed = onboardingGpgGenerateSchema.safeParse(payload);
  if (!parsed.success) return Result.err(invalidResponse("GPG generation", parsed.error));
  return Result.ok(parsed.data);
}

function decodeOnboardingGpgExport(
  payload: JsonValue,
): ResultType<z.output<typeof onboardingGpgExportSchema>, BridgeResponseInvalid> {
  const parsed = onboardingGpgExportSchema.safeParse(payload);
  if (!parsed.success) return Result.err(invalidResponse("GPG export", parsed.error));
  return Result.ok(parsed.data);
}

function decodeJsonText(raw: string, source: string): ResultType<JsonValue, BridgeJsonInvalid> {
  const parsed = resultOutcome(
    Result.try({
      try: () => JSON.parse(raw),
      catch: (cause) =>
        new BridgeJsonInvalid({ cause, source, message: `${source} is not valid JSON` }),
    }),
  );
  if (!parsed.ok) return Result.err(parsed.error);
  const decoded = jsonValueSchema.safeParse(parsed.value);
  if (!decoded.success) {
    return Result.err(
      new BridgeJsonInvalid({
        cause: decoded.error,
        source,
        message: `${source} is not valid JSON`,
      }),
    );
  }
  return Result.ok(decoded.data);
}

function decodeJsonObject(
  value: JsonValue,
  source: string,
): ResultType<JsonObject, BridgeArgumentInvalid> {
  const parsed = jsonObjectSchema.safeParse(value);
  if (!parsed.success) {
    return Result.err(new BridgeArgumentInvalid({ message: `${source} must be a JSON object` }));
  }
  return Result.ok(parsed.data);
}

async function fetchRequest(
  input: string,
  operation: string,
  init?: RequestInit,
): Promise<ResultType<Response, BridgeExternalOperationFailed | BridgeRequestCancelled>> {
  const request = new Request(input, init);
  Reflect.set(request, "timeout", false);
  return captureBridgeOperationAsync(
    () => fetch(request),
    (cause) => {
      if (request.signal.aborted) {
        return new BridgeRequestCancelled({
          cause,
          operation,
          message: `${operation} was cancelled`,
        });
      }
      return new BridgeExternalOperationFailed({
        cause,
        operation,
        message: `${operation} failed`,
      });
    },
  );
}

async function fetchWithTimeout(
  input: string,
  timeoutMs: number,
): Promise<ResultType<Response, BridgeExternalOperationFailed | BridgeRequestCancelled>> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, timeoutMs);
  timer.unref?.();

  const response = await fetchRequest(input, "fetch backend version", {
    signal: controller.signal,
  });
  clearTimeout(timer);
  return response;
}

async function listCallableIdsBestEffort(): Promise<string[]> {
  if (callableIdsCache !== undefined) return callableIdsCache;

  const response = await fetchRequest(`${BACKEND_URL}/list`, "fetch tools list", {
    headers: lilacRequestHeaders(),
  });
  const res = response.match({ ok: (value) => value, err: () => undefined });
  if (!res?.ok) {
    callableIdsCache = [];
    return callableIdsCache;
  }

  const payload = (await readResponseJson(res, "tool list")).match({
    ok: (value) => value,
    err: () => undefined,
  });
  if (payload === undefined) {
    callableIdsCache = [];
    return callableIdsCache;
  }
  callableIdsCache = decodeCallableIdListPayload(payload).match({
    ok: (value) => [...value],
    err: () => [],
  });
  return callableIdsCache;
}

function maybeString(value: JsonValue | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function extractErrorMessage(payload: JsonValue): string | undefined {
  const asString = maybeString(payload);
  if (asString) return asString;

  const parsed = errorPayloadSchema.safeParse(payload);
  if (!parsed.success) return undefined;

  const directMessage = maybeString(parsed.data.message);
  if (directMessage) return directMessage;

  const errorValue = parsed.data.error;
  if (errorValue === undefined) return undefined;
  const nested = extractErrorMessage(errorValue);
  if (nested) return nested;

  return undefined;
}

async function readResponseText(
  response: Response,
  operation: string,
): Promise<ResultType<string, BridgeExternalOperationFailed>> {
  return captureBridgeOperationAsync(
    () => response.text(),
    (cause) =>
      new BridgeExternalOperationFailed({
        cause,
        operation,
        message: `${operation} failed`,
      }),
  );
}

async function readResponseJson(
  response: Response,
  boundary: string,
): Promise<ResultType<JsonValue, BridgeExternalOperationFailed | BridgeJsonInvalid>> {
  const text = await readResponseText(response, `read ${boundary} response`);
  const outcome = resultOutcome(text);
  return outcome.ok
    ? decodeJsonText(outcome.value, `${boundary} response`)
    : Result.err(outcome.error);
}

async function readHttpErrorMessage(res: Response): Promise<string | undefined> {
  const body = (await readResponseText(res, "read backend error response")).match({
    ok: (text) => text.trim(),
    err: () => undefined,
  });
  if (!body) return undefined;

  return decodeJsonText(body, "backend error response").match({
    ok: (payload) => extractErrorMessage(payload),
    err: () => body,
  });
}

function formatHttpStatus(res: Response): string {
  return res.statusText ? `${res.status} ${res.statusText}` : String(res.status);
}

function formatHttpFailure(action: string, res: Response, message?: string): string {
  if (message) return `Failed to ${action}: ${message}`;
  return `Failed to ${action}: ${formatHttpStatus(res)}`;
}

function levenshteinDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  const left = a.toLowerCase();
  const right = b.toLowerCase();

  const prevSeed: number[] = [];
  for (let index = 0; index <= right.length; index++) prevSeed.push(index);
  let prev = prevSeed;

  for (let i = 1; i <= left.length; i++) {
    const curr: number[] = [i];
    const leftChar = left[i - 1] ?? "";

    for (let j = 1; j <= right.length; j++) {
      const rightChar = right[j - 1] ?? "";
      const deletion = (prev[j] ?? Number.MAX_SAFE_INTEGER) + 1;
      const insertion = (curr[j - 1] ?? Number.MAX_SAFE_INTEGER) + 1;
      const substitution =
        (prev[j - 1] ?? Number.MAX_SAFE_INTEGER) + (leftChar === rightChar ? 0 : 1);
      curr[j] = Math.min(deletion, insertion, substitution);
    }

    prev = curr;
  }

  return prev[right.length] ?? Number.MAX_SAFE_INTEGER;
}

function pickCallableSuggestion(
  callableId: string,
  candidates: readonly string[],
): string | undefined {
  const query = callableId.trim();
  if (!query) return undefined;

  const queryLower = query.toLowerCase();
  const queryRoot = queryLower.split(".")[0] ?? "";

  let bestCandidate: string | undefined;
  let bestScore = Number.MAX_SAFE_INTEGER;

  for (const candidate of candidates) {
    const candidateLower = candidate.toLowerCase();
    if (candidateLower === queryLower) continue;

    let score = levenshteinDistance(queryLower, candidateLower);

    const candidateRoot = candidateLower.split(".")[0] ?? "";
    if (queryRoot && candidateRoot && queryRoot !== candidateRoot) {
      score += 2;
    }

    if (score < bestScore) {
      bestScore = score;
      bestCandidate = candidate;
      continue;
    }

    if (score === bestScore && bestCandidate && candidate.length < bestCandidate.length) {
      bestCandidate = candidate;
    }
  }

  if (!bestCandidate) return undefined;

  const threshold = Math.max(2, Math.ceil(Math.max(query.length, bestCandidate.length) * 0.25));
  if (bestScore > threshold) return undefined;

  return bestCandidate;
}

async function buildCallableIdErrorMessage(params: {
  action: string;
  callableId: string;
  res: Response;
  detail?: string;
}): Promise<string> {
  const isNotFound = params.res.status === 404;
  const looksLikeUnknownCallable =
    isNotFound || (params.detail?.includes("Unknown callable ID") ?? false);

  if (!looksLikeUnknownCallable) {
    return formatHttpFailure(params.action, params.res, params.detail);
  }

  const callableIds = await listCallableIdsBestEffort();
  const suggestion = pickCallableSuggestion(params.callableId, callableIds);
  if (suggestion) {
    return `Unknown callable ID '${params.callableId}'. Did you mean '${suggestion}'?`;
  }

  const base =
    params.detail && params.detail.length > 0
      ? params.detail
      : `Unknown callable ID '${params.callableId}'`;
  if (base.endsWith(".")) {
    return `${base} Run 'tools --list' to see available callable IDs.`;
  }
  return `${base}. Run 'tools --list' to see available callable IDs.`;
}

async function listTools(): Promise<
  ResultType<{ readonly tools: readonly Omit<ToolOutputFull, "input">[] }, BridgeClientError>
> {
  const fetched = resultOutcome(
    await fetchRequest(`${BACKEND_URL}/list`, "fetch tools list", {
      headers: lilacRequestHeaders(),
    }),
  );
  if (!fetched.ok) return Result.err(fetched.error);
  const res = fetched.value;
  if (!res.ok) {
    const detail = await readHttpErrorMessage(res);
    return Result.err(
      new BridgeHttpFailed({
        action: "fetch tools list",
        status: res.status,
        message: formatHttpFailure("fetch tools list", res, detail),
      }),
    );
  }
  const payload = resultOutcome(await readResponseJson(res, "tool list"));
  if (!payload.ok) return Result.err(payload.error);
  return decodeListPayload(payload.value);
}

async function getBackendVersionInfoBestEffort(): Promise<BackendVersionInfo | null> {
  backendVersionInfoPromise ??= (async () => {
    const response = (
      await fetchWithTimeout(`${BACKEND_URL}/versionz`, VERSION_FETCH_TIMEOUT_MS)
    ).match({ ok: (value) => value, err: () => undefined });
    if (!response?.ok) return null;

    const payload = (await readResponseJson(response, "version")).match({
      ok: (value) => value,
      err: () => undefined,
    });
    if (payload === undefined) return null;
    return decodeBackendVersionPayload(payload).match({ ok: (value) => value, err: () => null });
  })();

  return await backendVersionInfoPromise;
}

async function toolHelp(
  callableId: string,
): Promise<ResultType<ToolOutputFull, BridgeClientError>> {
  const fetched = resultOutcome(
    await fetchRequest(`${BACKEND_URL}/help/${encodeURIComponent(callableId)}`, "fetch tool help", {
      headers: lilacRequestHeaders(),
    }),
  );
  if (!fetched.ok) return Result.err(fetched.error);
  const res = fetched.value;
  if (!res.ok) {
    const detail = await readHttpErrorMessage(res);
    return Result.err(
      new BridgeHttpFailed({
        action: "fetch tool help",
        status: res.status,
        message: await buildCallableIdErrorMessage({
          action: "fetch tool help",
          callableId,
          res,
          detail,
        }),
      }),
    );
  }
  const payload = resultOutcome(await readResponseJson(res, "tool help"));
  if (!payload.ok) return Result.err(payload.error);
  return decodeToolHelpPayload(payload.value);
}

async function callTool(
  callableId: string,
  input: JsonObject,
): Promise<ResultType<ToolCallPayload, BridgeClientError>> {
  const headers = lilacRequestHeaders(true);

  const fetched = resultOutcome(
    await fetchRequest(`${BACKEND_URL}/call`, "call tool", {
      method: "POST",
      headers,
      body: JSON.stringify({
        callableId,
        input,
      }),
    }),
  );
  if (!fetched.ok) return Result.err(fetched.error);
  const res = fetched.value;
  if (!res.ok) {
    const detail = await readHttpErrorMessage(res);
    return Result.err(
      new BridgeHttpFailed({
        action: "call tool",
        status: res.status,
        message: await buildCallableIdErrorMessage({
          action: "call tool",
          callableId,
          res,
          detail,
        }),
      }),
    );
  }
  const payload = resultOutcome(await readResponseJson(res, "tool call"));
  if (!payload.ok) return Result.err(payload.error);
  return decodeToolCallPayload(payload.value);
}

const ANSI_RE = /\x1b\[[0-9;]*m/g;
function stripAnsi(input: string) {
  return input.replace(ANSI_RE, "");
}

function visibleLength(input: string) {
  return stripAnsi(input).length;
}

function padRight(input: string, width: number) {
  const pad = Math.max(0, width - visibleLength(input));
  return `${input}${" ".repeat(pad)}`;
}

function indentLines(lines: string[], spaces: number) {
  const pad = " ".repeat(spaces);
  return lines.map((l) => (l.length === 0 ? l : `${pad}${l}`));
}

function wrapText(text: string, width: number): string[] {
  const w = Math.max(10, width);

  const paragraphs = text
    .split("\n")
    .map((p) => p.trim())
    .filter(Boolean);

  if (paragraphs.length === 0) return [""];

  const out: string[] = [];

  for (const p of paragraphs) {
    const words = p.split(/\s+/g);
    let line = "";

    for (const word of words) {
      if (!line) {
        line = word;
        continue;
      }

      const next = `${line} ${word}`;
      if (next.length <= w) {
        line = next;
      } else {
        out.push(line);
        line = word;
      }
    }

    if (line) out.push(line);
    out.push("");
  }

  // drop trailing paragraph spacer
  if (out.length > 0 && out[out.length - 1] === "") out.pop();
  return out;
}

function termWidth() {
  // Keep a reasonable lower bound for wrapping.
  return Math.max(60, process.stdout.columns ?? 80);
}

function useColor() {
  if (!process.stdout.isTTY) return false;
  if (process.env.NO_COLOR !== undefined) return false;
  if (process.env.TERM === "dumb") return false;
  return true;
}

type StyleFn = (s: string) => string;
function createStyles(enabled: boolean) {
  const wrap =
    (open: string, close = "\x1b[0m") =>
    (s: string) =>
      enabled ? `${open}${s}${close}` : s;

  return {
    dim: wrap("\x1b[2m"),
    bold: wrap("\x1b[1m"),
    cyan: wrap("\x1b[36m"),
    yellow: wrap("\x1b[33m"),
    red: wrap("\x1b[31m"),
  } satisfies Record<string, StyleFn>;
}

const styles = createStyles(useColor());

function section(title: string, lines: string[]) {
  const hdr = styles.bold(title);
  const body = indentLines(lines, 2);
  return [hdr, ...body].join("\n");
}

async function isFile(filePath: string): Promise<boolean> {
  const inspected = await captureBridgeOperationAsync(
    () => fs.stat(filePath),
    (cause) => cause,
  );
  return inspected.match({ ok: (value) => value.isFile(), err: () => false });
}

async function sha256HexPrefix(
  filePath: string,
  length = BUILD_ID_LENGTH,
): Promise<ResultType<string, BridgeExternalOperationFailed>> {
  const bytes = await readFileBytes(filePath, "read tool bridge build artifact");
  return bytes.map((value) => createHash("sha256").update(value).digest("hex").slice(0, length));
}

export async function resolveBuildId(currentFile = CURRENT_FILE): Promise<string> {
  const normalizedCurrent = normalizePathCandidate(currentFile, process.cwd()) ?? currentFile;
  if (!normalizedCurrent) return DEV_BUILD_ID;

  const currentBase = basename(normalizedCurrent);
  if (currentBase === "client.ts") return DEV_BUILD_ID;

  const artifactPath =
    currentBase === "client.js"
      ? normalizedCurrent
      : resolve(dirname(normalizedCurrent), "client.js");

  if (!(await isFile(artifactPath))) return DEV_BUILD_ID;

  const buildId = await sha256HexPrefix(artifactPath);
  return buildId.match({ ok: (value) => value, err: () => DEV_BUILD_ID });
}

async function getBuildId(): Promise<string> {
  buildIdPromise ??= resolveBuildId();
  return await buildIdPromise;
}

async function getLocalVersionInfo(): Promise<LocalVersionInfo> {
  localVersionInfoPromise ??= (async () => ({
    ...getBuildInfo({ cwd: MODULE_DIR }),
    build: await getBuildId(),
  }))();

  return await localVersionInfoPromise;
}

function formatTag(label: string, value: string): string {
  return styles.dim(`[${label}: ${value}]`);
}

function buildLocalVersionTags(localVersion: LocalVersionInfo): string[] {
  const tags = [formatTag("commit", localVersion.commit), formatTag("build", localVersion.build)];

  if (localVersion.dirty) {
    tags.push(styles.yellow("[dirty]"));
  }

  return tags;
}

export function buildVersionTags(
  localVersion: LocalVersionInfo,
  backendVersion: BackendVersionInfo | null,
): string[] {
  const tags = buildLocalVersionTags(localVersion);
  if (!backendVersion) return tags;

  if (backendVersion.commit !== localVersion.commit) {
    tags.push(formatTag("app", backendVersion.commit));
  }

  if (backendVersion.dirty) {
    tags.push(styles.yellow("[app-dirty]"));
  }

  const pluginCount = backendVersion.plugins?.loadedExternal ?? 0;
  if (pluginCount > 0) {
    tags.push(formatTag("plugins", String(pluginCount)));
  }

  return tags;
}

function renderBanner(tags: readonly string[]): string {
  const name = styles.bold("tools");
  return tags.length > 0
    ? `${name} - All-in-one tool proxy ${tags.join(" ")}`
    : `${name} - All-in-one tool proxy`;
}

async function banner() {
  return renderBanner(buildLocalVersionTags(await getLocalVersionInfo()));
}

async function versionBanner() {
  const [localVersion, backendVersion] = await Promise.all([
    getLocalVersionInfo(),
    getBackendVersionInfoBestEffort(),
  ]);
  return renderBanner(buildVersionTags(localVersion, backendVersion));
}

function formatBullets(
  items: string[],
  opts?: { indent?: number; dim?: boolean; withPrefix?: boolean },
) {
  const indent = opts?.indent ?? 0;
  const bulletPrefix = opts?.withPrefix ? "- " : "";
  const width = termWidth();
  const available = Math.max(20, width - indent - bulletPrefix.length);

  const out: string[] = [];
  for (const item of items) {
    const wrapped = wrapText(item, available);
    out.push(`${" ".repeat(indent)}${bulletPrefix}${wrapped[0] ?? ""}`);
    for (const cont of wrapped.slice(1)) {
      out.push(`${" ".repeat(indent + bulletPrefix.length)}${cont}`);
    }
  }

  if (opts?.dim) return out.map((l) => styles.dim(l));
  return out;
}

function formatToolBlock(
  tool: ToolOutputFull | Omit<ToolOutputFull, "input">,
  opts: { idWidth: number; showArgs: boolean },
) {
  const width = termWidth();
  const id = styles.cyan(tool.callableId);
  const name = styles.bold(tool.name);
  const dash = styles.dim("—");

  const prefix = `${padRight(id, opts.idWidth)}  ${name}`;
  const descIndent = visibleLength(prefix) + 3;
  const descWidth = Math.max(20, width - descIndent);
  const descLines = wrapText(tool.description, descWidth);

  const lines: string[] = [];
  lines.push(`${prefix}  ${dash} ${descLines[0] ?? ""}`);
  for (const cont of descLines.slice(1)) {
    lines.push(`${" ".repeat(descIndent)}${cont}`);
  }

  if (opts.showArgs) {
    const args = "input" in tool ? tool.input : tool.shortInput;
    if (tool.primaryPositional) {
      lines.push(
        ...formatBullets([formatPrimaryPositionalSummary(tool.primaryPositional)], {
          indent: 2,
          dim: true,
        }),
      );
    }
    if (args.length > 0) {
      lines.push(...formatBullets(args, { indent: 2, dim: true }));
    }
  }

  return lines.join("\n");
}

type OutputMode = "json" | "json-pretty";

const commonOptions = [
  "--operator, --op (authenticate with the root-only container operator token)",
  '--output=<"json" | "json-pretty"> (default: "json")',
  "--input=@file.json | --input='<json>' | --input=@-",
  "--stdin (alias for --input=@-)",
  "--<field>:json=@file.json | --<field>:json='<json>' | --<field>:json=@-",
];

function formatPrimaryPositionalSummary(primaryPositional: PrimaryPositional): string {
  const display = camelToKebabCase(primaryPositional.field);
  if (primaryPositional.variadic === true) {
    return `<${display}...> (primary positional; same as --${display}:json=[...])`;
  }
  return `<${display}> (primary positional; same as --${display}=...)`;
}

function formatPrimaryPositionalUsage(primaryPositional: PrimaryPositional): string {
  const display = camelToKebabCase(primaryPositional.field);
  return primaryPositional.variadic === true ? `<${display}...>` : `<${display}>`;
}

function buildUsageLinesForTool(
  tool: Pick<ToolOutputFull, "callableId" | "primaryPositional">,
): string[] {
  const usageLines: string[] = [];
  if (tool.primaryPositional) {
    usageLines.push(
      `tools ${tool.callableId} ${formatPrimaryPositionalUsage(tool.primaryPositional)}`,
    );
  }
  usageLines.push(
    `tools ${tool.callableId} --arg1=value --arg2=value`,
    `tools ${tool.callableId} --input=@payload.json`,
    `cat payload.json | tools ${tool.callableId} --stdin`,
  );
  return usageLines;
}

async function main(): Promise<ResultType<void, BridgeClientError>> {
  const globalArgs = parseGlobalArgs();
  const parsedCommand = resultOutcome(parseArgs(globalArgs.args));
  if (!parsedCommand.ok) return Result.err(parsedCommand.error);
  const command = parsedCommand.value;

  if (
    globalArgs.operator &&
    (command.type === "list" ||
      command.type === "call" ||
      (command.type === "help" && command.callableId !== undefined))
  ) {
    const enabled = resultOutcome(await enableOperatorMode());
    if (!enabled.ok) return Result.err(enabled.error);
  }

  switch (command.type) {
    case "version":
      console.log(await versionBanner());
      return Result.ok(undefined);
    case "help": {
      if (command.callableId === "onboard") {
        console.log(
          [
            await banner(),
            "",
            `${styles.bold("onboard")} ${styles.dim("—")} Configure agent git identity + GPG signing under DATA_DIR`,
            "",
            section("Usage", [
              "tools onboard",
              "tools onboard --yes",
              'tools onboard --yes --name="lilac-agent[bot]" --email="lilac-agent[bot]@users.noreply.github.com"',
              "tools onboard --no-sign",
            ]),
            "",
            section(
              "Flags",
              formatBullets([
                "--data-dir=<path>\tOverride DATA_DIR for this run",
                "--name=<string>\tGit user.name",
                "--email=<string>\tGit user.email",
                "--sign\tEnable GPG commit signing (default)",
                "--no-sign\tDisable commit signing",
                "--yes, -y\tNon-interactive (accept defaults)",
                "--output=json|json-pretty\tOutput format (default: json)",
              ]),
            ),
          ].join("\n"),
        );
        return Result.ok(undefined);
      }

      if (command.callableId) {
        const helped = resultOutcome(await toolHelp(command.callableId));
        if (!helped.ok) return Result.err(helped.error);
        const tool = helped.value;
        console.log(
          [
            await banner(),
            "",
            `${styles.bold(tool.name)} ${styles.dim("—")} ${tool.description}`,
            "",
            section("Usage", buildUsageLinesForTool(tool)),
            "",
            section("Arguments", formatBullets(tool.input, { indent: 0 })),
            "",
            section("Options", formatBullets(commonOptions, { indent: 0 })),
          ].join("\n"),
        );
        return Result.ok(undefined);
      }

      console.log(
        [
          await banner(),
          "",
          section("Usage", [
            "tools --list",
            "tools --help [tool]",
            "tools <tool> --arg1=value --arg2=value",
            "tools <tool> --input=@payload.json",
            "cat payload.json | tools <tool> --stdin",
          ]),
          "",
          section(
            "Flags",
            formatBullets([
              "--list\tList all available tools",
              "--help\tShow help (optionally for a tool)",
              "--version\tPrint version",
              "--operator, --op\tUse root-only container operator access",
            ]),
          ),
          "",
          section("Options", formatBullets(commonOptions)),
          "",
          section("Output and exit codes", [
            "Success writes the callable's JSON value to stdout and exits 0.",
            'Failure writes {"status":"error","error":{"kind":...,"code":...,"message":...,"retryable":...,"details":...}} JSON to stderr. details is optional.',
            "1 internal, 2 usage, 3 denied, 4 not_found, 5 conflict, 6 unavailable, 7 timeout, 8 cancelled.",
            "A successfully produced report or diagnostic exits 0 even when it describes warnings, unhealthy state, or another negative conclusion.",
          ]),
          "",
          section(
            "Examples",
            formatBullets([
              "tools workflow.definition.validate --scope=auto --name=audit-routes",
              "tools workflow.run.trigger --input=@workflow-run.json",
              "cat workflow-trigger.json | tools workflow.trigger.create --stdin",
            ]),
          ),
          "",
          section(
            "Environment",
            formatBullets([
              `TOOL_SERVER_BACKEND_URL (default: ${BACKEND_URL})`,
              `LILAC_OPERATOR_TOKEN_FILE (default: ${DEFAULT_OPERATOR_TOKEN_FILE})`,
              "NO_COLOR disables ANSI formatting",
            ]),
          ),
        ].join("\n"),
      );
      return Result.ok(undefined);
    }
    case "list": {
      const listed = resultOutcome(await listTools());
      if (!listed.ok) return Result.err(listed.error);
      const visibleTools = command.showHidden
        ? listed.value.tools
        : listed.value.tools.filter((tool) => tool.hidden !== true);
      const idWidth = Math.min(
        28,
        Math.max(10, ...visibleTools.map((tool) => tool.callableId.length)),
      );
      console.log(
        [
          await banner(),
          "",
          section("Usage", [
            "tools <tool> --arg1=value --arg2=value",
            "tools <tool> --input=@payload.json",
            "cat payload.json | tools <tool> --stdin",
          ]),
          "",
          styles.bold("Available tools (quick reference; use --help on a tool for details):"),
          "",
          ...visibleTools.map((tool) => formatToolBlock(tool, { idWidth, showArgs: true })),
          "",
          section("Options", formatBullets(commonOptions)),
        ].join("\n"),
      );
      return Result.ok(undefined);
    }
    case "call": {
      const hasAnyInputFlags =
        command.baseInput !== undefined ||
        command.fieldInputs.length > 0 ||
        command.jsonFieldInputs.length > 0 ||
        command.positionalArgs.length > 0;
      if (!command.usesStdin && !hasAnyInputFlags && process.stdin.isTTY === false) {
        return Result.err(
          new BridgeArgumentInvalid({
            message:
              "Stdin is piped, but this invocation does not read stdin. Use --stdin/--input=@- for a JSON payload, or --<field>:json=@- for a JSON field.",
          }),
        );
      }

      let primaryPositional: PrimaryPositional | undefined;
      if (command.positionalArgs.length > 0) {
        const helped = resultOutcome(await toolHelp(command.callableId));
        if (!helped.ok) return Result.err(helped.error);
        primaryPositional = helped.value.primaryPositional;
      }
      const input = resultOutcome(await buildToolInput(command, primaryPositional));
      if (!input.ok) return Result.err(input.error);
      const continueCalled = (await callTool(command.callableId, input.value)).match<
        () => ResultType<void, BridgeClientError>
      >({
        ok: (called) => () => {
          if (called.status === "error") {
            return Result.err(called.error);
          }
          console.log(
            JSON.stringify(
              called.value,
              null,
              command.outputMode === "json-pretty" ? 2 : undefined,
            ),
          );
          return Result.ok(undefined);
        },
        err: (error) => () => Result.err(error),
      });
      return continueCalled();
    }
    case "onboard": {
      const continueOnboarded = (await runOnboardingWizard(command)).match<
        () => ResultType<void, BridgeClientError>
      >({
        ok: (onboarded) => () => {
          console.log(
            JSON.stringify(onboarded, null, command.outputMode === "json-pretty" ? 2 : undefined),
          );
          return Result.ok(undefined);
        },
        err: (error) => () => Result.err(error),
      });
      return continueOnboarded();
    }
    case "unknown":
      return Result.err(new BridgeArgumentInvalid({ message: "Unknown command, try --help" }));
  }
}

type JsonSource =
  | { kind: "inline"; text: string }
  | { kind: "file"; path: string }
  | { kind: "stdin" };

type ParsedArgs =
  | { type: "version" }
  | { type: "help"; callableId?: string }
  | { type: "list"; showHidden: boolean }
  | {
      type: "onboard";
      outputMode: OutputMode;
      dataDir?: string;
      userName?: string;
      userEmail?: string;
      sign?: boolean;
      yes: boolean;
    }
  | {
      type: "call";
      callableId: string;
      outputMode: OutputMode;
      baseInput?: JsonSource;
      fieldInputs: { field: string; value: string | boolean }[];
      jsonFieldInputs: { field: string; source: JsonSource }[];
      positionalArgs: string[];
      usesStdin: boolean;
    }
  | { type: "unknown" };

export function parseGlobalArgs(args = process.argv.slice(2)): {
  args: string[];
  operator: boolean;
} {
  let operator = false;
  let optionsEnded = false;
  const remaining = args.filter((arg) => {
    if (arg === "--") {
      optionsEnded = true;
      return true;
    }
    if (optionsEnded || (arg !== "--operator" && arg !== "--op")) return true;
    operator = true;
    return false;
  });
  return { args: remaining, operator };
}

function argumentError(message: string): ResultType<never, BridgeArgumentInvalid> {
  return Result.err(new BridgeArgumentInvalid({ message }));
}

export function parseArgs(
  args = process.argv.slice(2),
): ResultType<ParsedArgs, BridgeArgumentInvalid> {
  {
    const firstArg = args[0];

    if (firstArg === "--version") return Result.ok({ type: "version" } satisfies ParsedArgs);

    // Alias / fallback: tools --help <callableId>
    if (firstArg === "--help") {
      const maybeTool = args[1];
      if (maybeTool && !maybeTool.startsWith("--")) {
        return Result.ok({ type: "help", callableId: maybeTool } satisfies ParsedArgs);
      }
      return Result.ok({ type: "help" } satisfies ParsedArgs);
    }

    if (firstArg === "--list") {
      const showHidden = args.some((a) => {
        if (a === "--show-hidden") return true;
        if (a.startsWith("--show-hidden=")) {
          const eq = a.indexOf("=");
          const v = eq === -1 ? "" : a.slice(eq + 1);
          return parseBooleanLike(v) === true;
        }
        return false;
      });
      return Result.ok({ type: "list", showHidden } satisfies ParsedArgs);
    }

    if (firstArg === "onboard") {
      const restArgs = args.slice(1);
      let outputMode: OutputMode = "json";
      let dataDir: string | undefined;
      let userName: string | undefined;
      let userEmail: string | undefined;
      let sign: boolean | undefined;
      let yes = false;

      for (let i = 0; i < restArgs.length; i++) {
        const a = restArgs[i];
        if (a === "-y") {
          yes = true;
          continue;
        }
        if (!a || !a.startsWith("--")) {
          return argumentError(`Unexpected argument '${a ?? ""}'. Expected --key=value`);
        }

        const eq = a.indexOf("=");
        const k = eq === -1 ? a : a.slice(0, eq);
        const v = eq === -1 ? "" : a.slice(eq + 1);
        const hasValue = eq !== -1;

        if (k === "--help") {
          const value = hasValue ? parseBooleanLike(v) : true;
          if (value !== false) {
            return Result.ok({ type: "help", callableId: "onboard" } satisfies ParsedArgs);
          }
          continue;
        }

        if (k === "--output") {
          if (!hasValue) {
            return argumentError("--output requires a value: --output=json|json-pretty");
          }
          if (v !== "json" && v !== "json-pretty") {
            return argumentError(`Invalid --output value '${v}' (expected json|json-pretty)`);
          }
          outputMode = v;
          continue;
        }

        if (k === "--yes") {
          const value = hasValue ? parseBooleanLike(v) : true;
          if (value !== false) yes = true;
          continue;
        }

        if (k === "--data-dir") {
          if (!hasValue) return argumentError("--data-dir requires a value: --data-dir=<path>");
          dataDir = normalizeMaybePath("dataDir", v);
          continue;
        }

        if (k === "--name") {
          if (!hasValue) return argumentError("--name requires a value: --name=<string>");
          userName = v;
          continue;
        }

        if (k === "--email") {
          if (!hasValue) return argumentError("--email requires a value: --email=<string>");
          userEmail = v;
          continue;
        }

        if (k === "--sign") {
          const value = hasValue ? parseBooleanLike(v) : true;
          sign = value ?? true;
          continue;
        }

        if (k === "--no-sign") {
          const value = hasValue ? parseBooleanLike(v) : true;
          if (value !== false) sign = false;
          continue;
        }

        return argumentError(`Unknown flag '${k}' for onboard`);
      }

      return Result.ok({
        type: "onboard",
        outputMode,
        dataDir,
        userName,
        userEmail,
        sign,
        yes,
      } satisfies ParsedArgs);
    }

    if (firstArg && !firstArg.startsWith("--")) {
      const callableId = firstArg;

      const fieldInputs: { field: string; value: string | boolean }[] = [];
      const jsonFieldInputs: { field: string; source: JsonSource }[] = [];
      const positionalArgs: string[] = [];

      const seenCanonicalFields = new Map<string, string>();

      let baseInput: JsonSource | undefined;
      let outputMode: OutputMode = "json";

      let stdinConsumer: string | undefined;

      function claimStdin(consumer: string): ResultType<void, BridgeArgumentInvalid> {
        if (stdinConsumer && stdinConsumer !== consumer) {
          return argumentError(
            `Stdin can only be used once per invocation (already used by ${stdinConsumer}, cannot use for ${consumer}).`,
          );
        }
        stdinConsumer = consumer;
        return Result.ok(undefined);
      }

      const restArgs = args.slice(1);
      for (let i = 0; i < restArgs.length; i++) {
        const a = restArgs[i];
        if (!a) continue;

        if (a === "--") {
          positionalArgs.push(...restArgs.slice(i + 1));
          break;
        }

        if (!a.startsWith("--")) {
          positionalArgs.push(a);
          continue;
        }

        const eq = a.indexOf("=");
        const k = eq === -1 ? a : a.slice(0, eq);
        const v = eq === -1 ? "" : a.slice(eq + 1);
        const hasValue = eq !== -1;
        if (!k || k === "--") continue;

        // Special-case: tools <tool> --help / --help=true
        if (k === "--help") {
          const value = hasValue ? parseBooleanLike(v) : true;
          if (value !== false) {
            return Result.ok({ type: "help", callableId } satisfies ParsedArgs);
          }
          continue;
        }

        if (k === "--output") {
          if (!hasValue) {
            return argumentError("--output requires a value: --output=json|json-pretty");
          }
          if (v !== "json" && v !== "json-pretty") {
            return argumentError(`Invalid --output value '${v}' (expected json|json-pretty)`);
          }
          outputMode = v;
          continue;
        }

        // Whole payload JSON.
        if (k === "--stdin") {
          const value = hasValue ? parseBooleanLike(v) : true;
          if (value === false) continue;

          if (baseInput) {
            return argumentError("Only one of --stdin/--input may be provided");
          }
          baseInput = { kind: "stdin" };
          const claimed = resultOutcome(claimStdin("--stdin"));
          if (!claimed.ok) return Result.err(claimed.error);
          continue;
        }

        if (k === "--input") {
          if (!hasValue) {
            return argumentError(
              "--input requires a value: --input=@file.json, --input=@-, or --input='<json>'",
            );
          }

          if (baseInput) {
            return argumentError("Only one of --stdin/--input may be provided");
          }

          const parsedSource = resultOutcome(parseJsonSource(v));
          if (!parsedSource.ok) return Result.err(parsedSource.error);
          const source = parsedSource.value;
          if (source.kind === "stdin") {
            const claimed = resultOutcome(claimStdin("--input=@-"));
            if (!claimed.ok) return Result.err(claimed.error);
          }
          baseInput = source;
          continue;
        }

        const fieldRaw = k.slice(2);
        if (!fieldRaw) continue;

        if (fieldRaw.endsWith(":json")) {
          const rawField = fieldRaw.slice(0, -":json".length);
          const field = kebabToCamelCase(rawField);
          if (!field) {
            return argumentError(`Invalid JSON field flag '${k}'`);
          }

          const previous = seenCanonicalFields.get(field);
          if (previous && previous !== rawField) {
            return argumentError(
              `Duplicate field '${field}' via flags '--${previous}' and '--${rawField}'. Use only one casing.`,
            );
          }
          if (!previous) seenCanonicalFields.set(field, rawField);

          if (!hasValue) {
            return argumentError(
              `--${field}:json requires a value: --${rawField}:json=<json|@file|@->`,
            );
          }

          const parsedSource = resultOutcome(parseJsonSource(v));
          if (!parsedSource.ok) return Result.err(parsedSource.error);
          const source = parsedSource.value;
          if (source.kind === "stdin") {
            const claimed = resultOutcome(claimStdin(`--${field}:json=@-`));
            if (!claimed.ok) return Result.err(claimed.error);
          }

          jsonFieldInputs.push({ field, source });
          continue;
        }

        // Default: treat as primitive string/bool.
        const field = kebabToCamelCase(fieldRaw);
        const previous = seenCanonicalFields.get(field);
        if (previous && previous !== fieldRaw) {
          return argumentError(
            `Duplicate field '${field}' via flags '--${previous}' and '--${fieldRaw}'. Use only one casing.`,
          );
        }
        if (!previous) seenCanonicalFields.set(field, fieldRaw);

        let parsedValue: string | boolean = true;

        if (hasValue) {
          const boolValue = parseBooleanLike(v);
          parsedValue = boolValue ?? v;
        }

        if (typeof parsedValue === "string") {
          parsedValue = normalizeMaybePath(field, parsedValue);
        }

        fieldInputs.push({ field, value: parsedValue });
      }

      return Result.ok({
        type: "call",
        callableId,
        outputMode,
        baseInput,
        fieldInputs,
        jsonFieldInputs,
        positionalArgs,
        usesStdin: stdinConsumer !== undefined,
      } satisfies ParsedArgs);
    }

    return Result.ok({ type: "unknown" } satisfies ParsedArgs);
  }
}

export async function buildToolInput(
  parsed: Extract<ParsedArgs, { type: "call" }>,
  primaryPositional?: PrimaryPositional,
): Promise<ResultType<JsonObject, BridgeClientError>> {
  let input: JsonObject = {};

  if (parsed.baseInput) {
    const baseInput = resultOutcome(
      await readJsonObjectSource(parsed.baseInput, "--input/--stdin"),
    );
    if (!baseInput.ok) return Result.err(baseInput.error);
    input = baseInput.value;
  }

  for (const { field, source } of parsed.jsonFieldInputs) {
    const decoded = resultOutcome(await readJsonSource(source, `--${field}:json`));
    if (!decoded.ok) return Result.err(decoded.error);
    input[field] = decoded.value;
  }

  for (const { field, value } of parsed.fieldInputs) {
    input[field] = value;
  }

  if (parsed.positionalArgs.length > 0) {
    if (!primaryPositional) {
      const bareBooleanFlag = parsed.fieldInputs.find((entry) => entry.value === true);
      const flagHint = bareBooleanFlag
        ? ` Bare --${camelToKebabCase(bareBooleanFlag.field)} was parsed as boolean true; if you meant to pass a value, use --${camelToKebabCase(bareBooleanFlag.field)}=<value>.`
        : " If you meant to pass a flag value, use --field=<value>.";
      return argumentError(
        `Tool '${parsed.callableId}' does not support positional input.${flagHint} Space-separated flag values are not supported; use --input JSON or stdin for structured input.`,
      );
    }

    const displayField = camelToKebabCase(primaryPositional.field);

    if (primaryPositional.variadic === true) {
      if (Object.hasOwn(input, primaryPositional.field)) {
        return argumentError(
          `Primary positional <${displayField}...> conflicts with an existing '${primaryPositional.field}' value from flags or JSON input.`,
        );
      }

      input[primaryPositional.field] = parsed.positionalArgs.map((arg) =>
        normalizeMaybePath(primaryPositional.field, arg),
      );
      return Result.ok(input);
    }

    if (parsed.positionalArgs.length > 1) {
      return argumentError(
        `Tool '${parsed.callableId}' accepts at most one positional argument: <${displayField}>.`,
      );
    }

    if (Object.hasOwn(input, primaryPositional.field)) {
      return argumentError(
        `Primary positional <${displayField}> conflicts with an existing '${primaryPositional.field}' value from flags or JSON input.`,
      );
    }

    input[primaryPositional.field] = normalizeMaybePath(
      primaryPositional.field,
      parsed.positionalArgs[0] ?? "",
    );
  }

  return Result.ok(input);
}

type PromptInterface = ReturnType<typeof createInterface>;

type OnboardingOutput = {
  readonly ok: true;
  readonly userName: string;
  readonly userEmail: string;
  readonly signing:
    | {
        readonly enabled: true;
        readonly fingerprint: string;
        readonly publicKeyArmored?: string;
        readonly notes: readonly string[];
      }
    | { readonly enabled: false };
  readonly vcsEnv: JsonValue;
  readonly gitTest: JsonValue;
};

function openPromptInterface(): ResultType<PromptInterface, BridgeExternalOperationFailed> {
  return captureBridgeOperation(
    () => createInterface({ input: process.stdin, output: process.stderr }),
    (cause) =>
      new BridgeExternalOperationFailed({
        cause,
        operation: "open onboarding prompt",
        message: "Failed to open onboarding prompt",
      }),
  );
}

async function askPrompt(
  prompt: PromptInterface,
  question: string,
): Promise<ResultType<string, BridgeExternalOperationFailed>> {
  return captureBridgeOperationAsync(
    () => prompt.question(question),
    (cause) =>
      new BridgeExternalOperationFailed({
        cause,
        operation: "read onboarding prompt",
        message: "Failed to read onboarding prompt",
      }),
  );
}

function closePrompt(prompt: PromptInterface): ResultType<void, BridgeCleanupFailed> {
  return captureBridgeOperation(
    () => prompt.close(),
    (cause) =>
      new BridgeCleanupFailed({
        cause,
        operation: "close onboarding prompt",
        message: "Failed to close onboarding prompt",
      }),
  );
}

function toolOutput(
  result: ResultType<ToolCallPayload, BridgeClientError>,
): ResultType<JsonValue, BridgeClientError> {
  const outcome = resultOutcome(result);
  if (!outcome.ok) return Result.err(outcome.error);
  if (outcome.value.status === "error") {
    return Result.err(outcome.value.error);
  }
  return Result.ok(outcome.value.value);
}

async function runOnboardingOperation(
  parsed: Extract<ParsedArgs, { type: "onboard" }>,
  prompt: PromptInterface | null,
): Promise<ResultType<OnboardingOutput, BridgeClientError>> {
  const defaultName = "lilac-agent[bot]";
  const defaultEmail = "lilac-agent[bot]@users.noreply.github.com";
  const askText = async (
    label: string,
    fallback: string,
  ): Promise<ResultType<string, BridgeExternalOperationFailed>> => {
    if (!prompt || parsed.yes) return Result.ok(fallback);
    const answer = resultOutcome(await askPrompt(prompt, `${label} (${fallback}): `));
    return answer.ok ? Result.ok(answer.value.trim() || fallback) : Result.err(answer.error);
  };

  const askYesNo = async (
    label: string,
    fallback: boolean,
  ): Promise<ResultType<boolean, BridgeExternalOperationFailed>> => {
    if (!prompt || parsed.yes) return Result.ok(fallback);
    const suffix = fallback ? "Y/n" : "y/N";
    const answer = resultOutcome(await askPrompt(prompt, `${label} (${suffix}): `));
    if (!answer.ok) return Result.err(answer.error);
    const value = answer.value.trim().toLowerCase();
    if (value === "") return Result.ok(fallback);
    if (value === "y" || value === "yes" || value === "true") return Result.ok(true);
    if (value === "n" || value === "no" || value === "false") return Result.ok(false);
    return Result.ok(fallback);
  };

  let userName = parsed.userName;
  if (userName === undefined) {
    const answered = resultOutcome(await askText("Git user.name", defaultName));
    if (!answered.ok) return Result.err(answered.error);
    userName = answered.value;
  }
  let userEmail = parsed.userEmail;
  if (userEmail === undefined) {
    const answered = resultOutcome(await askText("Git user.email", defaultEmail));
    if (!answered.ok) return Result.err(answered.error);
    userEmail = answered.value;
  }
  let sign = parsed.sign;
  if (sign === undefined) {
    const answered = resultOutcome(
      await askYesNo("Enable GPG commit signing (no-passphrase key)", true),
    );
    if (!answered.ok) return Result.err(answered.error);
    sign = answered.value;
  }

  const baseInput: JsonObject = parsed.dataDir ? { dataDir: parsed.dataDir } : {};
  const bootstrap = resultOutcome(toolOutput(await callTool("onboarding.bootstrap", baseInput)));
  if (!bootstrap.ok) return Result.err(bootstrap.error);
  const vcs = resultOutcome(toolOutput(await callTool("onboarding.vcs_env", baseInput)));
  if (!vcs.ok) return Result.err(vcs.error);
  const vcsEnv = vcs.value;

  let fingerprint: string | undefined;
  let publicKeyArmored: string | undefined;
  if (sign) {
    const generated = resultOutcome(
      toolOutput(
        await callTool("onboarding.gnupg", {
          ...baseInput,
          mode: "generate",
          userName,
          userEmail,
          uidComment: "lilac",
        }),
      ),
    );
    if (!generated.ok) return Result.err(generated.error);
    const decodedGenerate = resultOutcome(decodeOnboardingGpgGenerate(generated.value));
    if (!decodedGenerate.ok) return Result.err(decodedGenerate.error);
    fingerprint = decodedGenerate.value.fingerprint;

    const exported = resultOutcome(
      toolOutput(
        await callTool("onboarding.gnupg", {
          ...baseInput,
          mode: "export_public",
          fingerprint,
        }),
      ),
    );
    if (!exported.ok) return Result.err(exported.error);
    const decodedExport = resultOutcome(decodeOnboardingGpgExport(exported.value));
    if (!decodedExport.ok) return Result.err(decodedExport.error);
    publicKeyArmored = decodedExport.value.publicKeyArmored;
  }

  const configured = resultOutcome(
    toolOutput(
      await callTool("onboarding.git_identity", {
        ...baseInput,
        mode: "configure",
        userName,
        userEmail,
        enableSigning: sign,
        ...(sign ? { signingKey: fingerprint } : {}),
      }),
    ),
  );
  if (!configured.ok) return Result.err(configured.error);
  const testResult = resultOutcome(
    toolOutput(await callTool("onboarding.git_identity", { ...baseInput, mode: "test" })),
  );
  if (!testResult.ok) return Result.err(testResult.error);
  const tested = testResult.value;

  let signing: OnboardingOutput["signing"] = { enabled: false };
  if (sign) {
    if (fingerprint === undefined) {
      return Result.err(
        new BridgeInternalFailure({
          message: "GPG key generation did not return a fingerprint",
        }),
      );
    }
    signing = {
      enabled: true,
      fingerprint,
      ...(publicKeyArmored === undefined ? {} : { publicKeyArmored }),
      notes: ["Add this public key to GitHub (Settings -> SSH and GPG keys -> New GPG key)."],
    };
  }
  return Result.ok({
    ok: true,
    userName,
    userEmail,
    signing,
    vcsEnv,
    gitTest: tested,
  } satisfies OnboardingOutput);
}

async function runOnboardingWizard(
  parsed: Extract<ParsedArgs, { type: "onboard" }>,
): Promise<ResultType<OnboardingOutput, BridgeClientError>> {
  const needsTty =
    !parsed.yes &&
    (parsed.userName === undefined || parsed.userEmail === undefined || parsed.sign === undefined);
  if (needsTty && process.stdin.isTTY === false) {
    return argumentError(
      "tools onboard requires a TTY for prompts. Use --yes with optional --name/--email/--sign flags for non-interactive use.",
    );
  }

  let prompt: PromptInterface | null = null;
  if (process.stdin.isTTY) {
    const opened = resultOutcome(openPromptInterface());
    if (!opened.ok) return Result.err(opened.error);
    prompt = opened.value;
  }

  const operation = await runOnboardingOperation(parsed, prompt);
  if (!prompt) return operation;
  const cleanup = resultOutcome(closePrompt(prompt));
  if (cleanup.ok) return operation;
  const operationOutcome = resultOutcome(operation);
  if (operationOutcome.ok) return Result.err(cleanup.error);
  return Result.err(
    new BridgeOperationAndCleanupFailed({
      operationError: operationOutcome.error,
      cleanupError: cleanup.error,
      message: "Onboarding and prompt cleanup both failed",
    }),
  );
}

function parseJsonSource(value: string): ResultType<JsonSource, BridgeArgumentInvalid> {
  if (value === "@-" || value === "-") {
    return Result.ok({ kind: "stdin" });
  }

  if (value.startsWith("@")) {
    const p = value.slice(1);
    if (!p) {
      return argumentError("Invalid JSON source '@' (expected @file.json or @-)");
    }
    return Result.ok({ kind: "file", path: resolve(expandTilde(p)) });
  }

  if (value.length === 0) {
    return argumentError("Empty JSON source (expected @file.json, @-, or inline JSON)");
  }

  return Result.ok({ kind: "inline", text: value });
}

async function readJsonObjectSource(
  source: JsonSource,
  label: string,
): Promise<ResultType<JsonObject, BridgeClientError>> {
  const value = await readJsonSource(source, label);
  const outcome = resultOutcome(value);
  return outcome.ok ? decodeJsonObject(outcome.value, label) : Result.err(outcome.error);
}

async function readJsonSource(
  source: JsonSource,
  label: string,
): Promise<ResultType<JsonValue, BridgeClientError>> {
  let raw: string;

  if (source.kind === "stdin") {
    const read = resultOutcome(await readStdinText());
    if (!read.ok) return Result.err(read.error);
    raw = read.value;
  } else if (source.kind === "file") {
    const read = resultOutcome(await readFileText(source.path, `read JSON file for ${label}`));
    if (!read.ok) return Result.err(read.error);
    raw = read.value;
  } else {
    raw = source.text;
  }

  const trimmed = raw.trim();
  if (!trimmed) {
    return argumentError(`${label} is empty`);
  }

  return decodeJsonText(trimmed, label);
}

async function readStdinText(): Promise<ResultType<string, BridgeExternalOperationFailed>> {
  return captureBridgeOperationAsync(
    async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of process.stdin) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      return Buffer.concat(chunks).toString("utf8");
    },
    (cause) =>
      new BridgeExternalOperationFailed({
        cause,
        operation: "read stdin",
        message: "Failed to read stdin",
      }),
  );
}

function parseBooleanLike(s: string): boolean | undefined {
  const lowered = s.trim().toLowerCase();
  if (lowered === "true") return true;
  if (lowered === "false") return false;
  return undefined;
}

function looksLikePath(value: string) {
  if (value.includes("://")) return false;
  if (value === "~" || value.startsWith("~/") || value.startsWith("~\\")) {
    return true;
  }
  if (value.startsWith("./") || value.startsWith("../")) return true;
  if (value.startsWith("/")) return true;
  if (/^[a-zA-Z]:[\\/]/.test(value)) return true;
  return false;
}

function looksLikeBase64(value: string) {
  if (value.length < 32) return false;
  if (value.length > 10_000) return true;
  return /^[A-Za-z0-9+/]+={0,2}$/.test(value);
}

function expandTilde(value: string) {
  if (value === "~") return homedir();
  if (value.startsWith("~/")) return `${homedir()}/${value.slice(2)}`;
  if (value.startsWith("~\\")) return `${homedir()}\\${value.slice(2)}`;
  return value;
}

function normalizeMaybePath(field: string, value: string) {
  if (value.length === 0) return value;

  const fieldLower = field.toLowerCase();
  const isPathField = fieldLower.endsWith("path");

  // Avoid mis-detecting base64 (often starts with "/" e.g. "/9j/").
  if (fieldLower.includes("base64") || looksLikeBase64(value)) return value;

  // For unknown flags, only normalize *very* path-like values.
  // This keeps the CLI generic while avoiding false positives.
  const shouldNormalize = isPathField || (looksLikePath(value) && value.length <= 512);

  if (!shouldNormalize) return value;
  return resolve(expandTilde(value));
}

function kebabToCamelCase(input: string): string {
  if (!input.includes("-")) return input;
  return input.replace(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase());
}

function camelToKebabCase(input: string): string {
  return input.replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`);
}

function normalizePathCandidate(candidate: string | undefined, cwd: string): string | undefined {
  if (!candidate) return undefined;

  const resolved = resolve(cwd, candidate);
  const normalized = captureBridgeOperation(
    () => realpathSync.native(resolved),
    (cause) => cause,
  );
  return normalized.match({ ok: (value) => value, err: () => resolved });
}

export function isMainModule(args = process.argv, cwd = process.cwd(), currentFile = CURRENT_FILE) {
  const normalizedCurrent = normalizePathCandidate(currentFile, cwd);
  const normalizedArgv1 = normalizePathCandidate(args[1], cwd);

  if (!normalizedCurrent || !normalizedArgv1) return false;
  if (normalizedCurrent === normalizedArgv1) return true;

  const currentBase = basename(normalizedCurrent);
  const argvBase = basename(normalizedArgv1);
  const isClientModule = currentBase === "client.js" || currentBase === "client.ts";
  const isGeneratedWrapper = argvBase === "index.js" || argvBase === "index.ts";

  if (
    isClientModule &&
    isGeneratedWrapper &&
    dirname(normalizedCurrent) === dirname(normalizedArgv1)
  ) {
    return true;
  }

  return false;
}

function failure(
  kind: ServerToolFailureKind,
  code: string,
  message: string,
  retryable: boolean,
): ServerToolFailure {
  return { kind, code, message, retryable };
}

function isTimeoutCause(cause: unknown): boolean {
  if (!(cause instanceof Error)) return false;
  const code = Reflect.get(cause, "code");
  return (
    cause.name === "TimeoutError" ||
    code === "ETIMEDOUT" ||
    /(?:timed? out|timeout)/iu.test(cause.message)
  );
}

function projectBridgeFailure(error: BridgeClientError): ServerToolFailure {
  const serverFailure = serverToolFailureSchema.safeParse(error);
  if (serverFailure.success) return serverFailure.data;
  if (error instanceof BridgeOperationAndCleanupFailed) {
    return projectBridgeFailure(error.operationError);
  }
  if (error instanceof BridgeArgumentInvalid) {
    return failure("usage", "bridge_usage", error.message, false);
  }
  if (error instanceof BridgeJsonInvalid) {
    const kind = error.source.endsWith(" response") ? "internal" : "usage";
    const code = kind === "internal" ? "malformed_response" : "invalid_json";
    return failure(kind, code, error.message, false);
  }
  if (error instanceof BridgeResponseInvalid) {
    return failure("internal", "malformed_response", error.message, false);
  }
  if (error instanceof BridgeRequestCancelled) {
    return failure("cancelled", "bridge_cancelled", error.message, false);
  }
  if (error instanceof BridgeExternalOperationFailed) {
    return isTimeoutCause(error.cause)
      ? failure("timeout", "bridge_timeout", error.message, true)
      : failure("unavailable", "bridge_unavailable", error.message, true);
  }
  if (error instanceof BridgeHttpFailed) {
    if (error.status === 400 || error.status === 422) {
      return failure("usage", "http_usage", error.message, false);
    }
    if (error.status === 401 || error.status === 403) {
      return failure("denied", "http_denied", error.message, false);
    }
    if (error.status === 404) {
      return failure("not_found", "http_not_found", error.message, false);
    }
    if (error.status === 408 || error.status === 504) {
      return failure("timeout", "http_timeout", error.message, true);
    }
    if (error.status === 409) {
      return failure("conflict", "http_conflict", error.message, false);
    }
    if (error.status === 429 || error.status >= 500) {
      return failure("unavailable", "http_unavailable", error.message, true);
    }
  }
  return failure("internal", "bridge_internal", error.message, false);
}

function outputModeFromArgs(args: readonly string[]): OutputMode {
  let outputMode: OutputMode = "json";
  for (const arg of args) {
    if (arg === "--") break;
    if (arg === "--output=json") outputMode = "json";
    if (arg === "--output=json-pretty") outputMode = "json-pretty";
  }
  return outputMode;
}

function reportFailure(error: ServerToolFailure, outputMode: OutputMode): void {
  process.stderr.write(
    `${JSON.stringify(
      { status: "error", error },
      null,
      outputMode === "json-pretty" ? 2 : undefined,
    )}\n`,
  );
  process.exitCode = serverToolExitCode[error.kind];
}

function reportMainResult(
  result: ResultType<void, BridgeClientError>,
  outputMode: OutputMode,
): void {
  const report = result.match<() => void>({
    ok: () => () => undefined,
    err: (error) => () => reportFailure(projectBridgeFailure(error), outputMode),
  });
  report();
}

export function reportMainDefect(_cause: unknown, outputMode: OutputMode = "json"): void {
  reportFailure(
    failure("internal", "bridge_defect", "Internal tool bridge failure", false),
    outputMode,
  );
}

async function runMainEntrypoint(): Promise<void> {
  const outputMode = outputModeFromArgs(parseGlobalArgs().args);
  const result = await Result.tryPromise({
    try: main,
    catch: captureBridgeFailure,
  });
  const report = result.match<() => void>({
    ok: (value) => () => reportMainResult(value, outputMode),
    err: (failure) => () =>
      reportMainDefect(failure.kind === "panic" ? failure.panic : failure.cause, outputMode),
  });
  report();
}

function startMain(): void {
  void runMainEntrypoint();
}

if (isMainModule()) {
  startMain();
}
