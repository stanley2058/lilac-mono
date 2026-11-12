import fssync from "node:fs";
import {
  decodeBundledRemoteRunnerRequestJson,
  FileSystem,
  type RemoteEditResponse,
  type RemoteGlobResponse,
  type RemoteGrepResponse,
  type RemoteReadBytesResponse,
  type RemoteReadTextResponse,
  type EditFileResult,
  type BundledRemoteRunnerRequest,
} from "@stanley2058/lilac-fs";
import type { PatchRejected } from "@stanley2058/lilac-coding-tools/apply-patch";
import { Result, type Result as ResultType } from "better-result";

import { applyHunks, parsePatchResult } from "../../tools/apply-patch/apply-patch-core";
import {
  bundledRemoteRunnerErrorMessage,
  rethrowBundledRemoteRunnerPanic,
} from "./bundled-runner-failure";
import { captureOpaqueErrorCause, projectOpaqueErrorCapture } from "./remote-runner-utils";

type ReadTextRequest = Extract<BundledRemoteRunnerRequest, { op: "fs.read_text" }>;
type ReadBytesRequest = Extract<BundledRemoteRunnerRequest, { op: "fs.read_bytes" }>;
type GlobRequest = Extract<BundledRemoteRunnerRequest, { op: "fs.glob" }>;
type GrepRequest = Extract<BundledRemoteRunnerRequest, { op: "fs.grep" }>;
type EditRequest = Extract<BundledRemoteRunnerRequest, { op: "fs.edit" }>;
type ApplyPatchRequest = Extract<BundledRemoteRunnerRequest, { op: "apply_patch" }>;

type BundledRunnerSuccessValue =
  | RemoteReadTextResponse
  | RemoteReadBytesResponse
  | RemoteGlobResponse
  | RemoteGrepResponse
  | RemoteEditResponse
  | string;

function ok(value: BundledRunnerSuccessValue): void {
  process.stdout.write(JSON.stringify({ ok: true, value }));
}

function fail(error: { readonly message: string }): void {
  process.stdout.write(JSON.stringify({ ok: false, error: error.message }));
}

function normalizeEditOutput(result: EditFileResult): EditFileResult {
  if (result.success) {
    return {
      success: true,
      resolvedPath: result.resolvedPath,
      oldHash: result.oldHash,
      newHash: result.newHash,
      changesMade: result.changesMade,
      replacementsMade: result.replacementsMade,
    };
  }

  return {
    success: false,
    resolvedPath: result.resolvedPath,
    currentHash: result.currentHash,
    error: result.error,
  };
}

async function opReadText(input: ReadTextRequest["input"], fsTool: FileSystem) {
  const readRes = await fsTool.readFile({
    path: input.path,
    start: input.start,
    maxLines: input.maxLines,
    maxCharacters: input.maxCharacters,
    maxBytes: input.maxBytes,
    format: input.format ?? "raw",
  });
  return readRes;
}

async function opReadBytes(
  input: ReadBytesRequest["input"],
  fsTool: FileSystem,
): Promise<RemoteReadBytesResponse> {
  const result = await fsTool.readFileBytes({
    path: input.path,
    maxBytes: input.maxBytes ?? 10_000_000,
    prefixBytes: input.prefixBytes,
  });
  if (!result.success) {
    return {
      ok: false,
      resolvedPath: result.resolvedPath,
      error: result.error.message,
      errorCode: result.error.code,
    };
  }
  return {
    ok: true,
    resolvedPath: result.resolvedPath,
    fileHash: result.fileHash,
    bytesLength: result.bytesLength,
    ...(result.totalBytes === undefined ? {} : { totalBytes: result.totalBytes }),
    base64: Buffer.from(result.bytes).toString("base64"),
  };
}

async function opGlob(input: GlobRequest["input"], fsTool: FileSystem) {
  return await fsTool.glob({
    patterns: input.patterns,
    maxEntries: input.maxEntries,
    mode: input.mode ?? "default",
  });
}

async function opGrep(input: GrepRequest["input"], fsTool: FileSystem) {
  return await fsTool.grep({
    pattern: input.pattern,
    baseDir: input.baseDir,
    reportedFilePath: input.reportedFilePath,
    regex: input.regex,
    maxResults: input.maxResults,
    fileExtensions: input.fileExtensions?.map((extension) => extension.replace(/^\./, "")),
    includeContextLines: input.includeContextLines,
    mode: input.mode ?? "default",
  });
}

async function opEdit(input: EditRequest["input"], fsTool: FileSystem): Promise<EditFileResult> {
  const pathInput = input.path;
  const expectedHash =
    input.expectedHash && input.expectedHash.length > 0 ? input.expectedHash : undefined;

  if (input.mode === "hashline") {
    const editRes = await fsTool.hashlineEditFile({
      path: pathInput,
      edits: input.edits,
      expectedHash,
    });
    return normalizeEditOutput(editRes);
  }

  if (expectedHash) {
    const editRes = await fsTool.editFile({ path: pathInput, edits: input.edits, expectedHash });
    return normalizeEditOutput(editRes);
  }

  const readRes = await fsTool.readFile({
    path: pathInput,
    start: { type: "line", line: 1 },
    maxLines: 1,
    maxCharacters: 1,
    format: "raw",
  });
  if (!readRes.success) {
    return readRes;
  }

  const editRes = await fsTool.editFile({
    path: pathInput,
    edits: input.edits,
    expectedHash: readRes.fileHash,
  });
  return normalizeEditOutput(editRes);
}

async function opApplyPatch(
  input: ApplyPatchRequest["input"],
  denyPaths: readonly string[],
): Promise<ResultType<string, PatchRejected>> {
  const parsed = parsePatchResult(input.patchText);
  return parsed.match<() => Promise<ResultType<string, PatchRejected>>>({
    err: (error) => async () => Result.err(error),
    ok: (hunks) => async () => Result.ok(await applyHunks(process.cwd(), hunks, { denyPaths })),
  })();
}

function readTextFromStdin(): string {
  return fssync.readFileSync(0, "utf8");
}

async function runRequest(): Promise<void> {
  const parsed = decodeBundledRemoteRunnerRequestJson(readTextFromStdin());
  await parsed.match({
    ok: (request) => async () => {
      const denyPaths = request.denyPaths;
      const fsTool = new FileSystem(process.cwd(), { denyPaths });

      switch (request.op) {
        case "fs.read_text":
          ok(await opReadText(request.input, fsTool));
          return;
        case "fs.read_bytes":
          ok(await opReadBytes(request.input, fsTool));
          return;
        case "fs.glob":
          ok(await opGlob(request.input, fsTool));
          return;
        case "fs.grep":
          ok(await opGrep(request.input, fsTool));
          return;
        case "fs.edit":
          ok(await opEdit(request.input, fsTool));
          return;
        case "apply_patch": {
          const applied = await opApplyPatch(request.input, denyPaths);
          applied.match<() => void>({
            ok: (value) => () => ok(value),
            err: (error) => () => fail(error),
          })();
          return;
        }
      }
    },
    err: (error) => async () => {
      fail(error);
    },
  })();
}

async function main(): Promise<void> {
  const executed = (
    await Result.tryPromise({ try: runRequest, catch: captureOpaqueErrorCause })
  ).mapError((captured) =>
    projectOpaqueErrorCapture(captured, "Opaque bundled remote runner failure"),
  );
  executed.match({
    ok: () => undefined,
    err: (caught) => () => {
      const error = rethrowBundledRemoteRunnerPanic(caught);
      fail({ message: bundledRemoteRunnerErrorMessage(error) });
    },
  })?.();
}

main();
