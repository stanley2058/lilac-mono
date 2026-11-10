import { realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { normalize, resolve } from "node:path";

import { Panic, Result, TaggedError, type Result as ResultType } from "better-result";

import { hasRecursiveFlag } from "./analyze/rm-flags";
import { bashSafetyViolation, type BashSafetyViolation } from "./types";

const REASON_RM_RF =
  "recursive rm outside cwd is blocked. Use explicit paths within the current directory, or delete manually.";
const REASON_RM_RF_ROOT_HOME =
  "recursive rm targeting root or home directory is extremely dangerous and always blocked.";
const HINT_LITERAL_CHILD_DELETE =
  "Select the intended parent as cwd and remove a literal child path within it.";
const HINT_ROOT_HOME_DELETE =
  "Target a specific child path inside the selected cwd; root and home cannot be removed.";

export interface AnalyzeRmOptions {
  cwd?: string;
  originalCwd?: string;
  paranoid?: boolean;
  allowTmpdirVar?: boolean;
  tmpdirOverridden?: boolean;
}

interface RmContext {
  readonly anchoredCwd: string | null;
  readonly resolvedCwd: string | null;
  readonly paranoid: boolean;
  readonly trustTmpdirVar: boolean;
  readonly homeDir: string;
}

type TargetClassification =
  | { kind: "root_or_home_target" }
  | { kind: "cwd_self_target" }
  | { kind: "temp_target" }
  | { kind: "within_anchored_cwd" }
  | { kind: "outside_anchored_cwd" }
  | { kind: "unknown" };

class RmPathResolutionFailed extends TaggedError("RmPathResolutionFailed")<{
  readonly cwd: string;
  readonly target: string;
  readonly cause: unknown;
  readonly message: string;
}> {}

interface ResolvedRmPaths {
  readonly cwd: string;
  readonly target: string;
}

function resolveRmPaths(
  cwd: string,
  target: string,
): ResultType<ResolvedRmPaths, RmPathResolutionFailed> {
  const captured = Result.try({
    try: () => ({ cwd: realpathSync(cwd), target: realpathSync(resolve(cwd, target)) }),
    catch: (cause) => ({ cause }),
  });
  const outcome = captured.match<{ readonly value: ResolvedRmPaths } | { readonly cause: unknown }>(
    {
      ok: (value) => ({ value }),
      err: ({ cause }) => ({ cause }),
    },
  );
  if ("value" in outcome) return Result.ok(outcome.value);
  if (Panic.is(outcome.cause)) throw outcome.cause;
  return Result.err(
    new RmPathResolutionFailed({
      cwd,
      target,
      cause: outcome.cause,
      message: "rm target paths could not be resolved",
    }),
  );
}

export function analyzeRm(
  tokens: string[],
  options: AnalyzeRmOptions = {},
): BashSafetyViolation | null {
  const {
    cwd,
    originalCwd,
    paranoid = false,
    allowTmpdirVar = true,
    tmpdirOverridden = false,
  } = options;

  const anchoredCwd = originalCwd ?? cwd ?? null;
  const resolvedCwd = cwd ?? null;
  const trustTmpdirVar = allowTmpdirVar && !tmpdirOverridden;

  const ctx: RmContext = {
    anchoredCwd,
    resolvedCwd,
    paranoid,
    trustTmpdirVar,
    homeDir: getHomeDirForRmPolicy(),
  };

  if (!hasRecursiveFlag(tokens)) {
    return null;
  }

  const targets = extractTargets(tokens);

  for (const target of targets) {
    const classification = classifyTarget(target, ctx);
    const reason = reasonForClassification(classification, ctx);
    if (reason) {
      return reason;
    }
  }

  return null;
}

function extractTargets(tokens: readonly string[]): string[] {
  const targets: string[] = [];
  let pastDoubleDash = false;

  for (let i = 1; i < tokens.length; i++) {
    const token = tokens[i];
    if (!token) continue;

    if (token === "--") {
      pastDoubleDash = true;
      continue;
    }

    if (pastDoubleDash) {
      targets.push(token);
      continue;
    }

    if (!token.startsWith("-")) {
      targets.push(token);
    }
  }

  return targets;
}

function classifyTarget(target: string, ctx: RmContext): TargetClassification {
  if (isDangerousRootOrHomeTarget(target)) {
    return { kind: "root_or_home_target" };
  }

  const anchoredCwd = ctx.anchoredCwd;
  if (anchoredCwd) {
    if (isCwdSelfTarget(target, anchoredCwd, ctx.resolvedCwd)) {
      return { kind: "cwd_self_target" };
    }
  }

  if (isTempTarget(target, ctx.trustTmpdirVar)) {
    return { kind: "temp_target" };
  }

  if (!ctx.resolvedCwd && !target.startsWith("/")) {
    return ["*", ".", "./", "..", "./*", "../*"].includes(target)
      ? { kind: "cwd_self_target" }
      : { kind: "unknown" };
  }

  if (
    ctx.resolvedCwd &&
    (!anchoredCwd || !isTargetWithinCwd(target, anchoredCwd, ctx.resolvedCwd)) &&
    !target.includes("..") &&
    isTempTarget(resolve(ctx.resolvedCwd, target), ctx.trustTmpdirVar)
  ) {
    return { kind: "temp_target" };
  }

  if (anchoredCwd) {
    if (isCwdHomeForRmPolicy(anchoredCwd, ctx.homeDir)) {
      return { kind: "root_or_home_target" };
    }

    if (ctx.resolvedCwd && isTargetWithinCwd(target, anchoredCwd, ctx.resolvedCwd)) {
      return { kind: "within_anchored_cwd" };
    }
  }

  if (!anchoredCwd && !target.startsWith("/")) {
    return { kind: "unknown" };
  }

  return { kind: "outside_anchored_cwd" };
}

function reasonForClassification(
  classification: TargetClassification,
  ctx: RmContext,
): BashSafetyViolation | null {
  switch (classification.kind) {
    case "root_or_home_target":
      return bashSafetyViolation(
        "delete_root_or_home",
        REASON_RM_RF_ROOT_HOME,
        HINT_ROOT_HOME_DELETE,
      );
    case "cwd_self_target":
      return bashSafetyViolation("delete_current_cwd", REASON_RM_RF, HINT_LITERAL_CHILD_DELETE);
    case "temp_target":
      return null;
    case "within_anchored_cwd":
      if (ctx.paranoid) {
        return bashSafetyViolation(
          "paranoid_recursive_delete",
          `${REASON_RM_RF} (PARANOID_RM enabled)`,
          HINT_LITERAL_CHILD_DELETE,
        );
      }
      return null;
    case "outside_anchored_cwd":
      return bashSafetyViolation("delete_outside_cwd", REASON_RM_RF, HINT_LITERAL_CHILD_DELETE);
    case "unknown":
      return null;
  }
}

function isDangerousRootOrHomeTarget(path: string): boolean {
  const normalized = path.trim();

  if (normalized === "/" || normalized === "/*") {
    return true;
  }

  if (normalized === "~" || normalized === "~/" || normalized.startsWith("~/")) {
    if (normalized === "~" || normalized === "~/" || normalized === "~/*") {
      return true;
    }
  }

  if (normalized === "$HOME" || normalized === "$HOME/" || normalized === "$HOME/*") {
    return true;
  }

  if (normalized === "${HOME}" || normalized === "${HOME}/" || normalized === "${HOME}/*") {
    return true;
  }

  return false;
}

export function isTempTarget(path: string, allowTmpdirVar: boolean): boolean {
  const normalized = path.trim();

  if (normalized.includes("..")) {
    return false;
  }

  if (normalized === "/tmp" || normalized.startsWith("/tmp/")) {
    return true;
  }

  if (normalized === "/var/tmp" || normalized.startsWith("/var/tmp/")) {
    return true;
  }

  const systemTmpdir = tmpdir();
  if (normalized.startsWith(`${systemTmpdir}/`) || normalized === systemTmpdir) {
    return true;
  }

  if (allowTmpdirVar) {
    if (normalized === "$TMPDIR" || normalized.startsWith("$TMPDIR/")) {
      return true;
    }

    if (normalized === "${TMPDIR}" || normalized.startsWith("${TMPDIR}/")) {
      return true;
    }
  }

  return false;
}

function getHomeDirForRmPolicy(): string {
  return process.env.HOME ?? homedir();
}

function isCwdHomeForRmPolicy(cwd: string, homeDir: string): boolean {
  const normalizedCwd = normalize(cwd);
  const normalizedHome = normalize(homeDir);
  return normalizedCwd === normalizedHome;
}

function isCwdSelfTarget(target: string, cwd: string, effectiveCwd: string | null): boolean {
  if (target === "." || target === "./") {
    return true;
  }

  if (!effectiveCwd) return false;
  const resolvedTarget = resolve(effectiveCwd, target);
  const resolvedPaths = resolveRmPaths(cwd, resolvedTarget);
  const compare = resolvedPaths.match<() => boolean>({
    ok: (paths) => () => paths.target === paths.cwd,
    err: () => () => {
      // Missing paths cannot be canonicalized, so preserve the lexical fallback.
      const resolved = resolvedTarget;
      const normalizedCwd = normalize(cwd);
      return resolved === normalizedCwd;
    },
  });
  return compare();
}

function isTargetWithinCwd(target: string, originalCwd: string, effectiveCwd?: string): boolean {
  const resolveCwd = effectiveCwd ?? originalCwd;

  if (target.startsWith("~") || target.startsWith("$HOME") || target.startsWith("${HOME}")) {
    return false;
  }

  if (target.includes("$") || target.includes("`")) {
    return false;
  }

  if (target.startsWith("/")) {
    const normalizedTarget = normalize(target);
    const normalizedCwd = `${normalize(originalCwd)}/`;
    return normalizedTarget.startsWith(normalizedCwd);
  }

  if (target.startsWith("./") || !target.includes("/")) {
    const resolved = resolve(resolveCwd, target);
    const normalizedOriginalCwd = normalize(originalCwd);
    return resolved.startsWith(`${normalizedOriginalCwd}/`) || resolved === normalizedOriginalCwd;
  }

  if (target.startsWith("../")) {
    return false;
  }

  const resolved = resolve(resolveCwd, target);
  const normalizedCwd = normalize(originalCwd);
  return resolved.startsWith(`${normalizedCwd}/`) || resolved === normalizedCwd;
}

export function isHomeDirectory(cwd: string): boolean {
  const home = process.env.HOME ?? homedir();
  const normalizedCwd = normalize(cwd);
  const normalizedHome = normalize(home);
  return normalizedCwd === normalizedHome;
}
