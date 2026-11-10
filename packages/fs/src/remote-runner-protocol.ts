import { Panic, Result, TaggedError, type Result as ResultType } from "better-result";
import { z } from "zod";

const finiteNumberSchema = z.number();
const effectiveSearchBackendSchema = z.enum(["fff", "node-rg", "node-fs"]);
const effectiveFuzzySearchBackendSchema = z.enum(["fff", "fzf"]);
const readErrorCodeSchema = z.enum(["NOT_FOUND", "PERMISSION", "UNKNOWN"]);
const byteReadErrorCodeSchema = z.enum(["NOT_FOUND", "PERMISSION", "MEDIA_TOO_LARGE", "UNKNOWN"]);
const editErrorCodeSchema = z.enum([
  "NOT_FOUND",
  "PERMISSION",
  "UNKNOWN",
  "NOT_READ",
  "HASH_MISMATCH",
  "INVALID_RANGE",
  "RANGE_MISMATCH",
  "NO_MATCHES",
  "TOO_MANY_MATCHES",
  "NOT_ENOUGH_MATCHES",
  "INVALID_REGEX",
  "INVALID_EDIT",
  "STALE_ANCHOR",
]);

const readFileStartSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("offset"), offset: finiteNumberSchema }),
  z.object({
    type: z.literal("line"),
    line: finiteNumberSchema,
    column: finiteNumberSchema.optional(),
  }),
]);

const hashlineWarningSchema = z.object({
  code: z.literal("LINE_TOO_LONG_FOR_HASHLINE"),
  message: z.string(),
  line: finiteNumberSchema,
  maxLength: finiteNumberSchema,
  actualLength: finiteNumberSchema,
});

const fileEditSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("replace_range"),
    range: z.object({ startLine: finiteNumberSchema, endLine: finiteNumberSchema }),
    newText: z.string(),
    expectedOldText: z.string().optional(),
  }),
  z.object({
    type: z.literal("insert_at"),
    line: finiteNumberSchema,
    newText: z.string(),
  }),
  z.object({
    type: z.literal("delete_range"),
    range: z.object({ startLine: finiteNumberSchema, endLine: finiteNumberSchema }),
    expectedOldText: z.string().optional(),
  }),
  z.object({
    type: z.literal("replace_snippet"),
    target: z.string(),
    matching: z.enum(["exact", "regex"]).optional(),
    newText: z.string(),
    occurrence: z.union([z.enum(["first", "all"]), finiteNumberSchema]).optional(),
    expectedMatches: z.union([z.literal("any"), finiteNumberSchema]).optional(),
  }),
]);

const hashlineEditSchema = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("replace"),
    pos: z.string(),
    end: z.string().optional(),
    lines: z.union([z.string(), z.array(z.string()), z.null()]).optional(),
  }),
  z.object({
    op: z.enum(["append", "prepend"]),
    pos: z.string(),
    lines: z.union([z.string(), z.array(z.string()), z.null()]).optional(),
  }),
]);

const requestBase = {
  denyPaths: z.array(z.string()).optional().default([]),
};

export const remoteReadTextRequestSchema = z.object({
  ...requestBase,
  op: z.literal("fs.read_text"),
  input: z.object({
    path: z.string(),
    start: readFileStartSchema.optional(),
    maxLines: finiteNumberSchema.optional(),
    maxCharacters: finiteNumberSchema.optional(),
    maxBytes: finiteNumberSchema.optional(),
    format: z.enum(["raw", "numbered", "hashline"]).optional(),
  }),
});

export const remoteReadBytesRequestSchema = z.object({
  ...requestBase,
  op: z.literal("fs.read_bytes"),
  input: z.object({
    path: z.string(),
    maxBytes: finiteNumberSchema.optional(),
    prefixBytes: z.number().int().min(1).max(65_536).optional(),
  }),
});

export const remoteGlobRequestSchema = z.object({
  ...requestBase,
  op: z.literal("fs.glob"),
  input: z.object({
    patterns: z.array(z.string()),
    maxEntries: finiteNumberSchema.optional(),
    mode: z.enum(["default", "detailed"]).optional(),
  }),
});

