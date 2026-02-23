/* from @stanley2058/tool-eval */
import { spawn } from "node:child_process";
import { z } from "zod";

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

const ripgrepSubmatchSchema = z.object({
  match: z.object({ text: z.string() }),
  start: z.number(),
  end: z.number(),
});

const ripgrepMatchEventSchema = z.object({
  type: z.literal("match"),
  data: z.object({
    path: z.object({ text: z.string().min(1) }),
    line_number: z.number(),
    lines: z
      .object({
        text: z.string(),
      })
      .optional(),
    submatches: z.array(ripgrepSubmatchSchema).optional().default([]),
  }),
});

function parseMatchEvent(event: unknown): GrepMatch | null {
  const parsed = ripgrepMatchEventSchema.safeParse(event);
  if (!parsed.success) return null;

  const data = parsed.data.data;
  const file = data.path.text;
  const lineValue = data.line_number;
  const text = data.lines?.text ?? "";
  const submatches = data.submatches.map((item) => ({
    match: item.match.text,
    start: item.start,
    end: item.end,
  }));

  return {
    file,
    line: lineValue,
    column: (submatches[0]?.start ?? 0) + 1,
    text,
    ...(submatches.length > 0 ? { submatches } : {}),
  };
}

export async function ripgrep(options: GrepOptions): Promise<RipgrepResult> {
  const { cwd, pattern, globs = [], extraArgs = [], regex = false, maxMatches = 200 } = options;
  const limit = Math.max(1, maxMatches);

  return new Promise<RipgrepResult>((resolve, reject) => {
    const args: string[] = ["--json", "--color", "never", ...extraArgs];

    // Per-file cap as a best-effort optimization. Global cap is still enforced below.
    args.push("--max-count", String(limit + 1));

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
    let forceKillTimer: ReturnType<typeof setTimeout> | undefined;

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

      try {
        child.kill("SIGTERM");
      } catch {
        // ignore
      }

      forceKillTimer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          // ignore
        }
      }, 300);

      // Stop parsing buffered output once we know we have N+1.
      try {
        child.stdout.destroy();
      } catch {
        // ignore
      }
    };

    const processLine = (line: string) => {
      if (reachedLimit) return;
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
      if (reachedLimit) return;

      stdoutRemainder += chunk;
      while (!reachedLimit) {
        const newlineIndex = stdoutRemainder.indexOf("\n");
        if (newlineIndex === -1) break;
        const line = stdoutRemainder.slice(0, newlineIndex);
        stdoutRemainder = stdoutRemainder.slice(newlineIndex + 1);
        processLine(line);
      }

      if (reachedLimit) {
        stdoutRemainder = "";
      }
    });

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (c: string) => {
      stderrBuf += c;
    });

    child.on("error", (err) => {
      if (reachedLimit) return;
      settleReject(err);
    });

    child.on("close", (code, signal) => {
      if (forceKillTimer) {
        clearTimeout(forceKillTimer);
        forceKillTimer = undefined;
      }

      if (!reachedLimit && stdoutRemainder.length > 0) {
        processLine(stdoutRemainder);
        stdoutRemainder = "";
      }

      const exitedNormally = code === 0 || code === 1;
      const exitedAtLimit = reachedLimit && (signal === "SIGTERM" || signal === "SIGKILL");

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
