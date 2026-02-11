/* from @stanley2058/tool-eval */
import { spawn } from "node:child_process";

export type GrepMatch = {
  file: string;
  line: number;
  column: number;
  text: string;
  submatches?: {
    match: string;
    start: number;
    end: number;
  }[];
};

export type GrepOptions = {
  /**
   * Root directory for the search
   */
  cwd: string;
  /**
   * The pattern to search for (literal by default)
   */
  pattern: string;
  /**
   * File globs (e.g. ["src/\*\*\/*.ts"])
   */
  globs?: string[];
  /**
   * Extra ripgrep args
   */
  extraArgs?: string[];
  /**
   * If true, treat pattern as regex, otherwise literal
   */
  regex?: boolean;
  /**
   * Limit number of matches (guardrail)
   */
  maxMatches?: number;
};

export type RipgrepResult = {
  matches: GrepMatch[];
  truncated: boolean;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseMatchEvent(event: unknown): GrepMatch | null {
  if (!isRecord(event)) return null;
  if (event["type"] !== "match") return null;

  const data = event["data"];
  if (!isRecord(data)) return null;

  const pathValue = data["path"];
  if (!isRecord(pathValue)) return null;
  const file = pathValue["text"];
  if (typeof file !== "string" || file.length === 0) return null;

  const lineValue = data["line_number"];
  if (typeof lineValue !== "number") return null;

  const linesValue = data["lines"];
  const text =
    isRecord(linesValue) && typeof linesValue["text"] === "string"
      ? linesValue["text"]
      : "";

  const rawSubmatches = data["submatches"];
  const submatches = Array.isArray(rawSubmatches)
    ? rawSubmatches
        .map((item) => {
          if (!isRecord(item)) return null;
          const matchValue = item["match"];
          if (!isRecord(matchValue)) return null;
          const matchText = matchValue["text"];
          const start = item["start"];
          const end = item["end"];
          if (
            typeof matchText !== "string" ||
            typeof start !== "number" ||
            typeof end !== "number"
          ) {
            return null;
          }
          return {
            match: matchText,
            start,
            end,
          };
        })
        .filter((item): item is { match: string; start: number; end: number } =>
          item !== null,
        )
    : [];

  return {
    file,
    line: lineValue,
    column: (submatches[0]?.start ?? 0) + 1,
    text,
    ...(submatches.length > 0 ? { submatches } : {}),
  };
}

export async function ripgrep(options: GrepOptions): Promise<RipgrepResult> {
  const {
    cwd,
    pattern,
    globs = [],
    extraArgs = [],
    regex = false,
    maxMatches = 200,
  } = options;
  const limit = Math.max(1, maxMatches);

  return new Promise<RipgrepResult>((resolve, reject) => {
    const args: string[] = [
      "--json",
      "--color",
      "never",
      ...extraArgs,
    ];

    if (!regex) args.push("--fixed-strings");

    for (const glob of globs) args.push("--glob", glob);

    args.push(pattern);

    const child = spawn("rg", [...args, "."], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const matches: GrepMatch[] = [];
    let stderrBuf = "";
    let stdoutRemainder = "";
    let reachedLimit = false;
    let settled = false;

    const settleResolve = (value: RipgrepResult) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    const settleReject = (err: Error) => {
      if (settled) return;
      settled = true;
      reject(err);
    };

    const stopAtLimit = () => {
      if (reachedLimit) return;
      reachedLimit = true;
      child.kill("SIGTERM");
    };

    const processLine = (line: string) => {
      if (line.length === 0) return;
      if (matches.length > limit) {
        stopAtLimit();
        return;
      }

      try {
        const event = JSON.parse(line) as unknown;
        const parsed = parseMatchEvent(event);
        if (!parsed) return;
        matches.push(parsed);
        if (matches.length > limit) {
          stopAtLimit();
        }
      } catch {
        // ignore JSON parse errors from partial/non-event lines
      }
    };

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdoutRemainder += chunk;
      while (true) {
        const newlineIndex = stdoutRemainder.indexOf("\n");
        if (newlineIndex === -1) break;
        const line = stdoutRemainder.slice(0, newlineIndex);
        stdoutRemainder = stdoutRemainder.slice(newlineIndex + 1);
        processLine(line);
      }
    });

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (c: string) => {
      stderrBuf += c;
    });

    child.on("error", (err) => settleReject(err));

    child.on("close", (code, signal) => {
      if (stdoutRemainder.length > 0) {
        processLine(stdoutRemainder);
        stdoutRemainder = "";
      }

      const exitedNormally = code === 0 || code === 1;
      const exitedAtLimit = reachedLimit && signal === "SIGTERM";

      if (exitedNormally || exitedAtLimit) {
        const truncated = matches.length > limit;
        settleResolve({
          matches: truncated ? matches.slice(0, limit) : matches,
          truncated,
        });
        return;
      }

      settleReject(new Error(`rg exited with code ${code}: ${stderrBuf}`));
    });
  });
}
