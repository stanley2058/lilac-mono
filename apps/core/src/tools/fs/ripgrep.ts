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

export async function ripgrep(options: GrepOptions): Promise<GrepMatch[]> {
  const {
    cwd,
    pattern,
    globs = [],
    extraArgs = [],
    regex = false,
    maxMatches = 200,
  } = options;

  return new Promise<GrepMatch[]>((resolve, reject) => {
    const args: string[] = [
      "--json",
      "--color",
      "never",
      "--max-count",
      String(maxMatches),
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

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      const lines = chunk.split("\n").filter(Boolean);
      for (const line of lines) {
        try {
          const event = JSON.parse(line);
          if (event.type === "match") {
            const data = event.data as {
              path: { text: string };
              lines: { text: string };
              line_number: number;
              absolute_offset: number;
              submatches: [
                {
                  match: { text: string };
                  start: number;
                  end: number;
                },
              ];
            };
            const path = data.path?.text;
            if (!path) continue;

            const lineNumber = data.line_number;
            const text = data.lines?.text ?? "";
            const column = (data.submatches?.[0]?.start ?? 0) + 1;

            matches.push({
              file: path,
              line: lineNumber,
              column,
              text,
              submatches: data.submatches?.map((m: any) => ({
                match: m.match.text,
                start: m.start,
                end: m.end,
              })),
            });
          }
        } catch {
          // ignore JSON parse errors from partial lines
        }
      }
    });

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (c: string) => {
      stderrBuf += c;
    });

    child.on("error", (err) => reject(err));

    child.on("close", (code) => {
      if (code === 0 || code === 1) {
        // 0 = matches, 1 = no matches
        resolve(matches);
      } else {
        reject(new Error(`rg exited with code ${code}: ${stderrBuf}`));
      }
    });
  });
}
