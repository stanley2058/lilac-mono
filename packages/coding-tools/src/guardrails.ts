import path from "node:path";

import {
  canonicalizePathAsFarAsExists,
  expandTilde,
  FileSystemOperationFailed,
} from "@stanley2058/lilac-fs";
import { Result, TaggedError, type Result as ResultType } from "better-result";

import { adaptCodingToolResultToHost } from "./host-compatibility";

export class CodingToolGuardrailViolation extends TaggedError("CodingToolGuardrailViolation")<{
  readonly message: string;
}> {}

export type CanonicalPathError = CodingToolGuardrailViolation | FileSystemOperationFailed;

function isPathWithin(candidatePath: string, parentPath: string): boolean {
  const relative = path.relative(parentPath, candidatePath);
  return (
    relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}

export function guardrailBypassAllowed(
  dangerouslyAllow: boolean | undefined,
  allowGuardrailBypass: boolean,
): ResultType<void, CodingToolGuardrailViolation> {
  if (!dangerouslyAllow || allowGuardrailBypass) return Result.ok(undefined);
  return Result.err(
    new CodingToolGuardrailViolation({
      message:
        "dangerouslyAllow is disabled for this toolset; set allowGuardrailBypass=true when constructing it",
    }),
  );
}

export function assertGuardrailBypassAllowed(
  dangerouslyAllow: boolean | undefined,
  allowGuardrailBypass: boolean,
): void {
  adaptCodingToolResultToHost(guardrailBypassAllowed(dangerouslyAllow, allowGuardrailBypass));
}

export function validateLocalCwd(cwd: string): ResultType<void, CodingToolGuardrailViolation> {
  const trimmed = cwd.trim();
  const isWindowsDrivePath = /^[A-Za-z]:[\\/]/u.test(trimmed);
  if (!isWindowsDrivePath && /^[A-Za-z0-9_.@-]+:/u.test(trimmed)) {
    return Result.err(
      new CodingToolGuardrailViolation({
        message: `The local coding-tools adapter does not support SSH cwd target '${cwd}'`,
      }),
    );
  }
  return Result.ok(undefined);
}

export function assertLocalCwd(cwd: string): void {
  adaptCodingToolResultToHost(validateLocalCwd(cwd));
}

export async function canonicalizeAsFarAsExistsResult(
  inputPath: string,
): Promise<ResultType<string, FileSystemOperationFailed>> {
  return (await canonicalizePathAsFarAsExists(expandTilde(inputPath))).mapError((error) => {
    const operation =
      error.operation === "inspect canonical path segment"
        ? "inspect unresolved path"
        : error.operation;
    return new FileSystemOperationFailed({
      operation: operation === "read canonical path symlink" ? "read symbolic link" : operation,
      code: error.code,
      message: error.message,
    });
  });
}

export async function canonicalizeAsFarAsExists(inputPath: string): Promise<string> {
  return adaptCodingToolResultToHost(await canonicalizeAsFarAsExistsResult(inputPath));
}

export async function canonicalPathAllowed(params: {
  targetPath: string;
  denyPaths: readonly string[];
  operation: string;
  dangerouslyAllow?: boolean;
}): Promise<ResultType<void, CanonicalPathError>> {
  if (params.dangerouslyAllow) return Result.ok(undefined);
  const target = await canonicalizeAsFarAsExistsResult(params.targetPath);
  const targetOutcome = target.match<{ value: string } | { error: FileSystemOperationFailed }>({
    ok: (value) => ({ value }),
    err: (error) => ({ error }),
  });
  if ("error" in targetOutcome) return Result.err(targetOutcome.error);
  for (const denyPath of params.denyPaths) {
    const denied = await canonicalizeAsFarAsExistsResult(denyPath);
    const deniedOutcome = denied.match<{ value: string } | { error: FileSystemOperationFailed }>({
      ok: (value) => ({ value }),
      err: (error) => ({ error }),
    });
    if ("error" in deniedOutcome) return Result.err(deniedOutcome.error);
    if (isPathWithin(targetOutcome.value, deniedOutcome.value)) {
      return Result.err(
        new CodingToolGuardrailViolation({
          message: `Access denied: '${params.targetPath}' resolves into protected path '${deniedOutcome.value}' for ${params.operation}`,
        }),
      );
    }
  }
  return Result.ok(undefined);
}

export async function assertCanonicalPathAllowed(
  targetPath: string,
  denyPaths: readonly string[],
  operation: string,
  dangerouslyAllow = false,
): Promise<void> {
  adaptCodingToolResultToHost(
    await canonicalPathAllowed({ targetPath, denyPaths, operation, dangerouslyAllow }),
  );
}
