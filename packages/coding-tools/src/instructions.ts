import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";

import { expandTilde } from "@stanley2058/lilac-fs";
import { z } from "zod";

const INSTRUCTION_FILENAMES = ["AGENTS.md"] as const;
const MAX_INSTRUCTION_CHARS = 20_000;

const toolMessageSchema = z
  .object({
    role: z.literal("tool"),
    content: z.array(z.unknown()),
  })
  .passthrough();

const readFileToolResultSchema = z
  .object({
    type: z.literal("tool-result"),
    toolName: z.literal("read_file"),
    output: z.unknown(),
  })
  .passthrough();

const jsonToolOutputSchema = z
  .object({
    type: z.literal("json"),
    value: z
      .object({
        loadedInstructions: z.array(z.string()).optional(),
        instructionsText: z.string().optional(),
      })
      .passthrough(),
  })
  .passthrough();

const contentToolOutputSchema = z
  .object({
    type: z.literal("content"),
    value: z.array(z.unknown()),
  })
  .passthrough();

const textContentPartSchema = z
  .object({
    type: z.literal("text"),
    text: z.string(),
  })
  .passthrough();

export const READ_FILE_INSTRUCTION_HINT =
  "Applicable AGENTS.md files are automatically included in successful local read results.";

export type LoadedInstructionContext = {
  loaded: string[];
  text: string;
};

export type ReadFileInstructionClaims = {
  forMessages(messages: readonly unknown[]): Set<string>;
};

export type InstructionLoadOptions = {
  denyPaths?: readonly string[];
  claimedInstructionPaths?: Set<string>;
};

export function createReadFileInstructionClaims(): ReadFileInstructionClaims {
  let currentMessages: readonly unknown[] | undefined;
  let currentMessageCount = -1;
  let paths = new Set<string>();

  return {
    forMessages(messages) {
      if (messages !== currentMessages || messages.length !== currentMessageCount) {
        currentMessages = messages;
        currentMessageCount = messages.length;
        paths = new Set();
      }
      return paths;
    },
  };
}

function isPathWithin(candidatePath: string, parentDir: string): boolean {
  const relative = path.relative(parentDir, candidatePath);
  if (relative === "") return true;
  if (relative === "..") return false;
  if (relative.startsWith(`..${path.sep}`)) return false;
  return !path.isAbsolute(relative);
}

async function pathExists(candidatePath: string): Promise<boolean> {
  try {
    await stat(candidatePath);
    return true;
  } catch {
    return false;
  }
}

async function canonicalPath(candidatePath: string): Promise<string> {
  const absolute = path.resolve(expandTilde(candidatePath));
  try {
    return await realpath(absolute);
  } catch {
    return absolute;
  }
}

async function canonicalPaths(paths: Iterable<string>): Promise<Set<string>> {
  return new Set(await Promise.all([...paths].map(canonicalPath)));
}

function isDenied(candidatePath: string, denyPaths: ReadonlySet<string>): boolean {
  for (const denyPath of denyPaths) {
    if (isPathWithin(candidatePath, denyPath)) return true;
  }
  return false;
}

