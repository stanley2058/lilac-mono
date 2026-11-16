import path from "node:path";

import { isRecord } from "@stanley2058/lilac-utils";
import { Panic, Result, TaggedError, type Result as ResultType } from "better-result";
import { z } from "zod";

import { captureError } from "../shared/error-capture.js";
import type { McpValueSource } from "./config-types";
import { opaqueErrorMessage, rethrowPanic } from "./error-format";

type JsonValue =
  | null
  | string
  | number
  | boolean
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export class McpEnvironmentValueMissingError extends TaggedError(
  "McpEnvironmentValueMissingError",
)<{
  readonly variable: string;
  readonly message: string;
}> {}

export class McpValueFileReadError extends TaggedError("McpValueFileReadError")<{
  readonly source: string;
  readonly cause: unknown;
  readonly message: string;
}> {}

export class McpValueJsonParseError extends TaggedError("McpValueJsonParseError")<{
  readonly source: string;
  readonly cause: unknown;
  readonly message: string;
}> {}

export class McpJsonPointerError extends TaggedError("McpJsonPointerError")<{
  readonly pointer: string;
  readonly message: string;
}> {}

export class McpValuePointerError extends TaggedError("McpValuePointerError")<{
  readonly source: string;
  readonly pointer: string;
  readonly cause: McpJsonPointerError;
  readonly message: string;
}> {}

export class McpValueNotStringError extends TaggedError("McpValueNotStringError")<{
  readonly source: string;
  readonly pointer: string;
  readonly message: string;
}> {}

export class McpValueMapResolutionError extends TaggedError("McpValueMapResolutionError")<{
  readonly key: string;
  readonly cause: McpValueSourceError;
  readonly message: string;
}> {}

export class McpInvalidHttpHeaderError extends TaggedError("McpInvalidHttpHeaderError")<{
  readonly headerName: string;
  readonly message: string;
}> {}

export type McpValueSourceError =
  | McpEnvironmentValueMissingError
  | McpValueFileReadError
  | McpValueJsonParseError
  | McpValuePointerError
  | McpValueNotStringError;

export type McpValueResolution = ResultType<string, McpValueSourceError>;
export type McpValueMapResolution = ResultType<Record<string, string>, McpValueMapResolutionError>;

export type McpValueResolutionContext = {
  /** Relative file sources resolve from the directory containing mcp-config.yaml. */
  readonly baseDir: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly readTextFile?: (filePath: string) => Promise<string>;
};

const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.null(),
    z.string(),
    z.number(),
    z.boolean(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
);

function quoteJsonPointerSegment(segment: string): string {
  return JSON.stringify(segment);
}

function decodeJsonPointerSegment(
  segment: string,
  pointer: string,
): ResultType<string, McpJsonPointerError> {
  if (/~(?:[^01]|$)/.test(segment)) {
    return Result.err(
      new McpJsonPointerError({
        pointer,
        message: `JSON pointer segment ${JSON.stringify(segment)} has invalid escaping`,
      }),
    );
  }
  return Result.ok(segment.replaceAll("~1", "/").replaceAll("~0", "~"));
}

