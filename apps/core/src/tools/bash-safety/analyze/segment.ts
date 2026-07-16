import {
  type AnalyzeOptions,
  INTERPRETERS,
  PARANOID_INTERPRETERS_SUFFIX,
  SHELL_WRAPPERS,
} from "../types";

import { analyzeGit } from "../rules-git";
import { analyzeRm, isHomeDirectory } from "../rules-rm";
import {
  getBasename,
  hasNontrivialParameterExpansion,
  normalizeCommandToken,
  stripEnvAssignmentsWithInfo,
  stripWrappers,
  stripWrappersWithInfo,
} from "../shell";

import { DISPLAY_COMMANDS } from "./constants";
import { analyzeFind } from "./find";
import { containsDangerousCode, extractInterpreterCodeArg } from "./interpreters";
import { analyzeParallel } from "./parallel";
import { hasRecursiveForceFlags } from "./rm-flags";
import { extractDashCArg } from "./shell-wrappers";
import { isTmpdirOverriddenToNonTemp } from "./tmpdir";
import { analyzeXargs } from "./xargs";

const REASON_INTERPRETER_DANGEROUS = "Detected potentially dangerous command in interpreter code.";
const REASON_INTERPRETER_BLOCKED = "Interpreter one-liners are blocked in paranoid mode.";
const REASON_RM_HOME_CWD =
  "rm -rf in home directory is dangerous. Change to a project directory first.";
const REASON_DYNAMIC_COMMAND =
  "Command executable is determined by a dynamic shell expansion and cannot be safely analyzed.";
const REASON_DYNAMIC_ARGUMENT =
  "A safety-relevant command argument is determined by a nontrivial shell expansion and cannot be safely analyzed.";
const REASON_UNPARSEABLE_WRAPPER =
  "Command execution wrapper options could not be safely analyzed.";

const COMMAND_PREFIX_KEYWORDS = new Set([
  "{",
  "do",
  "then",
  "else",
  "elif",
  "if",
  "while",
  "until",
  "!",
]);
const COMMAND_EXECUTION_WRAPPERS = new Set([
  "builtin",
  "chrt",
  "exec",
  "ionice",
  "nice",
  "nohup",
  "setsid",
  "stdbuf",
  "time",
  "timeout",
]);
const PARAMETER_EXPANSION_VALUE_COMMANDS = new Set(["[", "echo", "printf", "tee", "test"]);
const DYNAMIC_ARGUMENT_SENSITIVE_COMMANDS = new Set([
  ".",
  "bash",
  "cat",
  "csh",
  "curl",
  "dash",
  "eval",
  "find",
  "fish",
  "git",
  "ksh",
  "node",
  "parallel",
  "perl",
  "python",
  "python2",
  "python3",
  "rm",
  "ruby",
  "sh",
  "source",
  "tcsh",
  "wget",
  "xargs",
  "zsh",
]);

const SENSITIVE_TOKEN_PATTERNS: Array<{ re: RegExp; reason: string }> = [
  { re: /private-keys-v1\.d\b/i, reason: "access to GPG private keys" },
  { re: /(^|\/|\\)secret\/(gnupg)(\/|$)/i, reason: "access to agent GNUPGHOME" },
  { re: /(^|\/|\\)\.ssh(\/|$)/i, reason: "access to ~/.ssh" },
  { re: /(^|\/|\\)\.aws(\/|$)/i, reason: "access to ~/.aws" },
  { re: /(^|\/|\\)\.gnupg(\/|$)/i, reason: "access to ~/.gnupg" },
  {
    re: /\$\{?GNUPGHOME\}?\//i,
    reason: "access to agent GNUPGHOME via $GNUPGHOME",
  },
  {
    re: /github-app\.private-key\.pem\b/i,
    reason: "access to GitHub App private key",
  },
  {
    re: /github-user-token\.json\b/i,
    reason: "access to GitHub user token secret",
  },
];

export type SegmentAnalyzeOptions = AnalyzeOptions & {
  effectiveCwd: string | null | undefined;
  analyzeNested: (command: string) => string | null;
};

function deriveCwdContext(options: Pick<SegmentAnalyzeOptions, "cwd" | "effectiveCwd">): {
  cwdUnknown: boolean;
  cwdForRm: string | undefined;
  originalCwd: string | undefined;
} {
  const cwdUnknown = options.effectiveCwd === null;
  const cwdForRm = cwdUnknown ? undefined : (options.effectiveCwd ?? options.cwd);
  const originalCwd = cwdUnknown ? undefined : options.cwd;
  return { cwdUnknown, cwdForRm, originalCwd };
}

