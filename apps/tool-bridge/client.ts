/* oxlint-disable eslint/no-control-regex */

import { encode } from "@toon-format/toon";
import { getBuildInfo, type BuildInfo } from "@stanley2058/lilac-utils";
import { z } from "zod";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import fs from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";

const BACKEND_URL = process.env.TOOL_SERVER_BACKEND_URL || "http://localhost:8080";
const BUILD_ID_LENGTH = 8;
const DEV_BUILD_ID = "dev";
const VERSION_FETCH_TIMEOUT_MS = 1_500;
const CURRENT_FILE = fileURLToPath(import.meta.url);
const MODULE_DIR = dirname(CURRENT_FILE);

let buildIdPromise: Promise<string> | undefined;
let localVersionInfoPromise: Promise<LocalVersionInfo> | undefined;
let backendVersionInfoPromise: Promise<BackendVersionInfo | null> | undefined;

async function fetchNoTimeout(input: string, init?: RequestInit): Promise<Response> {
  // Bun (and Node's undici fetch) can enforce a default request timeout (~5m)
  // which breaks long-running tool calls (e.g. ssh.run). Use the same workaround
  // as the OpenCode SDK: set Request.timeout=false.
  const req = new Request(input, init);
  try {
    // Best-effort: this property is not part of the standard Fetch spec.
    Reflect.set(req as unknown as object, "timeout", false);
  } catch {
    // Ignore: runtime may not support this knob.
  }
  return await fetch(req);
}