export const remoteGrepRequestSchema = z.object({
  ...requestBase,
  op: z.literal("fs.grep"),
  input: z.object({
    pattern: z.string(),
    baseDir: z.string().optional(),
    reportedFilePath: z.string().optional(),
    regex: z.boolean().optional(),
    maxResults: finiteNumberSchema.optional(),
    fileExtensions: z.array(z.string()).optional(),
    includeContextLines: finiteNumberSchema.optional(),
    mode: z.enum(["default", "detailed", "hashline"]).optional(),
  }),
});

export const remoteFuzzySearchRequestSchema = z.object({
  ...requestBase,
  op: z.literal("fs.fuzzy_search"),
  input: z.object({ query: z.string(), maxResults: finiteNumberSchema.optional() }),
});

export const remoteEditRequestSchema = z.object({
  ...requestBase,
  op: z.literal("fs.edit"),
  input: z.discriminatedUnion("mode", [
    z.object({
      path: z.string(),
      edits: z.array(fileEditSchema),
      expectedHash: z.string().optional(),
      mode: z.literal("legacy"),
    }),
    z.object({
      path: z.string(),
      edits: z.array(hashlineEditSchema),
      expectedHash: z.string().optional(),
      mode: z.literal("hashline"),
    }),
  ]),
});

// Legacy edit requests predate the explicit mode field and remain part of the wire contract.
const remoteLegacyEditRequestSchema = z.object({
  ...requestBase,
  op: z.literal("fs.edit"),
  input: z.object({
    path: z.string(),
    edits: z.array(fileEditSchema),
    expectedHash: z.string().optional(),
    mode: z.undefined().optional(),
  }),
});

export const remoteApplyPatchRequestSchema = z.object({
  ...requestBase,
  op: z.literal("apply_patch"),
  input: z.object({ patchText: z.string() }),
});

export const remoteHealthRequestSchema = z.object({
  ...requestBase,
  op: z.literal("health"),
  input: z.object({}),
});

export const remoteFsRequestSchema = z.union([
  remoteReadTextRequestSchema,
  remoteReadBytesRequestSchema,
  remoteGlobRequestSchema,
  remoteGrepRequestSchema,
  remoteFuzzySearchRequestSchema,
  remoteEditRequestSchema,
  remoteLegacyEditRequestSchema,
]);

export const bundledRemoteRunnerRequestSchema = z.union([
  remoteReadTextRequestSchema,
  remoteReadBytesRequestSchema,
  remoteGlobRequestSchema,
  remoteGrepRequestSchema,
  remoteEditRequestSchema,
  remoteLegacyEditRequestSchema,
  remoteApplyPatchRequestSchema,
]);

export const remoteFsDaemonRequestSchema = z
  .intersection(
    z.union([remoteFsRequestSchema, remoteHealthRequestSchema]),
    z.object({ cwd: z.string().optional() }),
  )
  .transform((request) => ({ ...request, cwd: request.cwd ?? process.cwd() }));

export type RemoteFsRequest = z.output<typeof remoteFsRequestSchema>;
export type BundledRemoteRunnerRequest = z.output<typeof bundledRemoteRunnerRequestSchema>;
export type RemoteFsDaemonRequest = z.output<typeof remoteFsDaemonRequestSchema>;

const readSuccessBase = {
  success: z.literal(true),
  resolvedPath: z.string(),
  fileHash: z.string(),
  startLine: finiteNumberSchema,
  endLine: finiteNumberSchema,
  totalLines: finiteNumberSchema,
  hasMoreLines: z.boolean(),
  truncatedByChars: z.boolean(),
  nextStart: readFileStartSchema.optional(),
  warnings: z.array(hashlineWarningSchema).optional(),
  degradedFromHashline: z.boolean().optional(),
};

export const remoteReadTextResponseSchema = z.union([
  z.object({ ...readSuccessBase, format: z.literal("raw"), content: z.string() }),
  z.object({ ...readSuccessBase, format: z.literal("numbered"), numberedContent: z.string() }),
  z.object({ ...readSuccessBase, format: z.literal("hashline"), hashlineContent: z.string() }),
  z.object({
    success: z.literal(false),
    resolvedPath: z.string(),
    error: z.object({ code: readErrorCodeSchema, message: z.string() }),
  }),
]);