async function findGitRoot(startDirectory: string): Promise<string | null> {
  let current = path.resolve(startDirectory);
  while (true) {
    if (await pathExists(path.join(current, ".git"))) return current;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

async function readInstructionFile(filePath: string): Promise<string | null> {
  try {
    const content = (await readFile(filePath, "utf8")).trim();
    if (!content) return null;
    if (content.length <= MAX_INSTRUCTION_CHARS) return content;
    return `${content.slice(0, MAX_INSTRUCTION_CHARS)}\n... (truncated)`;
  } catch {
    return null;
  }
}

function parseInstructionPathsFromText(text: string): string[] {
  const paths: string[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("Instructions from:")) continue;
    const instructionPath = trimmed.slice("Instructions from:".length).trim();
    if (instructionPath.length > 0) paths.push(instructionPath);
  }
  return paths;
}

function collectPreviouslyLoadedInstructionPaths(messages: readonly unknown[]): Set<string> {
  const paths = new Set<string>();

  for (const message of messages) {
    const parsedMessage = toolMessageSchema.safeParse(message);
    if (!parsedMessage.success) continue;

    for (const part of parsedMessage.data.content) {
      const parsedPart = readFileToolResultSchema.safeParse(part);
      if (!parsedPart.success) continue;

      const jsonOutput = jsonToolOutputSchema.safeParse(parsedPart.data.output);
      if (jsonOutput.success) {
        for (const loadedPath of jsonOutput.data.value.loadedInstructions ?? []) {
          paths.add(loadedPath);
        }
        for (const loadedPath of parseInstructionPathsFromText(
          jsonOutput.data.value.instructionsText ?? "",
        )) {
          paths.add(loadedPath);
        }
        continue;
      }

      const contentOutput = contentToolOutputSchema.safeParse(parsedPart.data.output);
      if (!contentOutput.success) continue;
      for (const contentPart of contentOutput.data.value) {
        const textPart = textContentPartSchema.safeParse(contentPart);
        if (!textPart.success) continue;
        for (const loadedPath of parseInstructionPathsFromText(textPart.data.text)) {
          paths.add(loadedPath);
        }
      }
    }
  }

  return paths;
}

async function loadInstructionsBetween(params: {
  startDirectory: string;
  boundaryDirectory: string;
  alreadyLoaded: Set<string>;
  denyPaths: ReadonlySet<string>;
  claimedInstructionPaths?: Set<string>;
}): Promise<LoadedInstructionContext | null> {
  const loaded: string[] = [];
  const snippets: string[] = [];
  let current = params.startDirectory;

  while (true) {
    for (const name of INSTRUCTION_FILENAMES) {
      const candidate = path.join(current, name);
      if (!(await pathExists(candidate))) continue;
      const canonicalCandidate = await canonicalPath(candidate);
      if (!isPathWithin(canonicalCandidate, params.boundaryDirectory)) continue;
      if (isDenied(canonicalCandidate, params.denyPaths)) continue;
      if (
        params.alreadyLoaded.has(canonicalCandidate) ||
        params.claimedInstructionPaths?.has(canonicalCandidate)
      ) {
        continue;
      }

      params.claimedInstructionPaths?.add(canonicalCandidate);

      const content = await readInstructionFile(canonicalCandidate);
      if (!content) {
        params.claimedInstructionPaths?.delete(canonicalCandidate);
        continue;
      }

      loaded.push(canonicalCandidate);
      params.alreadyLoaded.add(canonicalCandidate);
      snippets.push(`Instructions from: ${canonicalCandidate}\n${content}`);
    }

    if (current === params.boundaryDirectory) break;
    const parent = path.dirname(current);
    if (parent === current || !isPathWithin(parent, params.boundaryDirectory)) break;
    current = parent;
  }

  if (loaded.length === 0) return null;
  return { loaded, text: snippets.join("\n\n") };
}

export async function loadWorkspaceInstructions(
  cwd: string,
  options: InstructionLoadOptions = {},
): Promise<LoadedInstructionContext | null> {
  const cwdAbsolute = await canonicalPath(cwd);
  const boundaryDirectory = (await findGitRoot(cwdAbsolute)) ?? cwdAbsolute;
  return loadInstructionsBetween({
    startDirectory: cwdAbsolute,
    boundaryDirectory,
    alreadyLoaded: new Set(),
    denyPaths: await canonicalPaths(options.denyPaths ?? []),
    claimedInstructionPaths: options.claimedInstructionPaths,
  });
}

export async function loadReadFileInstructions(params: {
  resolvedPath: string;
  requestedPath?: string;
  cwd: string;
  messages: readonly unknown[];
  preloadedInstructionPaths?: readonly string[];
  denyPaths?: readonly string[];
  claimedInstructionPaths?: Set<string>;
}): Promise<LoadedInstructionContext | null> {
  if (
    (INSTRUCTION_FILENAMES as readonly string[]).includes(
      path.basename(params.requestedPath ?? params.resolvedPath),
    )
  ) {
    return null;
  }
  const targetAbsolute = await canonicalPath(params.resolvedPath);
  if ((INSTRUCTION_FILENAMES as readonly string[]).includes(path.basename(targetAbsolute))) {
    return null;
  }

  const cwdAbsolute = await canonicalPath(params.cwd);
  const boundaryCwd = isPathWithin(targetAbsolute, cwdAbsolute) ? cwdAbsolute : null;
  const boundaryDirectory = boundaryCwd ?? (await findGitRoot(cwdAbsolute));
  if (!boundaryDirectory || !isPathWithin(targetAbsolute, boundaryDirectory)) return null;

  const alreadyLoaded = await canonicalPaths([
    ...collectPreviouslyLoadedInstructionPaths(params.messages),
    ...(params.preloadedInstructionPaths ?? []),
  ]);

  const instructions = await loadInstructionsBetween({
    startDirectory: path.dirname(targetAbsolute),
    boundaryDirectory,
    alreadyLoaded,
    denyPaths: await canonicalPaths(params.denyPaths ?? []),
    claimedInstructionPaths: params.claimedInstructionPaths,
  });
  if (!instructions) return null;

  return {
    loaded: instructions.loaded,
    text: ["<system-reminder>", instructions.text, "</system-reminder>"].join("\n"),
  };
}