export function analyzeSegment(tokens: string[], options: SegmentAnalyzeOptions): string | null {
  if (tokens.length === 0) {
    return null;
  }

  const { tokens: strippedEnv, envAssignments: leadingEnvAssignments } =
    stripEnvAssignmentsWithInfo(tokens);
  const { tokens: stripped, envAssignments: wrapperEnvAssignments } =
    stripWrappersWithInfo(strippedEnv);

  const envAssignments = new Map(leadingEnvAssignments);
  for (const [k, v] of wrapperEnvAssignments) {
    envAssignments.set(k, v);
  }

  if (stripped.length === 0) {
    return null;
  }

  if (hasDynamicCommandHead(stripped)) {
    return REASON_DYNAMIC_COMMAND;
  }

  if (hasDynamicNestedExecutable(stripped)) {
    return REASON_DYNAMIC_COMMAND;
  }

  const commandIndex = commandTokenIndex(stripped);
  const executableTokens = stripped.slice(commandIndex);
  const normalizedExecutable = normalizeCommandToken(executableTokens[0] ?? "");
  if (COMMAND_EXECUTION_WRAPPERS.has(normalizedExecutable)) {
    const wrappedCommand = unwrapStaticExecutionWrapper(executableTokens);
    if (!wrappedCommand) {
      return REASON_UNPARSEABLE_WRAPPER;
    }
    if (wrappedCommand.length === 0) {
      return null;
    }
    return analyzeSegment(wrappedCommand, options);
  }

  for (const token of stripped) {
    if (!token) continue;
    for (const { re, reason } of SENSITIVE_TOKEN_PATTERNS) {
      if (re.test(token)) {
        return reason;
      }
    }
  }

  const head = stripped[0];
  if (!head) {
    return null;
  }

  const normalizedHead = normalizeCommandToken(stripped[commandIndex] ?? head);
  const basename = getBasename(head);

  if (
    stripped.some(hasNontrivialParameterExpansion) &&
    !PARAMETER_EXPANSION_VALUE_COMMANDS.has(normalizedHead)
  ) {
    return REASON_DYNAMIC_ARGUMENT;
  }

  if (
    (DYNAMIC_ARGUMENT_SENSITIVE_COMMANDS.has(normalizedHead) ||
      COMMAND_EXECUTION_WRAPPERS.has(normalizedHead)) &&
    stripped.slice(commandIndex + 1).some((token) => token.includes("$"))
  ) {
    return REASON_DYNAMIC_ARGUMENT;
  }

  const { cwdForRm, originalCwd } = deriveCwdContext(options);

  const allowTmpdirVar =
    (options.allowTmpdirVar ?? true) && !isTmpdirOverriddenToNonTemp(envAssignments);

  if (SHELL_WRAPPERS.has(normalizedHead)) {
    const dashCArg = extractDashCArg(stripped);
    if (dashCArg) {
      return options.analyzeNested(dashCArg);
    }
  }

  if (normalizedHead === "eval") {
    const payload = stripped.slice(commandIndex + 1).join(" ");
    return payload ? options.analyzeNested(payload) : null;
  }

  if (INTERPRETERS.has(normalizedHead)) {
    const codeArg = extractInterpreterCodeArg(stripped);
    if (codeArg) {
      if (options.paranoidInterpreters) {
        return REASON_INTERPRETER_BLOCKED + PARANOID_INTERPRETERS_SUFFIX;
      }

      const innerReason = options.analyzeNested(codeArg);
      if (innerReason) {
        return innerReason;
      }

      if (containsDangerousCode(codeArg)) {
        return REASON_INTERPRETER_DANGEROUS;
      }
    }
  }

  if (normalizedHead === "busybox" && stripped.length > 1) {
    return analyzeSegment(stripped.slice(1), options);
  }

  const isGit = basename.toLowerCase() === "git";
  const isRm = basename === "rm";
  const isFind = basename === "find";
  const isXargs = basename === "xargs";
  const isParallel = basename === "parallel";

  if (isGit) {
    const gitResult = analyzeGit(stripped);
    if (gitResult) {
      return gitResult;
    }
  }

  if (isRm) {
    if (cwdForRm && isHomeDirectory(cwdForRm)) {
      if (hasRecursiveForceFlags(stripped)) {
        return REASON_RM_HOME_CWD;
      }
    }

    const rmResult = analyzeRm(stripped, {
      cwd: cwdForRm,
      originalCwd,
      paranoid: options.paranoidRm,
      allowTmpdirVar,
    });

    if (rmResult) {
      return rmResult;
    }
  }

  if (isFind) {
    const findResult = analyzeFind(stripped);
    if (findResult) {
      return findResult;
    }
  }

  if (isXargs) {
    const xargsResult = analyzeXargs(stripped, {
      cwd: cwdForRm,
      originalCwd,
      paranoidRm: options.paranoidRm,
      allowTmpdirVar,
    });

    if (xargsResult) {
      return xargsResult;
    }
  }

  if (isParallel) {
    const parallelResult = analyzeParallel(stripped, {
      cwd: cwdForRm,
      originalCwd,
      paranoidRm: options.paranoidRm,
      allowTmpdirVar,
      analyzeNested: options.analyzeNested,
    });

    if (parallelResult) {
      return parallelResult;
    }
  }

  const matchedKnown = isGit || isRm || isFind || isXargs || isParallel;

  if (!matchedKnown) {
    // Fallback: scan tokens for embedded git/rm/find commands.
    // Skip for display-only commands that don't execute their arguments.
    if (!DISPLAY_COMMANDS.has(normalizedHead)) {
      for (let i = 1; i < stripped.length; i++) {
        const token = stripped[i];
        if (!token) continue;

        const cmd = normalizeCommandToken(token);
        if (cmd === "rm") {
          const rmTokens = ["rm", ...stripped.slice(i + 1)];
          const reason = analyzeRm(rmTokens, {
            cwd: cwdForRm,
            originalCwd,
            paranoid: options.paranoidRm,
            allowTmpdirVar,
          });
          if (reason) {
            return reason;
          }
        }

        if (cmd === "git") {
          const gitTokens = ["git", ...stripped.slice(i + 1)];
          const reason = analyzeGit(gitTokens);
          if (reason) {
            return reason;
          }
        }

        if (cmd === "find") {
          const findTokens = ["find", ...stripped.slice(i + 1)];
          const reason = analyzeFind(findTokens);
          if (reason) {
            return reason;
          }
        }
      }
    }
  }

  return null;
}