export function resolveJsonPointer(
  document: JsonValue,
  pointer: string,
): ResultType<JsonValue, McpJsonPointerError> {
  if (pointer === "") return Result.ok(document);
  if (!pointer.startsWith("/")) {
    return Result.err(
      new McpJsonPointerError({
        pointer,
        message: `JSON pointer must be empty or start with '/': ${JSON.stringify(pointer)}`,
      }),
    );
  }

  const rawSegments = pointer.slice(1).split("/");
  const resolveAt = (
    current: JsonValue,
    segmentIndex: number,
  ): ResultType<JsonValue, McpJsonPointerError> => {
    const rawSegment = rawSegments[segmentIndex];
    if (rawSegment === undefined) return Result.ok(current);
    const decodedSegment = decodeJsonPointerSegment(rawSegment, pointer);
    const continueSegment = decodedSegment.match<() => ResultType<JsonValue, McpJsonPointerError>>({
      err: (error) => () => Result.err(error),
      ok: (segment) => () => {
        if (Array.isArray(current)) {
          if (!/^(0|[1-9][0-9]*)$/.test(segment)) {
            return Result.err(
              new McpJsonPointerError({
                pointer,
                message: `JSON pointer segment ${quoteJsonPointerSegment(segment)} is not an array index`,
              }),
            );
          }
          const index = Number(segment);
          const value = current[index];
          if (index >= current.length || value === undefined) {
            return Result.err(
              new McpJsonPointerError({
                pointer,
                message: `JSON pointer array index ${segment} is out of bounds`,
              }),
            );
          }
          return resolveAt(value, segmentIndex + 1);
        }
        if (isRecord(current)) {
          const value = current[segment];
          if (!Object.hasOwn(current, segment) || value === undefined) {
            return Result.err(
              new McpJsonPointerError({
                pointer,
                message: `JSON pointer segment ${quoteJsonPointerSegment(segment)} does not exist`,
              }),
            );
          }
          return resolveAt(value, segmentIndex + 1);
        }
        return Result.err(
          new McpJsonPointerError({
            pointer,
            message: `JSON pointer segment ${quoteJsonPointerSegment(segment)} has no parent object`,
          }),
        );
      },
    });
    return continueSegment();
  };
  return resolveAt(document, 0);
}

async function captureTextFileRead(
  filePath: string,
  source: string,
  context: McpValueResolutionContext,
): Promise<ResultType<string, McpValueFileReadError>> {
  const captured = await Result.tryPromise({
    try: () => (context.readTextFile ? context.readTextFile(filePath) : Bun.file(filePath).text()),
    catch: (cause) => {
      if (Panic.is(cause)) return { kind: "panic", panic: cause } as const;
      if (cause instanceof Error) return { kind: "error", cause } as const;
      return {
        kind: "failure",
        error: new McpValueFileReadError({
          source,
          cause,
          message: `failed to read ${source}: Unknown error`,
        }),
      } as const;
    },
  });
  return captured.match<() => ResultType<string, McpValueFileReadError>>({
    ok: (text) => () => Result.ok(text),
    err: (failure) => () => {
      if (failure.kind === "panic") {
        rethrowPanic(failure.panic);
        return Result.err(
          new McpValueFileReadError({
            source,
            cause: failure.panic,
            message: `failed to read ${source}`,
          }),
        );
      }
      if (failure.kind === "failure") return Result.err(failure.error);
      const cause = failure.cause;
      rethrowPanic(cause);
      return Result.err(
        new McpValueFileReadError({
          source,
          cause,
          message: `failed to read ${source}: ${opaqueErrorMessage(cause)}`,
        }),
      );
    },
  })();
}

function decodeJsonValue(
  source: string,
  text: string,
): ResultType<JsonValue, McpValueJsonParseError> {
  const json = Result.try({
    try: () => JSON.parse(text),
    catch: (cause) =>
      Panic.is(cause)
        ? ({ kind: "panic", panic: cause } as const)
        : ({
            kind: "failure",
            ...captureError(cause, `failed to parse ${source}`),
          } as const),
  }).match<
    | { readonly kind: "success"; readonly value: unknown }
    | { readonly kind: "panic"; readonly panic: Panic }
    | { readonly kind: "failure"; readonly cause: Error; readonly captured: unknown }
  >({
    ok: (value) => ({ kind: "success", value }),
    err: (failure) => failure,
  });
  if (json.kind === "panic") {
    rethrowPanic(json.panic);
    return Result.err(
      new McpValueJsonParseError({
        source,
        cause: json.panic,
        message: `failed to parse ${source}`,
      }),
    );
  }
  if (json.kind === "failure") {
    return Result.err(
      new McpValueJsonParseError({
        source,
        cause: json.cause,
        message: `failed to parse ${source} as JSON: ${opaqueErrorMessage(json.cause)}`,
      }),
    );
  }
  const parsed = jsonValueSchema.safeParse(json.value);
  if (!parsed.success) {
    return Result.err(
      new McpValueJsonParseError({
        source,
        cause: parsed.error,
        message: `failed to parse ${source} as JSON: ${parsed.error.message}`,
      }),
    );
  }
  return Result.ok(parsed.data);
}

