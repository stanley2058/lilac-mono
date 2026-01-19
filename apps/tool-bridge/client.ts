import { encode } from "@toon-format/toon";
import fs from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";

declare global {
  // injected at build time in real releases
  // eslint-disable-next-line no-var
  var PACKAGE_VERSION: string;
}

globalThis.PACKAGE_VERSION = "dev";

const BACKEND_URL =
  process.env.TOOL_SERVER_BACKEND_URL || "http://localhost:8080";

type ToolOutputFull = {
  callableId: string;
  name: string;
  description: string;
  shortInput: string[];
  input: string[];
};

async function listTools() {
  const res = await fetch(`${BACKEND_URL}/list`);
  if (!res.ok) {
    throw new Error(`Failed to fetch tools list: ${res.statusText}`);
  }
  const json = await res.json();
  return json as {
    tools: Omit<ToolOutputFull, "input">[];
  };
}

async function toolHelp(callableId: string) {
  const res = await fetch(
    `${BACKEND_URL}/help/${encodeURIComponent(callableId)}`,
  );
  if (!res.ok) {
    throw new Error(`Failed to fetch tool help: ${res.statusText}`);
  }
  const json = await res.json();
  return json as ToolOutputFull;
}

async function callTool(callableId: string, input: Record<string, unknown>) {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  const requestId = process.env.LILAC_REQUEST_ID;
  const sessionId = process.env.LILAC_SESSION_ID;
  const requestClient = process.env.LILAC_REQUEST_CLIENT;
  const cwd = process.env.LILAC_CWD;

  if (requestId) headers["x-lilac-request-id"] = requestId;
  if (sessionId) headers["x-lilac-session-id"] = sessionId;
  if (requestClient) headers["x-lilac-request-client"] = requestClient;
  if (cwd) headers["x-lilac-cwd"] = cwd;

  const res = await fetch(`${BACKEND_URL}/call`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      callableId,
      input,
    }),
  });
  if (!res.ok) {
    throw new Error(`Failed to call tool: ${res.statusText}`);
  }
  const json = await res.json();
  return json as
    | {
        isError: true;
        output: string;
      }
    | {
        isError: false;
        output: unknown;
      };
}