function hasDynamicCommandHead(tokens: readonly string[]): boolean {
  let commandIndex = commandTokenIndex(tokens);

  let commandToken = tokens[commandIndex];
  let wrapper = commandToken ? normalizeCommandToken(commandToken) : "";
  while (commandToken && COMMAND_EXECUTION_WRAPPERS.has(wrapper)) {
    commandIndex++;
    while (tokens[commandIndex]?.startsWith("-")) {
      if (wrapper === "exec" && tokens[commandIndex] === "-a") {
        commandIndex += 2;
      } else {
        commandIndex++;
      }
    }
    commandToken = tokens[commandIndex];
    wrapper = commandToken ? normalizeCommandToken(commandToken) : "";
  }

  return commandToken?.includes("$") ?? false;
}

function commandTokenIndex(tokens: readonly string[]): number {
  let commandIndex = 0;
  while (COMMAND_PREFIX_KEYWORDS.has(tokens[commandIndex] ?? "")) commandIndex++;
  return commandIndex;
}

function hasDynamicNestedExecutable(tokens: readonly string[]): boolean {
  const executableTokens = tokens.slice(commandTokenIndex(tokens));
  const head = normalizeCommandToken(executableTokens[0] ?? "");

  if (COMMAND_EXECUTION_WRAPPERS.has(head)) {
    // Wrapper option grammars differ and can themselves consume values. Once a
    // wrapper contains expansion, conservatively assume it can select a command.
    return executableTokens.slice(1).some((token) => token.includes("$"));
  }

  if (head === "xargs" || head === "parallel") {
    return tokens.slice(1).some((token) => token.includes("$"));
  }

  if (head === "find") {
    for (let i = 1; i < tokens.length; i++) {
      if (tokens[i] === "-exec" || tokens[i] === "-execdir") {
        return tokens[i + 1]?.includes("$") ?? false;
      }
    }
  }

  if (head === "case") {
    const inIndex = tokens.indexOf("in");
    return inIndex >= 0 && tokens.slice(inIndex + 1).some((token) => token.includes("$"));
  }

  if (head === "eval" || head === "source" || head === ".") {
    return tokens.slice(1).some((token) => token.includes("$"));
  }

  return false;
}

