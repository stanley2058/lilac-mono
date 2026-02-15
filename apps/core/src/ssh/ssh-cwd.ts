import path from "node:path";

export type SshCwdTarget =
  | { kind: "local"; cwd?: string }
  | {
      kind: "ssh";
      host: string;
      /**
       * Remote working directory.
       * Always starts with "/" or "~" after normalization.
       */
      cwd: string;
    };

function isWindowsDrivePath(p: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(p);
}

function looksLikeSshHostAlias(host: string): boolean {
  const h = host.trim();
  if (h.length === 0) return false;
  if (h.includes("/") || h.includes("\\")) return false;
  if (/[\s]/.test(h)) return false;
  // Conservative: allow common ssh-config host aliases and user@host.
  // We intentionally do not support IPv6 literals here.
  return /^[A-Za-z0-9_.@-]+$/.test(h);
}

function normalizeTildeRelativePath(rel: string): string {
  const segs = rel.split("/");
  const out: string[] = [];
  for (const s of segs) {
    if (!s || s === ".") continue;
    if (s === "..") {
      // Clamp: never escape the virtual home root.
      if (out.length > 0) out.pop();
      continue;
    }
    out.push(s);
  }
  return out.join("/");
}

export function normalizeRemoteCwd(input: string): string {
  const trimmed = input.trim();
  if (trimmed.length === 0) return "~";

  if (trimmed.startsWith("/")) {
    return path.posix.normalize(trimmed);
  }

  if (trimmed === "~" || trimmed === "~/") return "~";
  if (trimmed.startsWith("~/")) {
    const rel = normalizeTildeRelativePath(trimmed.slice(2));
    return rel.length === 0 ? "~" : `~/${rel}`;
  }
  if (trimmed.startsWith("~")) {
    // Unsupported home-expansion forms like ~user; preserve as-is.
    return trimmed;
  }

  const rel = normalizeTildeRelativePath(trimmed);
  return rel.length === 0 ? "~" : `~/${rel}`;
}

/**
 * Parse a cwd string that may reference a remote host.
 *
 * Supported:
 * - local paths (default)
 * - ssh paths using scp-style cwd: "<host>:<path>"
 *   - path can be absolute (/..), tilde (~..), or relative (anchored to ~)
 */
export function parseSshCwdTarget(cwd?: string): SshCwdTarget {
  if (!cwd) return { kind: "local", cwd };

  const raw = cwd.trim();
  if (raw.length === 0) return { kind: "local", cwd: undefined };
  if (isWindowsDrivePath(raw)) return { kind: "local", cwd: raw };

  const idx = raw.indexOf(":");
  if (idx === -1) return { kind: "local", cwd: raw };

  const host = raw.slice(0, idx).trim();
  const rhs = raw.slice(idx + 1);
  if (host.length === 0) return { kind: "local", cwd: raw };
  if (!looksLikeSshHostAlias(host)) return { kind: "local", cwd: raw };

  return {
    kind: "ssh",
    host,
    cwd: normalizeRemoteCwd(rhs),
  };
}

/**
 * Map a remote cwd into a stable, fake absolute path for bash safety analysis.
 *
 * We can't know the remote user's real home path, but the analyzer mostly needs
 * a consistent absolute anchor so it can reason about "within cwd". We treat
 * "~" as "/__remote_home__".
 */
export function toBashSafetyCwdForRemote(remoteCwd: string): string {
  const c = normalizeRemoteCwd(remoteCwd);
  if (c.startsWith("/")) return c;
  if (c === "~") return "/__remote_home__";
  if (c.startsWith("~/")) return `/__remote_home__/${c.slice(2)}`;
  return `/__remote_home__/${c.replace(/^~\/?/, "")}`;
}

export function abbreviateSshHostForDisplay(host: string): string {
  const trimmed = host.trim();
  if (trimmed.length === 0) return "R";

  const at = trimmed.lastIndexOf("@");
  const hostOnly = at >= 0 ? trimmed.slice(at + 1) : trimmed;

  const slug = hostOnly
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  if (slug.length === 0) return "R";

  const parts = slug.split("-").filter((p) => p.length > 0);
  if (parts.length >= 2) {
    return `${parts[0]![0]}${parts[1]![0]}`.toUpperCase();
  }

  const first = parts[0] ?? "";
  if (first.length >= 2) return first.slice(0, 2).toUpperCase();
  if (first.length === 1) return first.toUpperCase();
  return "R";
}

export function formatRemoteDisplayPath(host: string, remotePath: string): string {
  const initials = abbreviateSshHostForDisplay(host);
  const normalizedPath = normalizeRemoteCwd(remotePath);
  return `@${initials}:${normalizedPath}`;
}