export const remoteReadBytesResponseSchema = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true),
    resolvedPath: z.string(),
    fileHash: z.string(),
    bytesLength: finiteNumberSchema,
    totalBytes: finiteNumberSchema.optional(),
    base64: z.string(),
  }),
  z.object({
    ok: z.literal(false),
    resolvedPath: z.string().optional(),
    error: z.string(),
    errorCode: byteReadErrorCodeSchema.optional(),
  }),
]);

const globEntrySchema = z.object({
  path: z.string(),
  type: z.enum([
    "symlink",
    "file",
    "directory",
    "socket",
    "block_device",
    "character_device",
    "fifo",
    "unknown",
  ]),
  size: finiteNumberSchema,
});

export const remoteGlobResponseSchema = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("default"),
    truncated: z.boolean(),
    paths: z.array(z.string()),
    effectiveBackend: effectiveSearchBackendSchema.optional(),
    error: z.string().optional(),
  }),
  z.object({
    mode: z.literal("detailed"),
    truncated: z.boolean(),
    entries: z.array(globEntrySchema),
    effectiveBackend: effectiveSearchBackendSchema.optional(),
    error: z.string().optional(),
  }),
]);

const grepResponseBase = {
  truncated: z.boolean(),
  warnings: z.array(hashlineWarningSchema).optional(),
  degradedFromHashline: z.boolean().optional(),
  effectiveBackend: effectiveSearchBackendSchema.optional(),
  error: z.string().optional(),
};

export const remoteGrepResponseSchema = z.discriminatedUnion("mode", [
  z.object({
    ...grepResponseBase,
    mode: z.literal("default"),
    results: z.array(z.object({ file: z.string(), line: finiteNumberSchema, text: z.string() })),
  }),
  z.object({
    ...grepResponseBase,
    mode: z.literal("detailed"),
    results: z.array(
      z.object({
        file: z.string(),
        line: finiteNumberSchema,
        column: finiteNumberSchema,
        text: z.string(),
        submatches: z
          .array(
            z.object({
              match: z.string(),
              start: finiteNumberSchema,
              end: finiteNumberSchema,
            }),
          )
          .optional(),
      }),
    ),
  }),
  z.object({
    ...grepResponseBase,
    mode: z.literal("hashline"),
    results: z.array(
      z.object({
        file: z.string(),
        resolvedPath: z.string(),
        fileHash: z.string(),
        line: finiteNumberSchema,
        text: z.string(),
      }),
    ),
  }),
]);

export const remoteFuzzySearchResponseSchema = z.union([
  z.object({
    results: z.array(
      z.object({
        path: z.string(),
        fileName: z.string(),
        size: finiteNumberSchema,
        gitStatus: z.string(),
        score: finiteNumberSchema.optional(),
        matchType: z.string().optional(),
      }),
    ),
    totalMatched: finiteNumberSchema,
    totalFiles: finiteNumberSchema,
    truncated: z.boolean(),
    effectiveBackend: effectiveFuzzySearchBackendSchema,
    error: z.undefined().optional(),
  }),
  z.object({
    results: z.tuple([]),
    totalMatched: z.literal(0),
    totalFiles: z.literal(0),
    truncated: z.literal(false),
    effectiveBackend: effectiveFuzzySearchBackendSchema.optional(),
    error: z.string(),
  }),
]);

export const remoteEditResponseSchema = z.discriminatedUnion("success", [
  z.object({
    success: z.literal(true),
    resolvedPath: z.string(),
    oldHash: z.string(),
    newHash: z.string(),
    changesMade: z.boolean(),
    replacementsMade: finiteNumberSchema,
  }),
  z.object({
    success: z.literal(false),
    resolvedPath: z.string(),
    currentHash: z.string().optional(),
    error: z.object({ code: editErrorCodeSchema, message: z.string() }),
  }),
]);

export const remoteApplyPatchResponseSchema = z.string();
export const remoteHealthResponseSchema = z.object({ pid: finiteNumberSchema });

