import { Result } from "better-result";
import { z } from "zod";
import type { DisplayPart } from "@stanley2058/lilac-client-protocol";

export type ActivityPart = Extract<DisplayPart, { type: "data-activity" }>;
export type ActivityRowKind =
  | "thinking"
  | "workflow"
  | "agent"
  | "command"
  | "read"
  | "search"
  | "edit"
  | "web"
  | "tool";

const toolKinds: Record<string, ActivityRowKind> = {
  bash: "command",
  read: "read",
  read_file: "read",
  readFile: "read",
  glob: "search",
  grep: "search",
  fuzzy_search: "search",
  edit: "edit",
  edit_file: "edit",
  patch: "edit",
  apply_patch: "edit",
  subagent_delegate: "agent",
};

/** Splits a core tool display label (`<toolName><formatted args>`) into its tool name and arguments. */
export function parseToolLabel(label: string): { name: string; args: string } {
  const match = /^(\S+)\s*([\s\S]*)$/.exec(label.trim());
  return { name: match?.[1] ?? "", args: match?.[2]?.trim() ?? "" };
}

const toolArgsSchema = z.object({
  path: z.string().optional(),
  pattern: z.string().optional(),
  patterns: z.array(z.string()).optional(),
  query: z.string().optional(),
  cwd: z.string().optional(),
  profile: z.string().optional(),
  permissions: z.string().optional(),
  task: z.string().optional(),
});
type ToolArgs = z.infer<typeof toolArgsSchema>;

/** Native labels carry JSON arguments; older labels carry arguments already formatted by Core. */
export function decodeToolLabelArgs(args: string): ToolArgs | undefined {
  if (!args.startsWith("{")) return undefined;
  const value = Result.try({ try: () => JSON.parse(args), catch: () => undefined }).match({
    ok: (value) => value,
    err: () => undefined,
  });
  const parsed = toolArgsSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

const toolsInvocation = /^tools\s+([\w.-]+)(?:\s+([\s\S]*))?$/;

/** Only the first `tools` call counts, so trailing commands do not change how the row reads. */
function toolsCall(part: ActivityPart): { callable: string; rest: string } | undefined {
  const match = toolsInvocation.exec(activityCommand(part));
  return match ? { callable: match[1]!, rest: match[2] ?? "" } : undefined;
}

function unquote(token: string): string {
  return token.replace(
    /'([^']*)'|"((?:[^"\\]|\\.)*)"/g,
    (_match, single: string | undefined, double: string | undefined) =>
      single ?? double?.replace(/\\(.)/g, "$1") ?? "",
  );
}

