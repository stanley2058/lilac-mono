import fs from "node:fs/promises";
import path from "node:path";

import { expandTilde } from "@stanley2058/lilac-fs";

export function assertGuardrailBypassAllowed(
  dangerouslyAllow: boolean | undefined,
  allowGuardrailBypass: boolean,
): void {
  if (dangerouslyAllow && !allowGuardrailBypass) {
    throw new Error(
      "dangerouslyAllow is disabled for this toolset; set allowGuardrailBypass=true when constructing it",
    );
  }
}

export function assertLocalCwd(cwd: string): void {
  const trimmed = cwd.trim();
  const isWindowsDrivePath = /^[A-Za-z]:[\\/]/u.test(trimmed);
  if (!isWindowsDrivePath && /^[A-Za-z0-9_.@-]+:/u.test(trimmed)) {
    throw new Error(`The local coding-tools adapter does not support SSH cwd target '${cwd}'`);
  }
}

function getErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object" || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

export async function canonicalizeAsFarAsExists(inputPath: string): Promise<string> {
  let current = path.resolve(expandTilde(inputPath));
  const missingSegments: string[] = [];

  while (true) {
    try {
      const existing = await fs.realpath(current);
      return path.resolve(existing, ...missingSegments);
    } catch (error: unknown) {
      const code = getErrorCode(error);
      if (code !== "ENOENT" && code !== "ENOTDIR") throw error;

      const stats = await fs.lstat(current).catch(() => undefined);
      if (stats?.isSymbolicLink()) {
        const linkTarget = await fs.readlink(current);
        current = path.isAbsolute(linkTarget)
          ? path.resolve(linkTarget)
          : path.resolve(path.dirname(current), linkTarget);
        continue;
      }

      const parent = path.dirname(current);
      if (parent === current) return path.resolve(current, ...missingSegments);
      missingSegments.unshift(path.basename(current));
      current = parent;
    }
  }
}

export async function assertCanonicalPathAllowed(
  targetPath: string,
  denyPaths: readonly string[],
  operation: string,
  dangerouslyAllow = false,
): Promise<void> {
  if (dangerouslyAllow) return;
  const canonicalTarget = await canonicalizeAsFarAsExists(targetPath);
  for (const denyPath of denyPaths) {
    const canonicalDenyPath = await canonicalizeAsFarAsExists(denyPath);
    if (
      canonicalTarget === canonicalDenyPath ||
      canonicalTarget.startsWith(`${canonicalDenyPath}${path.sep}`)
    ) {
      throw new Error(
        `Access denied: '${targetPath}' resolves into protected path '${canonicalDenyPath}' for ${operation}`,
      );
    }
  }
}