export type RemoteReadTextResponse = z.output<typeof remoteReadTextResponseSchema>;
export type RemoteReadBytesResponse = z.output<typeof remoteReadBytesResponseSchema>;
export type RemoteGlobResponse = z.output<typeof remoteGlobResponseSchema>;
export type RemoteGrepResponse = z.output<typeof remoteGrepResponseSchema>;
export type RemoteFuzzySearchResponse = z.output<typeof remoteFuzzySearchResponseSchema>;
export type RemoteEditResponse = z.output<typeof remoteEditResponseSchema>;
export type RemoteHealthResponse = z.output<typeof remoteHealthResponseSchema>;

export class RemoteRunnerMalformedJsonError extends TaggedError("RemoteRunnerMalformedJsonError")<{
  readonly boundary: string;
  readonly cause: unknown;
  readonly message: string;
}> {}

export class RemoteRunnerRequestEnvelopeError extends TaggedError(
  "RemoteRunnerRequestEnvelopeError",
)<{
  readonly boundary: string;
  readonly issues: readonly string[];
  readonly message: string;
}> {}

export class RemoteRunnerUnknownOperationError extends TaggedError(
  "RemoteRunnerUnknownOperationError",
)<{
  readonly boundary: string;
  readonly operation: string;
  readonly message: string;
}> {}

export class RemoteRunnerRequestPayloadError extends TaggedError(
  "RemoteRunnerRequestPayloadError",
)<{
  readonly boundary: string;
  readonly operation: string;
  readonly issues: readonly string[];
  readonly message: string;
}> {}

export class RemoteRunnerResponseEnvelopeError extends TaggedError(
  "RemoteRunnerResponseEnvelopeError",
)<{
  readonly operation: string;
  readonly issues: readonly string[];
  readonly message: string;
}> {}

export class RemoteRunnerResponsePayloadError extends TaggedError(
  "RemoteRunnerResponsePayloadError",
)<{
  readonly operation: string;
  readonly issues: readonly string[];
  readonly message: string;
}> {}

export class RemoteRunnerReportedError extends TaggedError("RemoteRunnerReportedError")<{
  readonly operation: string;
  readonly message: string;
}> {}

export type RemoteRunnerRequestDecodeError =
  | RemoteRunnerMalformedJsonError
  | RemoteRunnerRequestEnvelopeError
  | RemoteRunnerUnknownOperationError
  | RemoteRunnerRequestPayloadError;

export type RemoteRunnerResponseDecodeError =
  | RemoteRunnerMalformedJsonError
  | RemoteRunnerResponseEnvelopeError
  | RemoteRunnerResponsePayloadError
  | RemoteRunnerReportedError;

const requestEnvelopeSchema = z.looseObject({
  op: z.string(),
  input: z.unknown(),
  denyPaths: z.array(z.string()).optional(),
});

const daemonRequestEnvelopeSchema = requestEnvelopeSchema.extend({ cwd: z.string().optional() });

function formatIssues(error: z.ZodError): readonly string[] {
  return error.issues.map((issue) => {
    const location = issue.path.length > 0 ? issue.path.join(".") : "<root>";
    return `${location}: ${issue.message}`;
  });
}

function decodeJson<T, E, Context>(
  boundary: string,
  text: string,
  decode: (value: unknown, context: Context) => ResultType<T, E>,
  context: Context,
): ResultType<T, E | RemoteRunnerMalformedJsonError> {
  const captured = Result.try({
    try: () => JSON.parse(text) as unknown,
    catch: (cause) => ({ cause }),
  });
  const outcome = captured.match<{ readonly value: unknown } | { readonly cause: unknown }>({
    ok: (value) => ({ value }),
    err: ({ cause }) => ({ cause }),
  });
  if ("value" in outcome) return decode(outcome.value, context);
  if (Panic.is(outcome.cause)) throw outcome.cause;
  return Result.err(
    new RemoteRunnerMalformedJsonError({
      boundary,
      cause: outcome.cause,
      message: `${boundary} contained malformed JSON`,
    }),
  );
}

