import { Result, TaggedError, type Result as ResultType } from "better-result";

export class CodingToolGuardrailViolation extends TaggedError("CodingToolGuardrailViolation")<{
  readonly message: string;
}> {}

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