function unwrapStaticExecutionWrapper(tokens: readonly string[]): string[] | null {
  const wrapper = normalizeCommandToken(tokens[0] ?? "");

  if (wrapper === "builtin") {
    if (tokens[1] === "--") return tokens.slice(2);
    return tokens[1]?.startsWith("-") ? null : tokens.slice(1);
  }

  if (wrapper === "chrt") {
    return unwrapChrt(tokens);
  }

  if (wrapper === "exec") {
    let i = 1;
    while (i < tokens.length) {
      const token = tokens[i];
      if (token === "--") return tokens.slice(i + 1);
      if (token === "-a") {
        if (!tokens[i + 1]) return null;
        i += 2;
      } else if (token && /^-[cl]+$/u.test(token)) {
        i++;
      } else if (token?.startsWith("-")) {
        return null;
      } else {
        break;
      }
    }
    return tokens.slice(i);
  }

  if (wrapper === "ionice") {
    return unwrapIonice(tokens);
  }

  if (wrapper === "nice") {
    let i = 1;
    while (i < tokens.length) {
      const token = tokens[i];
      if (token === "-n" || token === "--adjustment") {
        if (!tokens[i + 1]) return null;
        i += 2;
      } else if (
        token?.startsWith("--adjustment=") ||
        /^-n.+$/u.test(token ?? "") ||
        /^-\d+$/u.test(token ?? "")
      ) {
        i++;
      } else if (token === "--") {
        return tokens.slice(i + 1);
      } else if (token?.startsWith("-")) {
        return null;
      } else {
        break;
      }
    }
    return tokens.slice(i);
  }

  if (wrapper === "nohup") {
    if (tokens[1] === "--") return tokens.slice(2);
    if (tokens[1] === "--help" || tokens[1] === "--version") return [];
    return tokens[1]?.startsWith("-") ? null : tokens.slice(1);
  }

  if (wrapper === "setsid") {
    let i = 1;
    while (i < tokens.length) {
      const token = tokens[i];
      if (token === "--") return tokens.slice(i + 1);
      if (token === "-h" || token === "--help" || token === "-V" || token === "--version") {
        return [];
      }
      if (
        token === "--ctty" ||
        token === "--fork" ||
        token === "--wait" ||
        (token !== undefined && /^-[cfw]+$/u.test(token))
      ) {
        i++;
      } else if (token?.startsWith("-")) {
        return null;
      } else {
        break;
      }
    }
    return tokens.slice(i);
  }

  if (wrapper === "stdbuf") {
    let i = 1;
    while (i < tokens.length) {
      const token = tokens[i];
      if (token === "--") return tokens.slice(i + 1);
      if (token === "--help" || token === "--version") return [];
      if (["-i", "-o", "-e", "--input", "--output", "--error"].includes(token ?? "")) {
        if (!tokens[i + 1]) return null;
        i += 2;
      } else if (
        token?.startsWith("--input=") ||
        token?.startsWith("--output=") ||
        token?.startsWith("--error=") ||
        /^-[ioe].+$/u.test(token ?? "")
      ) {
        i++;
      } else if (token?.startsWith("-")) {
        return null;
      } else {
        break;
      }
    }
    return tokens.slice(i);
  }

  if (wrapper === "time") {
    let i = 1;
    while (i < tokens.length) {
      const token = tokens[i];
      if (token === "--") return tokens.slice(i + 1);
      if (token === "--help" || token === "--version") return [];
      if (token === "-f" || token === "--format" || token === "-o" || token === "--output") {
        if (!tokens[i + 1]) return null;
        i += 2;
      } else if (
        token?.startsWith("--format=") ||
        token?.startsWith("--output=") ||
        /^-[fo].+$/u.test(token ?? "") ||
        /^-[apqv]+$/u.test(token ?? "")
      ) {
        i++;
      } else if (token?.startsWith("-")) {
        return null;
      } else {
        break;
      }
    }
    return tokens.slice(i);
  }

  if (wrapper === "timeout") {
    let i = 1;
    while (i < tokens.length) {
      const token = tokens[i];
      if (token === "-k" || token === "--kill-after" || token === "-s" || token === "--signal") {
        if (!tokens[i + 1]) return null;
        i += 2;
      } else if (
        token?.startsWith("--kill-after=") ||
        token?.startsWith("--signal=") ||
        /^-[ks].+$/u.test(token ?? "")
      ) {
        i++;
      } else if (token === "--") {
        i++;
        break;
      } else if (
        token === "--foreground" ||
        token === "--preserve-status" ||
        token === "--verbose"
      ) {
        i++;
      } else if (token === "--help" || token === "--version") {
        return [];
      } else if (token?.startsWith("-")) {
        return null;
      } else {
        break;
      }
    }
    if (!tokens[i]) return null;
    return tokens.slice(i + 1);
  }

  return null;
}