function knownBundledOperation(operation: string): boolean {
  switch (operation) {
    case "fs.read_text":
    case "fs.read_bytes":
    case "fs.glob":
    case "fs.grep":
    case "fs.edit":
    case "apply_patch":
      return true;
    default:
      return false;
  }
}

function knownRemoteFsOperation(operation: string): boolean {
  return (
    operation === "fs.fuzzy_search" ||
    (knownBundledOperation(operation) && operation !== "apply_patch")
  );
}

function knownDaemonOperation(operation: string): boolean {
  return operation === "health" || knownRemoteFsOperation(operation);
}

function decodeRequest<T>(options: {
  readonly boundary: string;
  readonly value: unknown;
  readonly envelopeSchema: typeof requestEnvelopeSchema | typeof daemonRequestEnvelopeSchema;
  readonly requestSchema: z.ZodType<T>;
  readonly isKnownOperation: (operation: string) => boolean;
}): ResultType<
  T,
  | RemoteRunnerRequestEnvelopeError
  | RemoteRunnerUnknownOperationError
  | RemoteRunnerRequestPayloadError
> {
  const envelope = options.envelopeSchema.safeParse(options.value);
  if (!envelope.success || !Object.hasOwn(envelope.data, "input")) {
    const issues = envelope.success
      ? ["input: request envelope must include input"]
      : formatIssues(envelope.error);
    return Result.err(
      new RemoteRunnerRequestEnvelopeError({
        boundary: options.boundary,
        issues,
        message: `${options.boundary} contained an invalid request envelope`,
      }),
    );
  }
  if (!options.isKnownOperation(envelope.data.op)) {
    return Result.err(
      new RemoteRunnerUnknownOperationError({
        boundary: options.boundary,
        operation: envelope.data.op,
        message: `${options.boundary} requested unknown operation ${JSON.stringify(envelope.data.op)}`,
      }),
    );
  }

  const request = options.requestSchema.safeParse(options.value);
  if (request.success) return Result.ok(request.data);
  return Result.err(
    new RemoteRunnerRequestPayloadError({
      boundary: options.boundary,
      operation: envelope.data.op,
      issues: formatIssues(request.error),
      message: `${options.boundary} contained an invalid ${envelope.data.op} payload`,
    }),
  );
}

export function decodeBundledRemoteRunnerRequest(
  value: unknown,
  boundary = "bundled runner stdin",
): ResultType<
  BundledRemoteRunnerRequest,
  Exclude<RemoteRunnerRequestDecodeError, RemoteRunnerMalformedJsonError>
> {
  return decodeRequest({
    boundary,
    value,
    envelopeSchema: requestEnvelopeSchema,
    requestSchema: bundledRemoteRunnerRequestSchema,
    isKnownOperation: knownBundledOperation,
  });
}

export function decodeBundledRemoteRunnerRequestJson(
  text: string,
  boundary = "bundled runner stdin",
): ResultType<BundledRemoteRunnerRequest, RemoteRunnerRequestDecodeError> {
  return decodeJson(boundary, text, decodeBundledRemoteRunnerRequest, boundary);
}

export function decodeRemoteFsRequest(
  value: unknown,
  boundary = "remote fs CLI stdin",
): ResultType<
  RemoteFsRequest,
  Exclude<RemoteRunnerRequestDecodeError, RemoteRunnerMalformedJsonError>
> {
  return decodeRequest({
    boundary,
    value,
    envelopeSchema: requestEnvelopeSchema,
    requestSchema: remoteFsRequestSchema,
    isKnownOperation: knownRemoteFsOperation,
  });
}

export function decodeRemoteFsRequestJson(
  text: string,
  boundary = "remote fs CLI stdin",
): ResultType<RemoteFsRequest, RemoteRunnerRequestDecodeError> {
  return decodeJson(boundary, text, decodeRemoteFsRequest, boundary);
}

export function decodeRemoteFsDaemonRequest(
  value: unknown,
  boundary = "remote fs daemon socket",
): ResultType<
  RemoteFsDaemonRequest,
  Exclude<RemoteRunnerRequestDecodeError, RemoteRunnerMalformedJsonError>
