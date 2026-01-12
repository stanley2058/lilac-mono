import { encode } from "@toon-format/toon";

declare global {
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

function toToolDescription(
  tool: ToolOutputFull | Omit<ToolOutputFull, "input">,
) {
  const input = "input" in tool ? tool.input : tool.shortInput;

  return [
    `${tool.callableId}\t${tool.name} - ${tool.description}`,
    ...input.map((s) => `  ${s}`),
    "",
  ].join("\n");
}

const commonOptions = [
  "Common options:",
  "",
  '--output=<"compact" | "json"> (default: "compact")',
];

async function main() {
  const parsed = parseArgs();

  try {
    switch (parsed.type) {
      case "version": {
        console.log(
          `tools - All-in-one tool proxy [version: ${PACKAGE_VERSION}]`,
        );
        break;
      }
      case "help": {
        if (parsed.callableId) {
          const result = await toolHelp(parsed.callableId);
          const output: string[] = [
            `${result.name} - ${result.description}`,
            `Usage: tools ${result.callableId} --arg1=value --arg2=value`,
            "",
            "Available arguments:",
            "",
            ...result.input.map((s) => `  ${s}`),
            "",
            ...commonOptions,
          ];
          console.log(output.join("\n"));
        } else {
          const output = [
            `tools - All-in-one tool proxy [version: ${PACKAGE_VERSION}]`,
            "",
            "Usage: tools <tool> --arg1=value --arg2=value",
            "Call a built-in tool with arguments.",
            "",
            "--list\tList all available tools",
            "--help\tShow this help message",
          ].join("\n");
          console.log(output);
        }
        break;
      }
      case "list": {
        const { tools } = await listTools();
        const output: string[] = [
          "Usage: tools <tool> --arg1=value --arg2=value",
          "Call a built-in tool with arguments.",
          "",
          "Available tools (quick reference, use `--help` on individual tools for more info):",
          "",
          ...tools.map((t) => toToolDescription(t)),
          "",
          ...commonOptions,
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
          console.error(result.output);
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
        console.error("Unknown command, try --help");
        process.exit(1);
      }
    }
  } catch (e) {
    if (e instanceof Error) {
      console.error(e.message);
    } else {
      console.error("unknown error", e);
    }
    process.exit(1);
  }
}

function parseArgs() {
  const args = process.argv.slice(2);
  const firstArg = args[0];
  if (firstArg === "--version") return { type: "version" } as const;
  if (firstArg === "--help") return { type: "help" } as const;
  if (firstArg === "--list") return { type: "list" } as const;

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

    if (parsedInputMap.find((p) => p.field === "help")) {
      return { type: "help", callableId: firstArg } as const;
    }

    return {
      type: "call",
      callableId: firstArg,
      input: parsedInputMap,
    } as const;
  }

  return { type: "unknown" } as const;
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