export async function resolveMcpValueSource(
  source: McpValueSource,
  context: McpValueResolutionContext,
): Promise<McpValueResolution> {
  if (typeof source === "string") return Result.ok(source);

  if ("env" in source) {
    const value = context.env[source.env];
    return value === undefined
      ? Result.err(
          new McpEnvironmentValueMissingError({
            variable: source.env,
            message: `environment variable ${source.env} is not set`,
          }),
        )
      : Result.ok(`${source.prefix ?? ""}${value}`);
  }

  const filePath = path.isAbsolute(source.file)
    ? source.file
    : path.resolve(context.baseDir, source.file);
  const read = await captureTextFileRead(filePath, source.file, context);
  return read.match<() => Promise<McpValueResolution>>({
    err: (error) => async () => Result.err(error),
    ok: (text) => async () => {
      if (source.pointer === undefined) return Result.ok(`${source.prefix ?? ""}${text.trim()}`);
      const pointer = source.pointer;
      return decodeJsonValue(source.file, text).andThen((document) =>
        resolveJsonPointer(document, pointer)
          .mapError(
            (error) =>
              new McpValuePointerError({
                source: source.file,
                pointer,
                cause: error,
                message: `${source.file}: ${error.message}`,
              }),
          )
          .andThen((resolved) =>
            typeof resolved === "string"
              ? Result.ok(`${source.prefix ?? ""}${resolved}`)
              : Result.err(
                  new McpValueNotStringError({
                    source: source.file,
                    pointer,
                    message: `${source.file}: pointer ${pointer} did not resolve to a string`,
                  }),
                ),
          ),
      );
    },
  })();
}

async function resolveMcpValueSourceEntry(
  key: string,
  source: McpValueSource,
  context: McpValueResolutionContext,
): Promise<ResultType<string, McpValueMapResolutionError>> {
  const resolution = await resolveMcpValueSource(source, context);
  return resolution.mapError(
    (error) =>
      new McpValueMapResolutionError({
        key,
        cause: error,
        message: `${key}: ${error.message}`,
      }),
  );
}

export async function resolveMcpValueSourceMap(
  sources: Readonly<Record<string, McpValueSource>>,
  context: McpValueResolutionContext,
): Promise<McpValueMapResolution> {
  const values: Record<string, string> = {};
  for (const key of Object.keys(sources).sort()) {
    const source = sources[key];
    if (source === undefined) continue;
    const resolved = await resolveMcpValueSourceEntry(key, source, context);
    if (resolved.isErr()) return Result.err(resolved.error);
    values[key] = resolved.value;
  }
  return Result.ok(values);
}

const INVALID_HEADER_NAME = /[^!#$%&'*+\-.^_`|~0-9A-Za-z]/;
// eslint-disable-next-line no-control-regex
const INVALID_HEADER_VALUE = /[\0\r\n]/;

export function validateHttpHeaders(
  headers: Readonly<Record<string, string>>,
): ResultType<void, McpInvalidHttpHeaderError> {
  for (const [name, value] of Object.entries(headers)) {
    if (name.length === 0 || INVALID_HEADER_NAME.test(name)) {
      return Result.err(
        new McpInvalidHttpHeaderError({
          headerName: name,
          message: `header name ${JSON.stringify(name)} is not a valid HTTP token`,
        }),
      );
    }
    if (INVALID_HEADER_VALUE.test(value)) {
      return Result.err(
        new McpInvalidHttpHeaderError({
          headerName: name,
          message: `header ${name} contains characters that are not valid in an HTTP header value`,
        }),
      );
    }
  }
  return Result.ok();
}
