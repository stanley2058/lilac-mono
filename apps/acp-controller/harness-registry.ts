import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

import type { HarnessDescriptor, ResolvedHarness } from "./types.ts";

const BUILTIN_HARNESSES: readonly HarnessDescriptor[] = [
  {
    id: "opencode",
    title: "OpenCode",
    description: "OpenCode ACP harness",
    launchCandidates: [{ command: "opencode", args: ["acp"], source: "path" }],
    installHint: "Install OpenCode so `opencode acp` is available on PATH.",
  },
  {
    id: "codex-acp",
    title: "Codex ACP",
    description: "Codex ACP harness",
    launchCandidates: [{ command: "codex-acp", args: [], source: "path" }],
    installHint: "Install `codex-acp` on PATH or run `npx @zed-industries/codex-acp` manually.",
  },
  {
    id: "claude-acp",
    title: "Claude ACP",
    description: "Claude ACP harness",
    launchCandidates: [{ command: "claude-agent-acp", args: [], source: "path" }],
    installHint:
      "Install `claude-agent-acp` on PATH or run `npx @zed-industries/claude-agent-acp` manually.",
  },
  {
    id: "cursor",
    title: "Cursor",
    description: "Cursor ACP harness",
    launchCandidates: [{ command: "cursor-agent", args: ["acp"], source: "path" }],
    installHint: "Install Cursor Agent so `cursor-agent acp` is available on PATH.",
  },
];

function pathEntries(): string[] {
  const raw = process.env.PATH ?? "";
  return raw.split(path.delimiter).filter((entry) => entry.length > 0);
}

async function isExecutable(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function resolveCommand(command: string): Promise<string | null> {
  if (command.includes(path.sep)) {
    return (await isExecutable(command)) ? command : null;
  }

  const extensions =
    process.platform === "win32"
      ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM")
          .split(";")
          .filter((entry) => entry.length > 0)
      : [""];

  for (const entry of pathEntries()) {
    for (const extension of extensions) {
      const fullPath = path.join(
        entry,
        process.platform === "win32" ? `${command}${extension}` : command,
      );
      if (await isExecutable(fullPath)) return fullPath;
    }
  }

  return null;
}

export function listBuiltinHarnesses(): readonly HarnessDescriptor[] {
  return BUILTIN_HARNESSES;
}

export function getHarnessDescriptor(harnessId: string): HarnessDescriptor | null {
  return BUILTIN_HARNESSES.find((entry) => entry.id === harnessId) ?? null;
}

export async function resolveHarness(harnessId: string): Promise<ResolvedHarness | null> {
  const descriptor = getHarnessDescriptor(harnessId);
  if (!descriptor) return null;

  for (const candidate of descriptor.launchCandidates) {
    const resolvedCommand = await resolveCommand(candidate.command);
    if (!resolvedCommand) continue;
    return {
      descriptor,
      command: resolvedCommand,
      args: candidate.args,
      source: candidate.source,
    };
  }

  return null;
}

export async function listResolvedHarnesses(): Promise<
  Array<{
    descriptor: HarnessDescriptor;
    launchable: boolean;
    command?: string;
    args?: readonly string[];
    source?: "path" | "fallback";
  }>
> {
  const results: Array<{
    descriptor: HarnessDescriptor;
    launchable: boolean;
    command?: string;
    args?: readonly string[];
    source?: "path" | "fallback";
  }> = [];

  for (const descriptor of BUILTIN_HARNESSES) {
    const resolved = await resolveHarness(descriptor.id);
    if (resolved) {
      results.push({
        descriptor,
        launchable: true,
        command: resolved.command,
        args: resolved.args,
        source: resolved.source,
      });
      continue;
    }
    results.push({ descriptor, launchable: false });
  }

  return results;
}
