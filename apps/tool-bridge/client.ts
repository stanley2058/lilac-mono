import { encode } from "@toon-format/toon";

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
  const res = await fetch(`${BACKEND_URL}/call`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
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

const commonOptions = ['--output=<"compact" | "json"> (default: "compact")'];

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
          section("Usage", ["tools <tool> --arg1=value --arg2=value"]),
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
        const input = Object.fromEntries(
          parsed.input.map((i) => [i.field, i.value]),
        );
        const { output, ...rest } = input;
        const result = await callTool(parsed.callableId, rest);

        if (result.isError) {
          console.error(`${styles.red("Error:")} ${result.output}`);
          process.exit(1);
        }

        if (output === "json") {
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

type ParsedArgs =
  | { type: "version" }
  | { type: "help"; callableId?: string }
  | { type: "list" }
  | {
      type: "call";
      callableId: string;
      input: { field: string; value: number | string | boolean }[];
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
    const parsedInputMap = args
      .slice(1)
      .map((a) => {
        const [k, v] = a.split("=");
        if (!k) return null;
        let parsedValue: number | string | boolean = v || "";
        if (parsedValue.toLowerCase() === "true") parsedValue = true;
        else if (parsedValue.toLowerCase() === "false") parsedValue = false;
        if (typeof parsedValue === "string") {
          parsedValue = coerceNumberLike(parsedValue);
        }

        return { field: k.slice(2), value: parsedValue };
      })
      .filter(Boolean) as { field: string; value: number | string | boolean }[];

    // Original behavior: tools <tool> --help=true
    if (parsedInputMap.find((p) => p.field === "help")) {
      return { type: "help", callableId: firstArg };
    }

    return {
      type: "call",
      callableId: firstArg,
      input: parsedInputMap,
    };
  }

  return { type: "unknown" };
}

const DECIMAL_NUMBER_RE = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;
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
