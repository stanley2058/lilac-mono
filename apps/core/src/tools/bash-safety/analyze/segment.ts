import {
  type AnalyzeOptions,
  INTERPRETERS,
  PARANOID_INTERPRETERS_SUFFIX,
  SHELL_WRAPPERS,
} from "../types";
import { isAbsolute, resolve } from "node:path";

import { analyzeGit } from "../rules-git";
import { analyzeRm } from "../rules-rm";
import {
  DYNAMIC_EXPANSION_MARKER,
  GLOB_EXPANSION_MARKER,
  getBasename,
  hasDynamicExpansion,
  normalizeCommandToken,
  stripExpansionMarkers,
  stripEnvAssignmentsWithInfo,
  stripWrappersWithInfo,
} from "../shell";

import { analyzeFind } from "./find";
import { extractInterpreterCodeArg } from "./interpreters";
import { analyzeParallel } from "./parallel";
import { hasRecursiveForceFlags } from "./rm-flags";
import { extractDashCArg } from "./shell-wrappers";
import { isTmpdirOverriddenToNonTemp } from "./tmpdir";
import { analyzeXargs } from "./xargs";

const REASON_INTERPRETER_BLOCKED = "Interpreter one-liners are blocked in paranoid mode.";
const REASON_DYNAMIC_RM_TARGET =
  "rm -rf with a dynamic target is blocked because the deletion scope cannot be verified.";

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
export const COMMAND_EXECUTION_WRAPPERS = new Set([
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
const SENSITIVE_PATH_CONSUMERS = new Set([
  ".",
  "ack",
  "ag",
  "awk",
  "base64",
  "bash",
  "cat",
  "chmod",
  "chown",
  "cmp",
  "cp",
  "curl",
  "dd",
  "diff",
  "du",
  "file",
  "find",
  "git",
  "gpg",
  "grep",
  "head",
  "hexdump",
  "install",
  "less",
  "ln",
  "ls",
  "md5sum",
  "more",
  "mv",
  "od",
  "openssl",
  "perl",
  "python",
  "python2",
  "python3",
  "readlink",
  "realpath",
  "rg",
  "rm",
  "rsync",
  "ruby",
  "scp",
  "sed",
  "sha256sum",
  "source",
  "ssh",
  "ssh-add",
  "ssh-keygen",
  "stat",
  "strings",
  "sftp",
  "tail",
  "tar",
  "tee",
  "touch",
  "tree",
  "truncate",
  "unzip",
  "wget",
  "wc",
  "xxd",
  "zip",
]);

export type SegmentAnalyzeOptions = AnalyzeOptions & {
  effectiveCwd: string | null | undefined;
  analyzeNested: (command: string, effectiveCwd?: string | null | undefined) => string | null;
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
  const wrapperResult = stripWrappersWithInfo(strippedEnv);
  const stripped = wrapperResult.tokens;
  const wrapperEnvAssignments = wrapperResult.envAssignments;
  const commandEffectiveCwd = resolveChildCwd(
    options.effectiveCwd,
    options.cwd,
    wrapperResult.childCwd,
    wrapperResult.childCwdUnknown,
  );

  const envAssignments = new Map(leadingEnvAssignments);
  for (const [k, v] of wrapperEnvAssignments) {
    envAssignments.set(k, v);
  }

  if (stripped.length === 0) {
    return null;
  }

  if (wrapperResult.commandLookupOnly) {
    return analyzeSensitiveTokens(stripped.map(stripExpansionMarkers));
  }

  if (hasDynamicCommandHead(stripped)) {
    return null;
  }

  const commandIndex = commandTokenIndex(stripped);
  const staticTokens = stripped.map(stripExpansionMarkers);
  const staticCommandIndex = commandTokenIndex(staticTokens);
  const executableTokens = stripped.slice(commandIndex);
  const normalizedExecutable = normalizeCommandToken(
    stripExpansionMarkers(executableTokens[0] ?? ""),
  );
  if (COMMAND_EXECUTION_WRAPPERS.has(normalizedExecutable)) {
    const wrappedCommand = unwrapStaticExecutionWrapper(executableTokens);
    if (!wrappedCommand) {
      return null;
    }
    if (wrappedCommand.length === 0) {
      return null;
    }
    return analyzeSegment(wrappedCommand, { ...options, effectiveCwd: commandEffectiveCwd });
  }

  const head = staticTokens[0];
  if (!head) {
    return null;
  }

  const normalizedHead = normalizeCommandToken(staticTokens[staticCommandIndex] ?? head);
  const basename = getBasename(head);

  if (SENSITIVE_PATH_CONSUMERS.has(normalizedHead)) {
    const sensitiveReason = analyzeSensitiveTokens(staticTokens);
    if (sensitiveReason) return sensitiveReason;
  }

  const { cwdForRm, originalCwd } = deriveCwdContext({
    cwd: options.cwd,
    effectiveCwd: commandEffectiveCwd,
  });

  const allowTmpdirVar =
    (options.allowTmpdirVar ?? true) && !isTmpdirOverriddenToNonTemp(envAssignments);

  if (SHELL_WRAPPERS.has(normalizedHead)) {
    const dashCArg = extractDashCArg(stripped);
    if (dashCArg) {
      return options.analyzeNested(dashCArg, commandEffectiveCwd);
    }
  }

  if (normalizedHead === "eval") {
    const payload = stripped.slice(commandIndex + 1).join(" ");
    return payload ? options.analyzeNested(payload, commandEffectiveCwd) : null;
  }

  if (normalizedHead === "trap") {
    const action = extractTrapAction(stripped.slice(commandIndex + 1));
    if (action?.payload && !action.dynamic) {
      return options.analyzeNested(action.payload, commandEffectiveCwd);
    }
  }

  if (normalizedHead === "mapfile" || normalizedHead === "readarray") {
    const callback = extractMapfileCallback(stripped.slice(commandIndex + 1));
    if (callback?.payload && !callback.dynamic) {
      return options.analyzeNested(callback.payload, commandEffectiveCwd);
    }
  }

  if (normalizedHead === "compgen") {
    const command = extractCompgenCommand(stripped.slice(commandIndex + 1));
    if (command?.payload && !command.dynamic) {
      return options.analyzeNested(command.payload, commandEffectiveCwd);
    }
  }

  if (INTERPRETERS.has(normalizedHead)) {
    const codeArg = extractInterpreterCodeArg(staticTokens);
    if (codeArg) {
      if (options.paranoidInterpreters) {
        return REASON_INTERPRETER_BLOCKED + PARANOID_INTERPRETERS_SUFFIX;
      }
    }
  }

  if (normalizedHead === "busybox" && stripped.length > 1) {
    return analyzeSegment(stripped.slice(1), { ...options, effectiveCwd: commandEffectiveCwd });
  }

  const isGit = basename.toLowerCase() === "git";
  const isRm = basename === "rm";
  const isFind = basename === "find";
  const isXargs = basename === "xargs";
  const isParallel = basename === "parallel";

  if (isGit) {
    const gitResult = analyzeGit(staticTokens);
    if (gitResult) {
      return gitResult;
    }
  }

  if (isRm) {
    if (
      hasRecursiveForceFlags(staticTokens) &&
      hasDynamicRmTarget(stripped.slice(commandIndex + 1))
    ) {
      return REASON_DYNAMIC_RM_TARGET;
    }

    const rmResult = analyzeRm(staticTokens, {
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
    const findResult = analyzeFind(stripped, {
      analyzeCommand: (command, cwdUnknown) =>
        analyzeSegment(
          command.map((token) => token.replaceAll("{}", DYNAMIC_EXPANSION_MARKER)),
          {
            ...options,
            effectiveCwd: cwdUnknown ? null : commandEffectiveCwd,
          },
        ),
    });
    if (findResult) {
      return findResult;
    }
  }

  if (isXargs) {
    const xargsResult = analyzeXargs(stripped, {
      analyzeCommand: (command) =>
        analyzeSegment(command, {
          ...options,
          effectiveCwd: commandEffectiveCwd,
        }),
    });

    if (xargsResult) {
      return xargsResult;
    }
  }

  if (isParallel) {
    const parallelResult = analyzeParallel(stripped, {
      analyzeNested: options.analyzeNested,
      analyzeCommand: (command) =>
        analyzeSegment(command, {
          ...options,
          effectiveCwd: commandEffectiveCwd,
        }),
    });

    if (parallelResult) {
      return parallelResult;
    }
  }

  return null;
}

function hasDynamicRmTarget(tokens: readonly string[]): boolean {
  let pastDoubleDash = false;
  for (const token of tokens) {
    if (token === "--") {
      pastDoubleDash = true;
      continue;
    }
    if (!hasDynamicExpansion(token.replaceAll(GLOB_EXPANSION_MARKER, ""))) continue;
    const markerIndex = token.indexOf(DYNAMIC_EXPANSION_MARKER);
    const staticPrefix = markerIndex < 0 ? token : token.slice(0, markerIndex);
    if (pastDoubleDash || !staticPrefix.startsWith("-")) return true;
  }
  return false;
}

function resolveChildCwd(
  effectiveCwd: string | null | undefined,
  originalCwd: string | undefined,
  childCwd: string | undefined,
  childCwdUnknown: boolean,
): string | null | undefined {
  if (childCwdUnknown) return null;
  if (childCwd === undefined) return effectiveCwd;
  if (childCwd.startsWith("~")) return null;
  if (isAbsolute(childCwd)) return resolve(childCwd);
  const base = effectiveCwd ?? originalCwd;
  return base ? resolve(base, childCwd) : null;
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

  return commandToken ? hasDynamicExpansion(commandToken) : false;
}

function commandTokenIndex(tokens: readonly string[]): number {
  let commandIndex = 0;
  while (COMMAND_PREFIX_KEYWORDS.has(tokens[commandIndex] ?? "")) commandIndex++;
  return commandIndex;
}

interface EvaluatorPayload {
  payload: string;
  dynamic: boolean;
}

function extractTrapAction(tokens: readonly string[]): EvaluatorPayload | null {
  let i = 0;
  while (tokens[i] === "-l" || tokens[i] === "-p") i++;
  if (tokens[i] === "--") i++;
  const action = tokens[i];
  if (!action || action === "-") return null;
  return {
    payload: stripExpansionMarkers(action),
    dynamic: hasDynamicExpansion(action),
  };
}

function extractMapfileCallback(tokens: readonly string[]): EvaluatorPayload | null {
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === "-C" || token === "--callback") {
      const callback = tokens[i + 1];
      if (!callback) return { payload: "", dynamic: true };
      return {
        payload: stripExpansionMarkers(callback),
        dynamic: hasDynamicExpansion(callback),
      };
    }
    if (token?.startsWith("-C") && token.length > 2) {
      return {
        payload: stripExpansionMarkers(token.slice(2)),
        dynamic: hasDynamicExpansion(token),
      };
    }
    if (token?.startsWith("--callback=")) {
      return {
        payload: stripExpansionMarkers(token.slice("--callback=".length)),
        dynamic: hasDynamicExpansion(token),
      };
    }
  }
  return null;
}

function extractCompgenCommand(tokens: readonly string[]): EvaluatorPayload | null {
  let result: EvaluatorPayload | null = null;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (!token || token === "--" || !token.startsWith("-")) break;
    if (token.startsWith("--")) continue;
    const commandOptionIndex = token.indexOf("C", 1);
    if (commandOptionIndex < 0) continue;

    const attached = token.slice(commandOptionIndex + 1);
    const command = attached || tokens[i + 1];
    if (!command) continue;
    if (!attached) i++;
    result = {
      payload: stripExpansionMarkers(command),
      dynamic: hasDynamicExpansion(command),
    };
  }
  return result;
}

export function unwrapStaticExecutionWrapper(tokens: readonly string[]): string[] | null {
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
    const groupedValueOption = token?.match(/^-[abdefimopRrv]*([TPD])(.*)$/u);
    if (groupedValueOption) {
      if (token?.includes("p")) processMode = true;
      if (!groupedValueOption[2] && !tokens[i + 1]) return null;
      i += groupedValueOption[2] ? 1 : 2;
    } else if (token !== undefined && /^-[abdefimopRrv]+$/u.test(token)) {
      if (token.includes("p")) processMode = true;
      i++;
    } else if (token === "-p" || token === "--pid") {
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
        "-e",
        "--ext",
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
  const firstPositional = tokens[i];
  if (!firstPositional) return null;
  if (/^[+-]?\d+$/u.test(firstPositional)) {
    return tokens[i + 1] ? tokens.slice(i + 1) : null;
  }
  return tokens.slice(i);
}

export function analyzeSensitiveTokens(tokens: readonly string[]): string | null {
  for (const token of tokens) {
    if (!token) continue;
    for (const { re, reason } of SENSITIVE_TOKEN_PATTERNS) {
      if (re.test(token)) return reason;
    }
  }
  return null;
}
