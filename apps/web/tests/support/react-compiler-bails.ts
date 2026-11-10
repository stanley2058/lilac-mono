import { transformAsync } from "@babel/core";
import { Glob } from "bun";
import path from "node:path";

export type CompilerBail = {
  file: string;
  /** The skipped function's name, or `anonymous` when the source gives it none. */
  name: string;
  /** Where the skipped function starts, which tells apart functions that share a name. */
  start?: number;
  reason: string;
  line?: number;
};

type CompilerEvent = {
  kind: string;
  fnName?: string | null;
  fnLoc?: { start?: { line?: number; index?: number } } | null;
  detail?: {
    reason?: string;
    loc?: { start?: { line?: number } } | null;
    options?: { reason?: string; details?: { loc?: { start?: { line?: number } } }[] };
  };
};

function bailLine(event: CompilerEvent): number | undefined {
  const detail = event.detail;
  return (
    detail?.loc?.start?.line ??
    detail?.options?.details?.find((item) => item.loc?.start?.line)?.loc?.start?.line ??
    event.fnLoc?.start?.line
  );
}

/** The compiler's events leave `fnName` empty, so the name comes from the source at the function. */
function functionName(code: string, start: number | undefined): string {
  if (start === undefined) return "anonymous";
  const declared = /^(?:export\s+(?:default\s+)?)?(?:async\s+)?function\s*\*?\s*([\w$]+)/.exec(
    code.slice(start, start + 200),
  );
  if (declared) return declared[1]!;
  const lineStart = code.lastIndexOf("\n", start - 1) + 1;
  const assigned = /([\w$]+)\s*(?::[^=]*)?=\s*(?:[\w$.]+\()?\s*$/.exec(
    code.slice(lineStart, start),
  );
  return assigned?.[1] ?? "anonymous";
}

/**
 * One entry per skipped function and reason. A function can report the same reason more than once,
 * while each further function that bails for an already-listed reason adds an entry.
 */
export function bailEntries(bails: readonly CompilerBail[]): string[] {
  const entries = new Map<string, string>();
  for (const bail of bails)
    entries.set(
      JSON.stringify([bail.file, bail.start, bail.reason]),
      `${bail.file}: ${bail.name}: ${bail.reason}`,
    );
  return [...entries.values()].sort();
}

/** A function opts out with a `"use no memo"` directive right after its parameter list. */
function optedOut(lines: readonly string[], start: number | undefined): boolean {
  if (start === undefined) return false;
  const bodyStart = lines.findIndex(
    (line, index) => index >= start - 1 && /\)(:[^=]*)? \{$/.test(line.trimEnd()),
  );
  if (bodyStart < 0) return false;
  return lines.slice(bodyStart + 1, bodyStart + 4).some((line) => line.includes('"use no memo"'));
}

/**
 * Runs the React Compiler over `src` with the build's options and lists each function it skipped,
 * except functions that opt out explicitly.
 */
export async function reactCompilerBails(root: string): Promise<CompilerBail[]> {
  const bails: CompilerBail[] = [];
  for await (const file of new Glob("src/**/*.{ts,tsx}").scan(root)) {
    if (file.includes("/generated/")) continue;
    const code = await Bun.file(path.join(root, file)).text();
    const lines = code.split("\n");
    await transformAsync(code, {
      filename: path.join(root, file),
      babelrc: false,
      configFile: false,
      parserOpts: { plugins: file.endsWith(".tsx") ? ["typescript", "jsx"] : ["typescript"] },
      plugins: [
        [
          "babel-plugin-react-compiler",
          {
            logger: {
              logEvent(_filename: string, event: CompilerEvent) {
                if (event.kind !== "CompileError" && event.kind !== "PipelineError") return;
                if (optedOut(lines, event.fnLoc?.start?.line)) return;
                const reason = event.detail?.reason ?? event.detail?.options?.reason ?? "";
                const start = event.fnLoc?.start?.index;
                bails.push({
                  file,
                  name: functionName(code, start),
                  start,
                  reason: reason.split("\n")[0]!,
                  line: bailLine(event),
                });
              },
            },
          },
        ],
      ],
    });
  }
  return bails;
}

if (import.meta.main) console.log(JSON.stringify(await reactCompilerBails(process.argv[2]!)));