async function fetchWithTimeout(
  input: string,
  timeoutMs: number,
  init?: RequestInit,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(new Error(`request timed out after ${timeoutMs}ms`));
  }, timeoutMs);
  timer.unref?.();

  try {
    return await fetchNoTimeout(input, {
      ...init,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

type ToolOutputFull = {
  callableId: string;
  name: string;
  description: string;
  shortInput: string[];
  input: string[];
  primaryPositional?: {
    field: string;
  };
  hidden?: boolean;
};

type LocalVersionInfo = BuildInfo & {
  build: string;
};

let callableIdsCache: string[] | undefined;

const objectLikeSchema = z.record(z.string(), z.unknown());

const listPayloadSchema = z.object({
  tools: z.array(
    z.object({
      callableId: z.string().min(1),
    }),
  ),
});

const errorPayloadSchema = z
  .object({
    message: z.string().optional(),
    output: z.string().optional(),
    error: z.unknown().optional(),
  })
  .passthrough();

const backendVersionPayloadSchema = z
  .object({
    ok: z.literal(true),
    version: z.string(),
    commit: z.string(),
    dirty: z.boolean().optional(),
    builtAt: z.string().optional(),
    plugins: z
      .object({
        loadedExternal: z.number().int().nonnegative(),
      })
      .optional(),
  })
  .passthrough();

type BackendVersionInfo = z.infer<typeof backendVersionPayloadSchema>;

function parseCallableIdsFromListPayload(payload: unknown): string[] {
  const parsed = listPayloadSchema.safeParse(payload);
  if (!parsed.success) return [];
  return parsed.data.tools.map((item) => item.callableId);
}

async function listCallableIdsBestEffort(): Promise<string[]> {
  if (callableIdsCache !== undefined) return callableIdsCache;

  try {
    const res = await fetchNoTimeout(`${BACKEND_URL}/list`);
    if (!res.ok) {
      callableIdsCache = [];
      return callableIdsCache;
    }
    const payload = (await res.json()) as unknown;
    callableIdsCache = parseCallableIdsFromListPayload(payload);
    return callableIdsCache;
  } catch {
    callableIdsCache = [];
    return callableIdsCache;
  }
}

function maybeString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function extractErrorMessage(payload: unknown): string | undefined {
  const asString = maybeString(payload);
  if (asString) return asString;

  const parsed = errorPayloadSchema.safeParse(payload);
  if (!parsed.success) return undefined;

  const directMessage = maybeString(parsed.data.message);
  if (directMessage) return directMessage;

  const outputMessage = maybeString(parsed.data.output);
  if (outputMessage) return outputMessage;

  const errorValue = parsed.data.error;
  const nested = extractErrorMessage(errorValue);
  if (nested) return nested;

  return undefined;
}

async function readHttpErrorMessage(res: Response): Promise<string | undefined> {
  let body = "";
  try {
    body = (await res.text()).trim();
  } catch {
    return undefined;
  }
  if (!body) return undefined;

  try {
    const payload = JSON.parse(body) as unknown;
    return extractErrorMessage(payload) ?? body;
  } catch {
    return body;
  }
}

function formatHttpStatus(res: Response): string {
  return res.statusText ? `${res.status} ${res.statusText}` : String(res.status);
}

function formatHttpFailure(action: string, res: Response, message?: string): string {
  if (message) return `Failed to ${action}: ${message}`;
  return `Failed to ${action}: ${formatHttpStatus(res)}`;
}

function levenshteinDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  const left = a.toLowerCase();
  const right = b.toLowerCase();

  let prev = Array.from({ length: right.length + 1 }, (_, i) => i);

  for (let i = 1; i <= left.length; i++) {
    const curr: number[] = [i];
    const leftChar = left[i - 1] ?? "";

    for (let j = 1; j <= right.length; j++) {
      const rightChar = right[j - 1] ?? "";
      const deletion = (prev[j] ?? Number.MAX_SAFE_INTEGER) + 1;
      const insertion = (curr[j - 1] ?? Number.MAX_SAFE_INTEGER) + 1;
      const substitution =
        (prev[j - 1] ?? Number.MAX_SAFE_INTEGER) + (leftChar === rightChar ? 0 : 1);
      curr[j] = Math.min(deletion, insertion, substitution);
    }

    prev = curr;
  }

  return prev[right.length] ?? Number.MAX_SAFE_INTEGER;
}

function pickCallableSuggestion(
  callableId: string,
  candidates: readonly string[],
): string | undefined {
  const query = callableId.trim();
  if (!query) return undefined;

  const queryLower = query.toLowerCase();
  const queryRoot = queryLower.split(".")[0] ?? "";

  let bestCandidate: string | undefined;
  let bestScore = Number.MAX_SAFE_INTEGER;

  for (const candidate of candidates) {
    const candidateLower = candidate.toLowerCase();
    if (candidateLower === queryLower) continue;

    let score = levenshteinDistance(queryLower, candidateLower);

    const candidateRoot = candidateLower.split(".")[0] ?? "";
    if (queryRoot && candidateRoot && queryRoot !== candidateRoot) {
      score += 2;
    }

    if (score < bestScore) {
      bestScore = score;
      bestCandidate = candidate;
      continue;
    }

    if (score === bestScore && bestCandidate && candidate.length < bestCandidate.length) {
      bestCandidate = candidate;
    }
  }

  if (!bestCandidate) return undefined;

  const threshold = Math.max(2, Math.ceil(Math.max(query.length, bestCandidate.length) * 0.25));
  if (bestScore > threshold) return undefined;

  return bestCandidate;
}

async function buildCallableIdErrorMessage(params: {
  action: string;
  callableId: string;
  res: Response;
  detail?: string;
}): Promise<string> {
  const isNotFound = params.res.status === 404;
  const looksLikeUnknownCallable =
    isNotFound || (params.detail?.includes("Unknown callable ID") ?? false);

  if (!looksLikeUnknownCallable) {
    return formatHttpFailure(params.action, params.res, params.detail);
  }

  const callableIds = await listCallableIdsBestEffort();
  const suggestion = pickCallableSuggestion(params.callableId, callableIds);
  if (suggestion) {
    return `Unknown callable ID '${params.callableId}'. Did you mean '${suggestion}'?`;
  }

  const base =
    params.detail && params.detail.length > 0
      ? params.detail
      : `Unknown callable ID '${params.callableId}'`;
  if (base.endsWith(".")) {
    return `${base} Run 'tools --list' to see available callable IDs.`;
  }
  return `${base}. Run 'tools --list' to see available callable IDs.`;
}

async function listTools() {
  const res = await fetchNoTimeout(`${BACKEND_URL}/list`);
  if (!res.ok) {
    const detail = await readHttpErrorMessage(res);
    throw new Error(formatHttpFailure("fetch tools list", res, detail));
  }
  const json = await res.json();
  return json as {
    tools: Omit<ToolOutputFull, "input">[];
  };
}

async function getBackendVersionInfoBestEffort(): Promise<BackendVersionInfo | null> {
  backendVersionInfoPromise ??= (async () => {
    try {
      const res = await fetchWithTimeout(`${BACKEND_URL}/versionz`, VERSION_FETCH_TIMEOUT_MS);
      if (!res.ok) return null;

      const payload = (await res.json()) as unknown;
      const parsed = backendVersionPayloadSchema.safeParse(payload);
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  })();

  return await backendVersionInfoPromise;
}

async function toolHelp(callableId: string) {
  const res = await fetchNoTimeout(`${BACKEND_URL}/help/${encodeURIComponent(callableId)}`);
  if (!res.ok) {
    const detail = await readHttpErrorMessage(res);
    throw new Error(
      await buildCallableIdErrorMessage({
        action: "fetch tool help",
        callableId,
        res,
        detail,
      }),
    );
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

  const res = await fetchNoTimeout(`${BACKEND_URL}/call`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      callableId,
      input,
    }),
  });
  if (!res.ok) {
    const detail = await readHttpErrorMessage(res);
    throw new Error(
      await buildCallableIdErrorMessage({
        action: "call tool",
        callableId,
        res,
        detail,
      }),
    );
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

async function isFile(filePath: string): Promise<boolean> {
  try {
    const stats = await fs.stat(filePath);
    return stats.isFile();
  } catch {
    return false;
  }
}

async function sha256HexPrefix(filePath: string, length = BUILD_ID_LENGTH): Promise<string> {
  const bytes = await fs.readFile(filePath);
  return createHash("sha256").update(bytes).digest("hex").slice(0, length);
}

export async function resolveBuildId(currentFile = CURRENT_FILE): Promise<string> {
  const normalizedCurrent = normalizePathCandidate(currentFile, process.cwd()) ?? currentFile;
  if (!normalizedCurrent) return DEV_BUILD_ID;

  const currentBase = basename(normalizedCurrent);
  if (currentBase === "client.ts") return DEV_BUILD_ID;

  const artifactPath =
    currentBase === "client.js"
      ? normalizedCurrent
      : resolve(dirname(normalizedCurrent), "client.js");

  if (!(await isFile(artifactPath))) return DEV_BUILD_ID;

  try {
    return await sha256HexPrefix(artifactPath);
  } catch {
    return DEV_BUILD_ID;
  }
}

async function getBuildId(): Promise<string> {
  buildIdPromise ??= resolveBuildId();
  return await buildIdPromise;
}

async function getLocalVersionInfo(): Promise<LocalVersionInfo> {
  localVersionInfoPromise ??= (async () => ({
    ...getBuildInfo({ cwd: MODULE_DIR }),
    build: await getBuildId(),
  }))();

  return await localVersionInfoPromise;
}

function formatTag(label: string, value: string): string {
  return styles.dim(`[${label}: ${value}]`);
}

function buildLocalVersionTags(localVersion: LocalVersionInfo): string[] {
  const tags = [formatTag("commit", localVersion.commit), formatTag("build", localVersion.build)];

  if (localVersion.dirty) {
    tags.push(styles.yellow("[dirty]"));
  }

  return tags;
}

export function buildVersionTags(
  localVersion: LocalVersionInfo,
  backendVersion: BackendVersionInfo | null,
): string[] {
  const tags = buildLocalVersionTags(localVersion);
  if (!backendVersion) return tags;

  if (backendVersion.commit !== localVersion.commit) {
    tags.push(formatTag("app", backendVersion.commit));
  }

  if (backendVersion.dirty) {
    tags.push(styles.yellow("[app-dirty]"));
  }

  const pluginCount = backendVersion.plugins?.loadedExternal ?? 0;
  if (pluginCount > 0) {
    tags.push(formatTag("plugins", String(pluginCount)));
  }

  return tags;
}

function renderBanner(tags: readonly string[]): string {
  const name = styles.bold("tools");
  return tags.length > 0
    ? `${name} - All-in-one tool proxy ${tags.join(" ")}`
    : `${name} - All-in-one tool proxy`;
}

async function banner() {
  return renderBanner(buildLocalVersionTags(await getLocalVersionInfo()));
}

async function versionBanner() {
  const [localVersion, backendVersion] = await Promise.all([
    getLocalVersionInfo(),
    getBackendVersionInfoBestEffort(),
  ]);
  return renderBanner(buildVersionTags(localVersion, backendVersion));
}

function formatBullets(
  items: string[],
  opts?: { indent?: number; dim?: boolean; withPrefix?: boolean },
) {
  const indent = opts?.indent ?? 0;
  const bulletPrefix = opts?.withPrefix ? "- " : "";
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
    if (tool.primaryPositional) {
      lines.push(
        ...formatBullets([formatPrimaryPositionalSummary(tool.primaryPositional.field)], {
          indent: 2,
          dim: true,
        }),
      );
    }
    if (args.length > 0) {
      lines.push(...formatBullets(args, { indent: 2, dim: true }));
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

function formatPrimaryPositionalSummary(field: string): string {
  const display = camelToKebabCase(field);
  return `<${display}> (primary positional; same as --${display}=...)`;
}

function buildUsageLinesForTool(
  tool: Pick<ToolOutputFull, "callableId" | "primaryPositional">,
): string[] {
  const usageLines: string[] = [];
  if (tool.primaryPositional) {
    usageLines.push(`tools ${tool.callableId} <${camelToKebabCase(tool.primaryPositional.field)}>`);
  }
  usageLines.push(
    `tools ${tool.callableId} --arg1=value --arg2=value`,
    `tools ${tool.callableId} --input=@payload.json`,
    `cat payload.json | tools ${tool.callableId} --stdin`,
  );
  return usageLines;
}

async function main() {
  const parsed = parseArgs();

  try {
    switch (parsed.type) {
      case "version": {
        console.log(await versionBanner());
        break;
      }
      case "help": {
        if (parsed.callableId) {
          if (parsed.callableId === "onboard") {
            const output = [
              await banner(),
              "",
              `${styles.bold("onboard")} ${styles.dim("—")} Configure agent git identity + GPG signing under DATA_DIR`,
              "",
              section("Usage", [
                "tools onboard",
                "tools onboard --yes",
                'tools onboard --yes --name="lilac-agent[bot]" --email="lilac-agent[bot]@users.noreply.github.com"',
                "tools onboard --no-sign",
              ]),
              "",
              section(
                "Flags",
                formatBullets([
                  "--data-dir=<path>\tOverride DATA_DIR for this run",
                  "--name=<string>\tGit user.name",
                  "--email=<string>\tGit user.email",
                  "--sign\tEnable GPG commit signing (default)",
                  "--no-sign\tDisable commit signing",
                  "--yes, -y\tNon-interactive (accept defaults)",
                  "--output=compact|json\tOutput format",
                ]),
              ),
            ].join("\n");

            console.log(output);
            break;
          }

          const result = await toolHelp(parsed.callableId);

          const usageLines = buildUsageLinesForTool(result);

          const output = [
            await banner(),
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
            await banner(),
            "",
            section("Usage", [
              "tools --list",
              "tools --help [tool]",
              "tools <tool> --arg1=value --arg2=value",
              "tools <tool> --input=@payload.json",
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
                "tools workflow.wait_for_reply.create --input=@workflow.json",
                "cat workflow.json | tools workflow.wait_for_reply.create --stdin",
                'cat tasks.json | tools workflow.wait_for_reply.create --summary="..." --tasks:json=@-',
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
        const visibleTools = parsed.showHidden ? tools : tools.filter((t) => t.hidden !== true);
        const idWidth = Math.min(28, Math.max(10, ...visibleTools.map((t) => t.callableId.length)));

        const output: string[] = [
          await banner(),
          "",
          section("Usage", [
            "tools <tool> --arg1=value --arg2=value",
            "tools <tool> --input=@payload.json",
            "cat payload.json | tools <tool> --stdin",
          ]),
          "",
          styles.bold("Available tools (quick reference; use --help on a tool for details):"),
          "",
          ...visibleTools.map((t) => formatToolBlock(t, { idWidth, showArgs: true })),
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
          parsed.jsonFieldInputs.length > 0 ||
          parsed.positionalArgs.length > 0;

        if (!parsed.usesStdin && !hasAnyInputFlags && process.stdin.isTTY === false) {
          throw new Error(
            "Stdin is piped, but this invocation does not read stdin. Use --stdin/--input=@- for a JSON payload, or --<field>:json=@- for a JSON field.",
          );
        }

        const primaryPositional =
          parsed.positionalArgs.length > 0
            ? (await toolHelp(parsed.callableId)).primaryPositional
            : undefined;

        const toolInput = await buildToolInput(parsed, primaryPositional);
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
      case "onboard": {
        const result = await runOnboardingWizard(parsed);
        if (parsed.outputMode === "json") {
          console.log(JSON.stringify(result, null, 2));
        } else {
          console.log(encode(result));
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
  | { type: "list"; showHidden: boolean }
  | {
      type: "onboard";
      outputMode: OutputMode;
      dataDir?: string;
      userName?: string;
      userEmail?: string;
      sign?: boolean;
      yes: boolean;
    }
  | {
      type: "call";
      callableId: string;
      outputMode: OutputMode;
      baseInput?: JsonSource;
      fieldInputs: { field: string; value: string | boolean }[];
      jsonFieldInputs: { field: string; source: JsonSource }[];
      positionalArgs: string[];
      usesStdin: boolean;
    }
  | { type: "unknown" };

export function parseArgs(args = process.argv.slice(2)): ParsedArgs {
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

  if (firstArg === "--list") {
    const showHidden = args.some((a) => {
      if (a === "--show-hidden") return true;
      if (a.startsWith("--show-hidden=")) {
        const eq = a.indexOf("=");
        const v = eq === -1 ? "" : a.slice(eq + 1);
        return parseBooleanLike(v) === true;
      }
      return false;
    });
    return { type: "list", showHidden };
  }

  if (firstArg === "onboard") {
    const restArgs = args.slice(1);
    let outputMode: OutputMode = "compact";
    let dataDir: string | undefined;
    let userName: string | undefined;
    let userEmail: string | undefined;
    let sign: boolean | undefined;
    let yes = false;

    for (let i = 0; i < restArgs.length; i++) {
      const a = restArgs[i];
      if (a === "-y") {
        yes = true;
        continue;
      }
      if (!a || !a.startsWith("--")) {
        throw new Error(`Unexpected argument '${a ?? ""}'. Expected --key=value or --key value`);
      }

      const eq = a.indexOf("=");
      const k = eq === -1 ? a : a.slice(0, eq);
      let v = eq === -1 ? "" : a.slice(eq + 1);
      let hasValue = eq !== -1;

      if (!hasValue) {
        const next = restArgs[i + 1];
        if (typeof next === "string" && next.length > 0 && !next.startsWith("--")) {
          v = next;
          hasValue = true;
          i++;
        }
      }

      if (k === "--help") {
        const value = hasValue ? parseBooleanLike(v) : true;
        if (value !== false) return { type: "help", callableId: "onboard" };
        continue;
      }

      if (k === "--output") {
        if (!hasValue) {
          throw new Error(
            "--output requires a value: --output=compact|json or --output compact|json",
          );
        }
        if (v !== "compact" && v !== "json") {
          throw new Error(`Invalid --output value '${v}' (expected compact|json)`);
        }
        outputMode = v;
        continue;
      }

      if (k === "--yes") {
        const value = hasValue ? parseBooleanLike(v) : true;
        if (value !== false) yes = true;
        continue;
      }

      if (k === "--data-dir") {
        if (!hasValue) throw new Error("--data-dir requires a value");
        dataDir = normalizeMaybePath("dataDir", v);
        continue;
      }

      if (k === "--name") {
        if (!hasValue) throw new Error("--name requires a value");
        userName = v;
        continue;
      }

      if (k === "--email") {
        if (!hasValue) throw new Error("--email requires a value");
        userEmail = v;
        continue;
      }

      if (k === "--sign") {
        const value = hasValue ? parseBooleanLike(v) : true;
        sign = value ?? true;
        continue;
      }

      if (k === "--no-sign") {
        const value = hasValue ? parseBooleanLike(v) : true;
        if (value !== false) sign = false;
        continue;
      }

      throw new Error(`Unknown flag '${k}' for onboard`);
    }

    return {
      type: "onboard",
      outputMode,
      dataDir,
      userName,
      userEmail,
      sign,
      yes,
    };
  }

  if (firstArg && !firstArg.startsWith("--")) {
    const callableId = firstArg;

    const fieldInputs: { field: string; value: string | boolean }[] = [];
    const jsonFieldInputs: { field: string; source: JsonSource }[] = [];
    const positionalArgs: string[] = [];

    const seenCanonicalFields = new Map<string, string>();

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

    const restArgs = args.slice(1);
    for (let i = 0; i < restArgs.length; i++) {
      const a = restArgs[i];
      if (!a) continue;

      if (a === "--") {
        positionalArgs.push(...restArgs.slice(i + 1));
        break;
      }

      if (!a.startsWith("--")) {
        positionalArgs.push(a);
        continue;
      }

      const eq = a.indexOf("=");
      let k = eq === -1 ? a : a.slice(0, eq);
      let v = eq === -1 ? "" : a.slice(eq + 1);
      let hasValue = eq !== -1;

      if (!hasValue) {
        const next = restArgs[i + 1];
        if (typeof next === "string" && next.length > 0 && !next.startsWith("--")) {
          v = next;
          hasValue = true;
          i++;
        }
      }
      if (!k || k === "--") continue;

      // Special-case: tools <tool> --help / --help=true
      if (k === "--help") {
        const value = hasValue ? parseBooleanLike(v) : true;
        if (value !== false) return { type: "help", callableId };
        continue;
      }

      if (k === "--output") {
        if (!hasValue) {
          throw new Error(
            "--output requires a value: --output=compact|json or --output compact|json",
          );
        }
        if (v !== "compact" && v !== "json") {
          throw new Error(`Invalid --output value '${v}' (expected compact|json)`);
        }
        outputMode = v;
        continue;
      }

      // Whole payload JSON.
      if (k === "--stdin") {
        const value = hasValue ? parseBooleanLike(v) : true;
        if (value === false) continue;

        if (baseInput) {
          throw new Error("Only one of --stdin/--input may be provided");
        }
        baseInput = { kind: "stdin" };
        claimStdin("--stdin");
        continue;
      }

      if (k === "--input") {
        if (!hasValue) {
          throw new Error(
            "--input requires a value: --input=@file.json, --input @file.json, --input=@-, or --input='<json>'",
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
        const rawField = fieldRaw.slice(0, -":json".length);
        const field = kebabToCamelCase(rawField);
        if (!field) {
          throw new Error(`Invalid JSON field flag '${k}'`);
        }

        const previous = seenCanonicalFields.get(field);
        if (previous && previous !== rawField) {
          throw new Error(
            `Duplicate field '${field}' via flags '--${previous}' and '--${rawField}'. Use only one casing.`,
          );
        }
        if (!previous) seenCanonicalFields.set(field, rawField);

        if (!hasValue) {
          throw new Error(`--${field}:json requires a value`);
        }

        const source = parseJsonSource(v);
        if (source.kind === "stdin") claimStdin(`--${field}:json=@-`);

        jsonFieldInputs.push({ field, source });
        continue;
      }

      // Default: treat as primitive string/bool.
      const field = kebabToCamelCase(fieldRaw);
      const previous = seenCanonicalFields.get(field);
      if (previous && previous !== fieldRaw) {
        throw new Error(
          `Duplicate field '${field}' via flags '--${previous}' and '--${fieldRaw}'. Use only one casing.`,
        );
      }
      if (!previous) seenCanonicalFields.set(field, fieldRaw);

      let parsedValue: string | boolean = v;

      if (!hasValue) {
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
        parsedValue = normalizeMaybePath(field, parsedValue);
      }

      fieldInputs.push({ field, value: parsedValue });
    }

    return {
      type: "call",
      callableId,
      outputMode,
      baseInput,
      fieldInputs,
      jsonFieldInputs,
      positionalArgs,
      usesStdin: stdinConsumer !== undefined,
    };
  }

  return { type: "unknown" };
}

export async function buildToolInput(
  parsed: Extract<ParsedArgs, { type: "call" }>,
  primaryPositional?: { field: string },
) {
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

  if (parsed.positionalArgs.length > 0) {
    if (!primaryPositional) {
      throw new Error(
        `Tool '${parsed.callableId}' does not support positional input. Use --flags or --input JSON instead.`,
      );
    }

    const displayField = camelToKebabCase(primaryPositional.field);
    if (parsed.positionalArgs.length > 1) {
      throw new Error(
        `Tool '${parsed.callableId}' accepts at most one positional argument: <${displayField}>.`,
      );
    }

    if (Object.hasOwn(input, primaryPositional.field)) {
      throw new Error(
        `Primary positional <${displayField}> conflicts with an existing '${primaryPositional.field}' value from flags or JSON input.`,
      );
    }

    input[primaryPositional.field] = normalizeMaybePath(
      primaryPositional.field,
      parsed.positionalArgs[0] ?? "",
    );
  }

  return input;
}

async function runOnboardingWizard(parsed: Extract<ParsedArgs, { type: "onboard" }>) {
  const defaultName = "lilac-agent[bot]";
  const defaultEmail = "lilac-agent[bot]@users.noreply.github.com";

  const needsTty =
    !parsed.yes &&
    (parsed.userName === undefined || parsed.userEmail === undefined || parsed.sign === undefined);
  if (needsTty && process.stdin.isTTY === false) {
    throw new Error(
      "tools onboard requires a TTY for prompts. Use --yes with optional --name/--email/--sign flags for non-interactive use.",
    );
  }

  const rl = process.stdin.isTTY
    ? createInterface({ input: process.stdin, output: process.stdout })
    : null;

  const askText = async (label: string, fallback: string) => {
    if (!rl || parsed.yes) return fallback;
    const answer = await rl.question(`${label} (${fallback}): `);
    const v = answer.trim();
    return v.length > 0 ? v : fallback;
  };

  const askYesNo = async (label: string, fallback: boolean) => {
    if (!rl || parsed.yes) return fallback;
    const suffix = fallback ? "Y/n" : "y/N";
    const answer = await rl.question(`${label} (${suffix}): `);
    const v = answer.trim().toLowerCase();
    if (v === "") return fallback;
    if (v === "y" || v === "yes" || v === "true") return true;
    if (v === "n" || v === "no" || v === "false") return false;
    return fallback;
  };

  const getStringField = (obj: unknown, key: string): string | undefined => {
    const parsed = objectLikeSchema.safeParse(obj);
    if (!parsed.success) return undefined;
    const v = parsed.data[key];
    return typeof v === "string" ? v : undefined;
  };

  try {
    const userName = parsed.userName ?? (await askText("Git user.name", defaultName));
    const userEmail = parsed.userEmail ?? (await askText("Git user.email", defaultEmail));
    const sign =
      parsed.sign ?? (await askYesNo("Enable GPG commit signing (no-passphrase key)", true));

    const baseInput: Record<string, unknown> = parsed.dataDir ? { dataDir: parsed.dataDir } : {};

    const bootstrap = await callTool("onboarding.bootstrap", baseInput);
    if (bootstrap.isError) throw new Error(bootstrap.output);

    const vcsEnv = await callTool("onboarding.vcs_env", baseInput);
    if (vcsEnv.isError) throw new Error(vcsEnv.output);

    let fingerprint: string | undefined;
    let publicKeyArmored: string | undefined;

    if (sign) {
      const gpgRes = await callTool("onboarding.gnupg", {
        ...baseInput,
        mode: "generate",
        userName,
        userEmail,
        uidComment: "lilac",
      });
      if (gpgRes.isError) throw new Error(gpgRes.output);
      fingerprint = getStringField(gpgRes.output, "fingerprint");
      if (!fingerprint) {
        throw new Error("GPG key generation did not return a fingerprint");
      }

      const exp = await callTool("onboarding.gnupg", {
        ...baseInput,
        mode: "export_public",
        fingerprint,
      });
      if (exp.isError) throw new Error(exp.output);
      publicKeyArmored = getStringField(exp.output, "publicKeyArmored");
    }

    const cfg = await callTool("onboarding.git_identity", {
      ...baseInput,
      mode: "configure",
      userName,
      userEmail,
      enableSigning: sign,
      ...(sign ? { signingKey: fingerprint } : {}),
    });
    if (cfg.isError) throw new Error(cfg.output);

    const test = await callTool("onboarding.git_identity", {
      ...baseInput,
      mode: "test",
    });
    if (test.isError) throw new Error(test.output);

    return {
      ok: true as const,
      userName,
      userEmail,
      signing: sign
        ? {
            enabled: true as const,
            fingerprint,
            publicKeyArmored,
            notes: ["Add this public key to GitHub (Settings -> SSH and GPG keys -> New GPG key)."],
          }
        : { enabled: false as const },
      vcsEnv: vcsEnv.output,
      gitTest: test.output,
    };
  } finally {
    await rl?.close();
  }
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
    throw new Error("Empty JSON source (expected @file.json, @-, or inline JSON)");
  }

  return { kind: "inline", text: value };
}

async function readJsonObjectSource(source: JsonSource, label: string) {
  const value = await readJsonSource(source, label);
  const parsed = objectLikeSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(`${label} must be a JSON object`);
  }
  return parsed.data;
}

async function readJsonSource(source: JsonSource, label: string): Promise<unknown> {
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
  const shouldNormalize = isPathField || (looksLikePath(value) && value.length <= 512);

  if (!shouldNormalize) return value;
  return resolve(expandTilde(value));
}

function kebabToCamelCase(input: string): string {
  if (!input.includes("-")) return input;
  return input.replace(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase());
}

function camelToKebabCase(input: string): string {
  return input.replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`);
}

function normalizePathCandidate(candidate: string | undefined, cwd: string): string | undefined {
  if (!candidate) return undefined;

  const resolved = resolve(cwd, candidate);
  try {
    return realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

export function isMainModule(args = process.argv, cwd = process.cwd(), currentFile = CURRENT_FILE) {
  const normalizedCurrent = normalizePathCandidate(currentFile, cwd);
  const normalizedArgv1 = normalizePathCandidate(args[1], cwd);

  if (!normalizedCurrent || !normalizedArgv1) return false;
  if (normalizedCurrent === normalizedArgv1) return true;

  const currentBase = basename(normalizedCurrent);
  const argvBase = basename(normalizedArgv1);
  const isClientModule = currentBase === "client.js" || currentBase === "client.ts";
  const isGeneratedWrapper = argvBase === "index.js" || argvBase === "index.ts";

  if (
    isClientModule &&
    isGeneratedWrapper &&
    dirname(normalizedCurrent) === dirname(normalizedArgv1)
  ) {
    return true;
  }

  return false;
}

if (isMainModule()) {
  await main();
}