/** The query or URL the first `tools web.*` call receives, positionally or as `--query=`/`--url=`. */
function webTarget(rest: string): string | undefined {
  // Sticky matching stops at the first `;`, `&`, or `|` outside quotes.
  const tokens = /\s*((?:[^\s;&|'"]|'[^']*'|"(?:[^"\\]|\\.)*")+)/y;
  for (let match = tokens.exec(rest); match; match = tokens.exec(rest)) {
    const token = match[1]!;
    const named = /^--(?:query|url)=([\s\S]*)$/.exec(token);
    if (named) return unquote(named[1]!);
    if (token.startsWith("-")) continue;
    return unquote(token);
  }
  return undefined;
}

export function activityRowKind(part: ActivityPart): ActivityRowKind {
  if (part.data.kind !== "tool") return part.data.kind;
  const { name } = parseToolLabel(part.data.label);
  const known = toolKinds[name];
  if (known === "command") {
    const callable = toolsCall(part)?.callable;
    if (callable === "fetch" || callable === "search" || callable?.startsWith("web.")) return "web";
  }
  if (known) return known;
  return /(^|[._])(web|fetch|browse|url)([._]|$)/i.test(name) ? "web" : "tool";
}

/** The subagent profile in a legacy progress label or a native `subagent_delegate` label. */
/**
 * Core caps labels at 256 characters but keeps the same `<tool> <JSON args>` text in the detail
 * up to 8192, so long arguments only decode from the detail.
 */
function toolCallArgs(part: ActivityPart): { name: string; args: ToolArgs | undefined } {
  const { name, args } = parseToolLabel(part.data.label);
  const detail = parseToolLabel(part.data.detail ?? "");
  const fromDetail = detail.name === name ? decodeToolLabelArgs(detail.args) : undefined;
  return { name, args: fromDetail ?? decodeToolLabelArgs(args) };
}

export function subagentLabelProfile(part: ActivityPart): string | undefined {
  const labeled = /^subagent(?:_delegate)? \(([a-z][a-z0-9_-]*)(?:[;,]|\))/.exec(
    part.data.label,
  )?.[1];
  if (labeled) return labeled;
  const { name, args } = toolCallArgs(part);
  if (name !== "subagent_delegate") return undefined;
  // Calls recorded before permission profiles name the role in `profile`.
  return args?.permissions ?? args?.profile;
}

/** Thinking only has something to show once its reasoning text arrives. */
export function activityVisible(part: ActivityPart): boolean {
  return part.data.kind !== "thinking" || !!part.data.detail?.trim();
}

export function flattenMarkdown(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}(?:#{1,6}|>|[-*+]|\d+[.)])\s+/gm, "")
    .replace(/[*_~`]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Unwraps `bash -lc '<script>'` style invocations to the script they run. */
export function unwrapShellCommand(command: string): string {
  // Only a single quoted script argument unwraps; `sh -c 'a' && b` keeps its outer command.
  const match =
    /^(?:\S*\/)?(?:ba|z|da|k)?sh\s+-[a-z]*c[a-z]*\s+(?:'([^']*)'|"((?:[^"\\]|\\.)*)")$/.exec(
      command.trim(),
    );
  return (match?.[1] ?? match?.[2])?.trim() || command.trim();
}

/** The full command a bash activity ran, with its original whitespace, for the expanded view. */
export function activityCommand(part: ActivityPart): string {
  return unwrapShellCommand(parseToolLabel(part.data.detail ?? part.data.label).args);
}

/** The one-line command from the label, which keeps a remote command's `@host:path` prefix. */
function commandLine(part: ActivityPart): string {
  const args = parseToolLabel(part.data.label).args;
  const remote = /^(@\S+:\S*\s+)([\s\S]*)$/.exec(args);
  return oneLine(
    remote ? `${remote[1]}${unwrapShellCommand(remote[2]!)}` : unwrapShellCommand(args),
  );
}

export function commandProgramName(command: string): string {
  const local = command.replace(/^@\S+:\S*\s+/, "");
  const segments = local.split(/&&|\|\||;|\|/);
  for (const segment of segments) {
    const tokens = segment.trim().split(/\s+/).filter(Boolean);
    while (
      tokens[0] &&
      (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0]) || /^(sudo|env|time|exec)$/.test(tokens[0]))
    )
      tokens.shift();
    const program = tokens[0]?.replace(/^['"]|['"]$/g, "");
    if (!program || program === "cd") continue;
    return program.split("/").at(-1) || program;
  }
  return oneLine(local);
}

function located(subject: string | undefined, location: string | undefined): string | undefined {
  if (!subject) return undefined;
  return location ? `${subject} in ${location}` : subject;
}

function toolArgsTitle(name: string, args: ToolArgs): string | undefined {
  switch (name) {
    case "read":
    case "read_file":
    case "readFile":
      return args.path;
    case "glob":
      return located(args.patterns?.join(", "), args.cwd);
    case "grep":
      return located(args.pattern, args.path);
    case "fuzzy_search":
      return located(args.query, args.cwd);
    case "subagent_delegate":
      return args.task;
    default:
      return undefined;
  }
}

function toolTitle(part: ActivityPart): string {
  const { name, args } = toolCallArgs(part);
  const title = args ? toolArgsTitle(name, args) : undefined;
  return oneLine(title ?? part.data.label);
}

function editTitle(part: ActivityPart): string {
  const { paths, others } = activityEditedPaths(part);
  const extra = paths.length - 1 + others;
  if (!paths[0]) return oneLine(part.data.label);
  return extra > 0 ? `${paths[0]} (+${extra})` : paths[0];
}

function webTitle(part: ActivityPart): string {
  const call = toolsCall(part);
  if (!call) return toolTitle(part);
  return oneLine(webTarget(call.rest) ?? call.callable);
}

export function activityRowTitle(part: ActivityPart): string {
  switch (activityRowKind(part)) {
    case "thinking":
      return flattenMarkdown(part.data.detail ?? "") || "Thought";
    case "command":
      return commandLine(part) || oneLine(part.data.label);
    case "edit":
      return editTitle(part);
    case "web":
      return webTitle(part);
    case "workflow":
    case "agent":
    case "read":
    case "search":
    case "tool":
      return toolTitle(part);
  }
}

export function liveActivityLabel(part: ActivityPart): string {
  switch (activityRowKind(part)) {
    case "thinking":
      return "Thinking";
    case "command":
      return `Running ${commandProgramName(commandLine(part))}`;
    case "workflow":
    case "agent":
    case "read":
    case "search":
    case "edit":
    case "web":
    case "tool":
      return activityRowTitle(part);
  }
}

const categoryPriority: Record<ActivityRowKind, number> = {
  command: 0,
  edit: 0,
  agent: 0,
  read: 1,
  search: 1,
  web: 1,
  workflow: 1,
  tool: 2,
  thinking: 3,
};

/**
 * Edit details list every changed path, one per line. Older parts repeat the label as their detail;
 * the label names one path and adds ` (+N)` for the other files a patch changes.
 */
export function activityEditedPaths(part: ActivityPart): { paths: string[]; others: number } {
  if (part.data.detail && part.data.detail !== part.data.label) {
    const paths = parseToolLabel(part.data.detail).args.split("\n").filter(Boolean);
    return { paths, others: 0 };
  }
  const { args } = parseToolLabel(part.data.label);
  const decoded = decodeToolLabelArgs(args);
  if (decoded) return { paths: decoded.path ? [decoded.path] : [], others: 0 };
  const match = /^(.*?)(?: \(\+(\d+)\))?$/.exec(args);
  return { paths: match?.[1] ? [match[1]] : [], others: Number(match?.[2] ?? 0) };
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

function categoryClause(kind: ActivityRowKind, count: number): string {
  switch (kind) {
    case "command":
      return `Ran ${plural(count, "command", "commands")}`;
    case "edit":
      return `Changed ${plural(count, "file", "files")}`;
    case "agent":
      return `Spawned ${plural(count, "agent", "agents")}`;
    case "read":
      return `Read ${plural(count, "file", "files")}`;
    case "search":
      return `Searched code ${plural(count, "time", "times")}`;
    case "web":
      return `Searched the web ${plural(count, "time", "times")}`;
    case "workflow":
      return `Ran ${plural(count, "workflow", "workflows")}`;
    case "tool":
    case "thinking":
      return `Used ${plural(count, "tool", "tools")}`;
  }
}

function joinClauses(clauses: string[]): string {
  const lowered = clauses.map((clause, index) =>
    index === 0 ? clause : clause.charAt(0).toLowerCase() + clause.slice(1),
  );
  if (lowered.length <= 2) return lowered.join(" and ");
  return `${lowered.slice(0, -1).join(", ")}, and ${lowered.at(-1)}`;
}

/**
 * Summarizes a group by its two most significant action categories, in their original order.
 * Reasoning never counts as an action.
 */
export function activityGroupSummary(
  parts: readonly ActivityPart[],
  kindOf: (part: ActivityPart) => ActivityRowKind = activityRowKind,
): string {
  const counts = new Map<ActivityRowKind, number>();
  const editedPaths = new Set<string>();
  for (const part of parts) {
    const kind = kindOf(part);
    if (kind === "thinking") continue;
    if (kind !== "edit") {
      counts.set(kind, (counts.get(kind) ?? 0) + 1);
      continue;
    }
    const { paths, others } = activityEditedPaths(part);
    const added = paths.filter((path) => !editedPaths.has(path)).length;
    for (const path of paths) editedPaths.add(path);
    counts.set(kind, (counts.get(kind) ?? 0) + (paths.length ? added + others : 1));
  }
  if (!counts.size) return parts.length > 1 ? `Thought (×${parts.length})` : "Thought";
  const ordered = [...counts.keys()];
  const selected = new Set(
    [...ordered]
      .sort((left, right) => categoryPriority[left] - categoryPriority[right])
      .slice(0, 2),
  );
  const clauses = ordered
    .filter((kind) => selected.has(kind))
    .map((kind) => categoryClause(kind, counts.get(kind)!));
  const omitted = ordered
    .filter((kind) => !selected.has(kind))
    .reduce((total, kind) => total + counts.get(kind)!, 0);
  if (omitted) clauses.push(`Performed ${plural(omitted, "other action", "other actions")}`);
  return joinClauses(clauses);
}

export function activityGroupKind(
  parts: readonly ActivityPart[],
  kindOf: (part: ActivityPart) => ActivityRowKind = activityRowKind,
): ActivityRowKind | "mixed" {
  const kinds = new Set(parts.map(kindOf).filter((kind) => kind !== "thinking"));
  if (!kinds.size) return "thinking";
  return kinds.size === 1 ? [...kinds][0]! : "mixed";
}

export function formatActivityOutput(output: string): string {
  const trimmed = output.trim();
  if (!/^[[{]/.test(trimmed)) return output;
  return Result.try({
    try: () => JSON.stringify(JSON.parse(trimmed), null, 2),
    catch: () => output,
  }).unwrapOr(output);
}

export function formatDuration(duration: number): string {
  const total = Math.floor(duration / 1000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours) return `${hours}h${minutes ? ` ${minutes}m` : ""}`;
  if (minutes) return `${minutes}m${seconds ? ` ${seconds}s` : ""}`;
  return `${seconds}s`;
}