> {
  return decodeRequest({
    boundary,
    value,
    envelopeSchema: daemonRequestEnvelopeSchema,
    requestSchema: remoteFsDaemonRequestSchema,
    isKnownOperation: knownDaemonOperation,
  });
}

export function decodeRemoteFsDaemonRequestJson(
  text: string,
  boundary = "remote fs daemon socket",
): ResultType<RemoteFsDaemonRequest, RemoteRunnerRequestDecodeError> {
  return decodeJson(boundary, text, decodeRemoteFsDaemonRequest, boundary);
}

const responseEnvelopeSchema = z.discriminatedUnion("ok", [
  z.looseObject({ ok: z.literal(true), value: z.unknown() }),
  z.looseObject({ ok: z.literal(false), error: z.string() }),
]);

export function decodeRemoteRunnerResponse<T>(
  operation: string,
  value: unknown,
  valueSchema: z.ZodType<T>,
): ResultType<T, Exclude<RemoteRunnerResponseDecodeError, RemoteRunnerMalformedJsonError>> {
  const envelope = responseEnvelopeSchema.safeParse(value);
  if (!envelope.success || (envelope.data.ok && !Object.hasOwn(envelope.data, "value"))) {
    const issues = envelope.success
      ? ["value: successful response must include value"]
      : formatIssues(envelope.error);
    return Result.err(
      new RemoteRunnerResponseEnvelopeError({
        operation,
        issues,
        message: `remote runner returned an invalid ${operation} response envelope`,
      }),
    );
  }
  if (!envelope.data.ok) {
    return Result.err(new RemoteRunnerReportedError({ operation, message: envelope.data.error }));
  }

  const payload = valueSchema.safeParse(envelope.data.value);
  if (payload.success) return Result.ok(payload.data);
  return Result.err(
    new RemoteRunnerResponsePayloadError({
      operation,
      issues: formatIssues(payload.error),
      message: `remote runner returned an invalid ${operation} response payload`,
    }),
  );
}

export function decodeRemoteRunnerResponseJson<T>(
  operation: string,
  text: string,
  valueSchema: z.ZodType<T>,
): ResultType<T, RemoteRunnerResponseDecodeError> {
  return decodeJson("remote runner response", text, decodeRemoteRunnerResponseValue, {
    operation,
    valueSchema,
  });
}

function decodeRemoteRunnerResponseValue<T>(
  value: unknown,
  context: { readonly operation: string; readonly valueSchema: z.ZodType<T> },
): ResultType<T, Exclude<RemoteRunnerResponseDecodeError, RemoteRunnerMalformedJsonError>> {
  return decodeRemoteRunnerResponse(context.operation, value, context.valueSchema);
}

export const decodeRemoteReadTextResponseJson = (text: string) =>
  decodeRemoteRunnerResponseJson("fs.read_text", text, remoteReadTextResponseSchema);
export const decodeRemoteReadBytesResponseJson = (text: string) =>
  decodeRemoteRunnerResponseJson("fs.read_bytes", text, remoteReadBytesResponseSchema);
export const decodeRemoteGlobResponseJson = (text: string) =>
  decodeRemoteRunnerResponseJson("fs.glob", text, remoteGlobResponseSchema);
export const decodeRemoteGrepResponseJson = (text: string) =>
  decodeRemoteRunnerResponseJson("fs.grep", text, remoteGrepResponseSchema);
export const decodeRemoteFuzzySearchResponseJson = (text: string) =>
  decodeRemoteRunnerResponseJson("fs.fuzzy_search", text, remoteFuzzySearchResponseSchema);
export const decodeRemoteEditResponseJson = (text: string) =>
  decodeRemoteRunnerResponseJson("fs.edit", text, remoteEditResponseSchema);
export const decodeRemoteApplyPatchResponseJson = (text: string) =>
  decodeRemoteRunnerResponseJson("apply_patch", text, remoteApplyPatchResponseSchema);
export const decodeRemoteHealthResponseJson = (text: string) =>
  decodeRemoteRunnerResponseJson("health", text, remoteHealthResponseSchema);
