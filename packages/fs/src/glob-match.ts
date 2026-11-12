import { matchesGlob } from "node:path";

const HIDDEN_DOT = "\u0001";

function maskLeadingDots(value: string): string {
  return value.replace(/(^|\/)\./gu, `$1${HIDDEN_DOT}`);
}

/**
 * Matches like Bun's `path.matchesGlob`, where wildcards also match dot-prefixed segments.
 *
 * Node's implementation skips those segments unless the pattern spells out the dot. Core runs
 * on Bun while the remote fs runner usually runs on Node, so the same glob returned dotfiles
 * locally and dropped them over SSH. Masking each leading dot on both sides gives Node the Bun
 * result without changing it on Bun.
 */
export function matchesGlobWithDotfiles(path: string, pattern: string): boolean {
  return matchesGlob(path, pattern) || matchesGlob(maskLeadingDots(path), maskLeadingDots(pattern));
}
