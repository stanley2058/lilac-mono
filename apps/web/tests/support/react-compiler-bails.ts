import { Glob } from "bun";
import path from "node:path";
import { transformSync } from "oxc-transform-react";
import { parseSync } from "vite";

export type CompilerBail = {
  file: string;
  /** The skipped function's name, or `anonymous` when the source gives it none. */
  name: string;
  /** Where the skipped function starts, which tells apart functions that share a name. */
  start: number;
  reason: string;
  line: number;
};

type Node = { type: string; start: number; end: number; [key: string]: unknown };

type CompiledFunction = { name: string; start: number; end: number; optedOut: boolean };

const functionTypes = new Set([
  "FunctionDeclaration",
  "FunctionExpression",
  "ArrowFunctionExpression",
]);

function isNode(value: unknown): value is Node {
  return typeof value === "object" && value !== null && typeof (value as Node).type === "string";
}

function children(node: Node): Node[] {
  return Object.values(node).flatMap((value) =>
    Array.isArray(value) ? value.filter(isNode) : isNode(value) ? [value] : [],
  );
}

function optedOut(fn: Node): boolean {
  const body = fn.body as Node | undefined;
  if (body?.type !== "BlockStatement") return false;
  return (body.body as Node[]).some(
    (statement) => statement.directive === "use no memo" || statement.directive === "use no forget",
  );
}

/**
 * The outermost functions in a module, which are the ones the compiler compiles. A nested callback
 * belongs to its enclosing component or hook, so its diagnostics count against that function.
 */
function outermostFunctions(node: Node, name?: string): CompiledFunction[] {
  if (functionTypes.has(node.type)) {
    const id = node.id as { name?: string } | null | undefined;
    const fnName = id?.name ?? name ?? "anonymous";
    return [{ name: fnName, start: node.start, end: node.end, optedOut: optedOut(node) }];
  }
  const id = node.type === "VariableDeclarator" ? (node.id as { name?: string }).name : undefined;
  return children(node).flatMap((child) => outermostFunctions(child, id ?? name));
}

/** Oxc labels diagnostics with UTF-8 byte offsets, while the parser reports UTF-16 positions. */
function utf16Offset(bytes: Buffer, byteOffset: number): number {
  return bytes.subarray(0, byteOffset).toString().length;
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

/**
 * Runs the React Compiler over `src` with the build's options and lists each function it skipped,
 * except functions that opt out explicitly.
 */
export async function reactCompilerBails(root: string): Promise<CompilerBail[]> {
  const bails: CompilerBail[] = [];
  for await (const file of new Glob("src/**/*.{ts,tsx}").scan(root)) {
    if (file.includes("/generated/")) continue;
    const filename = path.join(root, file);
    const code = await Bun.file(filename).text();
    const result = transformSync(filename, code, { jsx: "preserve", reactCompiler: {} });
    if (result.errors.length === 0) continue;
    const bytes = Buffer.from(code);
    const functions = outermostFunctions(parseSync(filename, code).program as unknown as Node);
    for (const error of result.errors) {
      const at = utf16Offset(bytes, error.labels[0]?.start ?? 0);
      const fn = functions.find((item) => item.start <= at && at < item.end);
      if (fn?.optedOut) continue;
      bails.push({
        file,
        name: fn?.name ?? "anonymous",
        start: fn?.start ?? -1,
        reason: error.message.split("\n")[0]!,
        line: code.slice(0, at).split("\n").length,
      });
    }
  }
  return bails;
}