const ANSI_RE = /\x1b\[[0-9;]*m/g;
function stripAnsi(input: string) {
  return input.replace(ANSI_RE, "");
}

function visibleLength(input: string) {
  return stripAnsi(input).length;
}

function padRight(input: string, width: number) {
  const pad = Math.max(0, width - visibleLength(input));
  return `${input}${" ".repeat(pad)}`;
}

function indentLines(lines: string[], spaces: number) {
  const pad = " ".repeat(spaces);
  return lines.map((l) => (l.length === 0 ? l : `${pad}${l}`));
}

function wrapText(text: string, width: number): string[] {
  const w = Math.max(10, width);

  const paragraphs = text
    .split("\n")
    .map((p) => p.trim())
    .filter(Boolean);

  if (paragraphs.length === 0) return [""];

  const out: string[] = [];

  for (const p of paragraphs) {
    const words = p.split(/\s+/g);
    let line = "";

    for (const word of words) {
      if (!line) {
        line = word;
        continue;
      }

      const next = `${line} ${word}`;
      if (next.length <= w) {
        line = next;
      } else {
        out.push(line);
        line = word;
      }
    }

    if (line) out.push(line);
    out.push("");
  }

  // drop trailing paragraph spacer
  if (out.length > 0 && out[out.length - 1] === "") out.pop();
  return out;
}

function termWidth() {
  // Keep a reasonable lower bound for wrapping.
  return Math.max(60, process.stdout.columns ?? 80);
}

function useColor() {
  if (!process.stdout.isTTY) return false;
  if (process.env.NO_COLOR !== undefined) return false;
  if (process.env.TERM === "dumb") return false;
  return true;
}

type StyleFn = (s: string) => string;
function createStyles(enabled: boolean) {
  const wrap =
    (open: string, close = "\x1b[0m") =>
    (s: string) =>
      enabled ? `${open}${s}${close}` : s;

  return {
    dim: wrap("\x1b[2m"),
    bold: wrap("\x1b[1m"),
    cyan: wrap("\x1b[36m"),
    yellow: wrap("\x1b[33m"),
    red: wrap("\x1b[31m"),
  } satisfies Record<string, StyleFn>;
}

const styles = createStyles(useColor());

function section(title: string, lines: string[]) {
  const hdr = styles.bold(title);
  const body = indentLines(lines, 2);
  return [hdr, ...body].join("\n");
}

function banner() {
  const name = styles.bold("tools");
  const version = styles.dim(`[version: ${PACKAGE_VERSION}]`);
  return `${name} - All-in-one tool proxy ${version}`;
}

function formatBullets(
  items: string[],
  opts?: { indent?: number; dim?: boolean },
) {
  const indent = opts?.indent ?? 0;
  const bulletPrefix = "- ";
  const width = termWidth();
  const available = Math.max(20, width - indent - bulletPrefix.length);

  const out: string[] = [];
  for (const item of items) {
    const wrapped = wrapText(item, available);
    out.push(`${" ".repeat(indent)}${bulletPrefix}${wrapped[0] ?? ""}`);
    for (const cont of wrapped.slice(1)) {
      out.push(`${" ".repeat(indent + bulletPrefix.length)}${cont}`);
    }
  }

  if (opts?.dim) return out.map((l) => styles.dim(l));
  return out;
}

function formatToolBlock(
  tool: ToolOutputFull | Omit<ToolOutputFull, "input">,
  opts: { idWidth: number; showArgs: boolean },
) {
  const width = termWidth();
  const id = styles.cyan(tool.callableId);
  const name = styles.bold(tool.name);
  const dash = styles.dim("—");

  const prefix = `${padRight(id, opts.idWidth)}  ${name}`;
  const descIndent = visibleLength(prefix) + 3;
  const descWidth = Math.max(20, width - descIndent);
  const descLines = wrapText(tool.description, descWidth);

  const lines: string[] = [];
  lines.push(`${prefix}  ${dash} ${descLines[0] ?? ""}`);
  for (const cont of descLines.slice(1)) {
    lines.push(`${" ".repeat(descIndent)}${cont}`);
  }

  if (opts.showArgs) {
    const args = "input" in tool ? tool.input : tool.shortInput;
    if (args.length > 0) {
      lines.push(styles.dim(`${" ".repeat(2)}Args:`));
      lines.push(...formatBullets(args, { indent: 4, dim: true }));
    }
  }

  return lines.join("\n");
}

type OutputMode = "compact" | "json";

const commonOptions = [
  '--output=<"compact" | "json"> (default: "compact")',
  "--input=@file.json | --input='<json>' | --input=@-",
  "--stdin (alias for --input=@-)",
  "--<field>:json=@file.json | --<field>:json='<json>' | --<field>:json=@-",
];

async function main() {
  const parsed = parseArgs();

  try {
    switch (parsed.type) {
      case "version": {
        console.log(banner());
        break;
      }
      case "help": {
        if (parsed.callableId) {
          const result = await toolHelp(parsed.callableId);

          const usageLines = [
            `tools ${result.callableId} --arg1=value --arg2=value`,
            `tools ${result.callableId} --input @payload.json`,
            `cat payload.json | tools ${result.callableId} --stdin`,
          ];

          const examples = [
            `tools ${result.callableId} --input @payload.json`,
            `cat payload.json | tools ${result.callableId} --stdin`,
            `tools ${result.callableId} --tasks:json=@tasks.json --summary=\"...\"`,
          ];

          const output = [
            banner(),
            "",
            `${styles.bold(result.name)} ${styles.dim("—")} ${result.description}`,
            "",
            section("Usage", usageLines),
            "",
            section("Arguments", formatBullets(result.input, { indent: 0 })),
            "",
            section("Options", formatBullets(commonOptions, { indent: 0 })),
            "",
            section("Examples", formatBullets(examples, { indent: 0 })),
          ];

          console.log(output.join("\n"));
        } else {
          const output = [
            banner(),
            "",
            section("Usage", [
              "tools --list",
              "tools --help [tool]",
              "tools <tool> --arg1=value --arg2=value",
              "tools <tool> --input @payload.json",
              "cat payload.json | tools <tool> --stdin",
            ]),
            "",
            section(
              "Flags",
              formatBullets([
                "--list\tList all available tools",
                "--help\tShow help (optionally for a tool)",
                "--version\tPrint version",
              ]),
            ),
            "",
            section("Options", formatBullets(commonOptions)),
            "",
            section(
              "Examples",
              formatBullets([
                "tools workflow --input @workflow.json",
                "cat workflow.json | tools workflow --stdin",
                'cat tasks.json | tools workflow --summary="..." --tasks:json=@-',
              ]),
            ),
            "",
            section(
              "Environment",
              formatBullets([
                `TOOL_SERVER_BACKEND_URL (default: ${BACKEND_URL})`,
                "NO_COLOR disables ANSI formatting",
              ]),
            ),
          ].join("\n");

          console.log(output);
        }
        break;
      }
      case "list": {
        const { tools } = await listTools();
        const idWidth = Math.min(
          28,
          Math.max(10, ...tools.map((t) => t.callableId.length)),
        );

        const output: string[] = [
          banner(),
          "",
          section("Usage", [
            "tools <tool> --arg1=value --arg2=value",
            "tools <tool> --input @payload.json",
            "cat payload.json | tools <tool> --stdin",
          ]),
          "",
          styles.bold(
            "Available tools (quick reference; use --help on a tool for details):",
          ),
          "",
          ...tools.map((t) => formatToolBlock(t, { idWidth, showArgs: true })),
          "",
          section("Options", formatBullets(commonOptions)),
        ];

        console.log(output.join("\n"));
        break;
      }
      case "call": {
        const hasAnyInputFlags =
          parsed.baseInput !== undefined ||
          parsed.fieldInputs.length > 0 ||
          parsed.jsonFieldInputs.length > 0;

        if (
          !parsed.usesStdin &&
          !hasAnyInputFlags &&
          process.stdin.isTTY === false
        ) {
          throw new Error(
            "Stdin is piped, but this invocation does not read stdin. Use --stdin/--input=@- for a JSON payload, or --<field>:json=@- for a JSON field.",
          );
        }

        const toolInput = await buildToolInput(parsed);
        const result = await callTool(parsed.callableId, toolInput);

        if (result.isError) {
          console.error(`${styles.red("Error:")} ${result.output}`);
          process.exit(1);
        }

        if (parsed.outputMode === "json") {
          console.log(JSON.stringify(result.output, null, 2));
        } else {
          console.log(encode(result.output));
        }
        break;
      }
      case "unknown": {
        console.error(`${styles.red("Error:")} Unknown command, try --help`);
        process.exit(1);
      }
    }
  } catch (e) {
    if (e instanceof Error) {
      console.error(`${styles.red("Error:")} ${e.message}`);
    } else {
      console.error(`${styles.red("Error:")} unknown error`, e);
    }
    process.exit(1);
  }
}

type JsonSource =
  | { kind: "inline"; text: string }
  | { kind: "file"; path: string }
  | { kind: "stdin" };

type ParsedArgs =
  | { type: "version" }
  | { type: "help"; callableId?: string }
  | { type: "list" }
  | {
      type: "call";
      callableId: string;
      outputMode: OutputMode;
      baseInput?: JsonSource;
      fieldInputs: { field: string; value: number | string | boolean }[];
      jsonFieldInputs: { field: string; source: JsonSource }[];
      usesStdin: boolean;
    }
  | { type: "unknown" };

function parseArgs(): ParsedArgs {
  const args = process.argv.slice(2);
  const firstArg = args[0];

  if (firstArg === "--version") return { type: "version" };

  // Alias / fallback: tools --help <callableId>
  if (firstArg === "--help") {
    const maybeTool = args[1];
    if (maybeTool && !maybeTool.startsWith("--")) {
      return { type: "help", callableId: maybeTool };
    }
    return { type: "help" };
  }

  if (firstArg === "--list") return { type: "list" };

  if (firstArg && !firstArg.startsWith("--")) {
    const callableId = firstArg;

    const fieldInputs: { field: string; value: number | string | boolean }[] =
      [];
    const jsonFieldInputs: { field: string; source: JsonSource }[] = [];

    let baseInput: JsonSource | undefined;
    let outputMode: OutputMode = "compact";

    let stdinConsumer: string | undefined;

    function claimStdin(consumer: string) {
      if (stdinConsumer && stdinConsumer !== consumer) {
        throw new Error(
          `Stdin can only be used once per invocation (already used by ${stdinConsumer}, cannot use for ${consumer}).`,
        );
      }
      stdinConsumer = consumer;
    }

    for (const a of args.slice(1)) {
      if (!a.startsWith("--")) {
        throw new Error(`Unexpected argument '${a}'. Expected --key=value`);
      }

      const eq = a.indexOf("=");
      const k = eq === -1 ? a : a.slice(0, eq);
      const v = eq === -1 ? "" : a.slice(eq + 1);
      if (!k || k === "--") continue;

      // Special-case: tools <tool> --help / --help=true
      if (k === "--help") {
        const value = eq === -1 ? true : parseBooleanLike(v);
        if (value !== false) return { type: "help", callableId };
        continue;
      }

      if (k === "--output") {
        if (eq === -1) {
          throw new Error("--output requires a value: --output=compact|json");
        }
        if (v !== "compact" && v !== "json") {
          throw new Error(
            `Invalid --output value '${v}' (expected compact|json)`,
          );
        }
        outputMode = v;
        continue;
      }

      // Whole payload JSON.
      if (k === "--stdin") {
        const value = eq === -1 ? true : parseBooleanLike(v);
        if (value === false) continue;

        if (baseInput) {
          throw new Error("Only one of --stdin/--input may be provided");
        }
        baseInput = { kind: "stdin" };
        claimStdin("--stdin");
        continue;
      }

      if (k === "--input") {
        if (eq === -1) {
          throw new Error(
            "--input requires a value: --input=@file.json or --input=@- or --input='<json>'",
          );
        }

        if (baseInput) {
          throw new Error("Only one of --stdin/--input may be provided");
        }

        const source = parseJsonSource(v);
        if (source.kind === "stdin") claimStdin("--input=@-");
        baseInput = source;
        continue;
      }

      const fieldRaw = k.slice(2);
      if (!fieldRaw) continue;

      if (fieldRaw.endsWith(":json")) {
        const field = fieldRaw.slice(0, -":json".length);
        if (!field) {
          throw new Error(`Invalid JSON field flag '${k}'`);
        }
        if (eq === -1) {
          throw new Error(`--${field}:json requires a value`);
        }

        const source = parseJsonSource(v);
        if (source.kind === "stdin") claimStdin(`--${field}:json=@-`);

        jsonFieldInputs.push({ field, source });
        continue;
      }

      // Default: treat as primitive string/number/bool.
      let parsedValue: number | string | boolean = v;

      if (eq === -1) {
        // Preserve existing behavior for unknown --flag (it becomes empty-string).
        // The only exception is --help handled above.
        parsedValue = "";
      } else {
        const boolValue = parseBooleanLike(v);
        if (boolValue !== undefined) {
          parsedValue = boolValue;
        }
      }

      if (typeof parsedValue === "string") {
        parsedValue = normalizeMaybePath(fieldRaw, parsedValue);
        parsedValue = coerceNumberLike(parsedValue);
      }

      fieldInputs.push({ field: fieldRaw, value: parsedValue });
    }

    return {
      type: "call",
      callableId,
      outputMode,
      baseInput,
      fieldInputs,
      jsonFieldInputs,
      usesStdin: stdinConsumer !== undefined,
    };
  }

  return { type: "unknown" };
}

async function buildToolInput(parsed: Extract<ParsedArgs, { type: "call" }>) {
  let input: Record<string, unknown> = {};

  if (parsed.baseInput) {
    input = await readJsonObjectSource(parsed.baseInput, "--input/--stdin");
  }

  for (const { field, source } of parsed.jsonFieldInputs) {
    const value = await readJsonSource(source, `--${field}:json`);
    input[field] = value;
  }

  for (const { field, value } of parsed.fieldInputs) {
    input[field] = value;
  }

  return input;
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

function parseJsonSource(value: string): JsonSource {
  if (value === "@-" || value === "-") {
    return { kind: "stdin" };
  }

  if (value.startsWith("@")) {
    const p = value.slice(1);
    if (!p) {
      throw new Error("Invalid JSON source '@' (expected @file.json or @-)");
    }
    return { kind: "file", path: resolve(expandTilde(p)) };
  }

  if (value.length === 0) {
    throw new Error(
      "Empty JSON source (expected @file.json, @-, or inline JSON)",
    );
  }

  return { kind: "inline", text: value };
}

async function readJsonObjectSource(source: JsonSource, label: string) {
  const value = await readJsonSource(source, label);
  if (!isRecord(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return value;
}

async function readJsonSource(
  source: JsonSource,
  label: string,
): Promise<unknown> {
  let raw: string;

  if (source.kind === "stdin") {
    raw = await readStdinText();
  } else if (source.kind === "file") {
    raw = await fs.readFile(source.path, "utf8");
  } else {
    raw = source.text;
  }

  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error(`${label} is empty`);
  }

  try {
    return JSON.parse(trimmed) as unknown;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`${label} is not valid JSON: ${msg}`);
  }
}

async function readStdinText(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function parseBooleanLike(s: string): boolean | undefined {
  const lowered = s.trim().toLowerCase();
  if (lowered === "true") return true;
  if (lowered === "false") return false;
  return undefined;
}

const DECIMAL_NUMBER_RE = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;

function looksLikePath(value: string) {
  if (value.includes("://")) return false;
  if (value === "~" || value.startsWith("~/") || value.startsWith("~\\")) {
    return true;
  }
  if (value.startsWith("./") || value.startsWith("../")) return true;
  if (value.startsWith("/")) return true;
  if (/^[a-zA-Z]:[\\/]/.test(value)) return true;
  return false;
}

function looksLikeBase64(value: string) {
  if (value.length < 32) return false;
  if (value.length > 10_000) return true;
  return /^[A-Za-z0-9+/]+={0,2}$/.test(value);
}

function expandTilde(value: string) {
  if (value === "~") return homedir();
  if (value.startsWith("~/")) return `${homedir()}/${value.slice(2)}`;
  if (value.startsWith("~\\")) return `${homedir()}\\${value.slice(2)}`;
  return value;
}

function normalizeMaybePath(field: string, value: string) {
  if (value.length === 0) return value;

  const fieldLower = field.toLowerCase();
  const isPathField = fieldLower.endsWith("path");

  // Avoid mis-detecting base64 (often starts with "/" e.g. "/9j/").
  if (fieldLower.includes("base64") || looksLikeBase64(value)) return value;

  // For unknown flags, only normalize *very* path-like values.
  // This keeps the CLI generic while avoiding false positives.
  const shouldNormalize =
    isPathField || (looksLikePath(value) && value.length <= 512);

  if (!shouldNormalize) return value;
  return resolve(expandTilde(value));
}

function coerceNumberLike(input: string): string | number {
  const s = input.trim();

  // If you want to preserve whitespace for non-numbers, don’t trim here;
  // instead test on trimmed but return original.
  if (!DECIMAL_NUMBER_RE.test(s)) return input;

  const n = Number(s);
  if (!Number.isFinite(n)) return input; // extra safety

  return n;
}

await main();