function unwrapIonice(tokens: readonly string[]): string[] | null {
  let i = 1;
  while (i < tokens.length) {
    const token = tokens[i];
    if (token === "--") return tokens.slice(i + 1);
    if (token === "-h" || token === "--help" || token === "-V" || token === "--version") {
      return [];
    }
    if (token === "-t" || token === "--ignore") {
      i++;
    } else if (
      ["-c", "--class", "-n", "--classdata", "-p", "--pid", "-P", "--pgid", "-u", "--uid"].includes(
        token ?? "",
      )
    ) {
      if (!tokens[i + 1]) return null;
      i += 2;
    } else if (
      token?.startsWith("--class=") ||
      token?.startsWith("--classdata=") ||
      token?.startsWith("--pid=") ||
      token?.startsWith("--pgid=") ||
      token?.startsWith("--uid=") ||
      /^-[cnpPu].+$/u.test(token ?? "")
    ) {
      i++;
    } else if (token?.startsWith("-")) {
      return null;
    } else {
      break;
    }
  }
  return tokens.slice(i);
}

function unwrapChrt(tokens: readonly string[]): string[] | null {
  let i = 1;
  let processMode = false;
  while (i < tokens.length) {
    const token = tokens[i];
    if (token === "--") {
      i++;
      break;
    }
    if (token === "-h" || token === "--help" || token === "-V" || token === "--version") {
      return [];
    }
    if (token === "-p" || token === "--pid") {
      processMode = true;
      i++;
    } else if (
      [
        "-a",
        "--all-tasks",
        "-m",
        "--max",
        "-v",
        "--verbose",
        "-b",
        "--batch",
        "-d",
        "--deadline",
        "-f",
        "--fifo",
        "-i",
        "--idle",
        "-o",
        "--other",
        "-r",
        "--rr",
        "-R",
        "--reset-on-fork",
      ].includes(token ?? "")
    ) {
      i++;
    } else if (
      ["-T", "--sched-runtime", "-P", "--sched-period", "-D", "--sched-deadline"].includes(
        token ?? "",
      )
    ) {
      if (!tokens[i + 1]) return null;
      i += 2;
    } else if (
      token?.startsWith("--sched-runtime=") ||
      token?.startsWith("--sched-period=") ||
      token?.startsWith("--sched-deadline=") ||
      /^-[TPD].+$/u.test(token ?? "")
    ) {
      i++;
    } else if (token?.startsWith("-")) {
      return null;
    } else {
      break;
    }
  }

  if (processMode) return [];
  if (!tokens[i] || !tokens[i + 1]) return null;
  return tokens.slice(i + 1);
}

const CWD_CHANGE_REGEX =
  /^\s*(?:\$\(\s*)?[({]*\s*(?:command\s+|builtin\s+)?(?:cd|pushd|popd)(?:\s|$)/;

export function segmentChangesCwd(segment: readonly string[]): boolean {
  const stripped = stripLeadingGrouping(segment);
  const unwrapped = stripWrappers([...stripped]);

  if (unwrapped.length === 0) {
    return false;
  }

  let head = unwrapped[0] ?? "";
  if (head === "builtin" && unwrapped.length > 1) {
    head = unwrapped[1] ?? "";
  }

  if (head === "cd" || head === "pushd" || head === "popd") {
    return true;
  }

  const joined = segment.join(" ");
  return CWD_CHANGE_REGEX.test(joined);
}

function stripLeadingGrouping(tokens: readonly string[]): readonly string[] {
  let i = 0;
  while (i < tokens.length) {
    const token = tokens[i];
    if (token === "{" || token === "(" || token === "$(") {
      i++;
    } else {
      break;
    }
  }
  return tokens.slice(i);
}
