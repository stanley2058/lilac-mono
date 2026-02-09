import { homedir } from "node:os";
import path from "node:path";

/**
 * Shared SSH config helpers used by both:
 * - Level 2 tool server SSH tools (ssh.run/ssh.probe)
 * - Level 1 tools that route operations via SSH when cwd looks like <host>:<path>
 */

function stripComment(line: string): string {
  const idx = line.indexOf("#");
  if (idx === -1) return line;
  return line.slice(0, idx);
}

export function resolveSshConfigPath(): string {
  const fromEnv = process.env.LILAC_SSH_CONFIG_PATH;
  if (fromEnv && fromEnv.trim().length > 0) return fromEnv;
  return path.join(homedir(), ".ssh", "config");
}

export function parseSshHostsFromConfigText(text: string): string[] {
  const hosts: string[] = [];
  const seen = new Set<string>();

  const lines = text.split(/\r?\n/g);
  for (const raw of lines) {
    const noComment = stripComment(raw).trim();
    if (!noComment) continue;

    const match = /^Host\s+(.+)$/i.exec(noComment);
    if (!match) continue;

    const rest = match[1] ?? "";
    const tokens = rest.split(/\s+/g).filter(Boolean);
    for (const t of tokens) {
      if (t.startsWith("!")) continue;
      if (t.includes("*") || t.includes("?")) continue;
      // Avoid advertising the global wildcard entry.
      if (t === "*") continue;
      if (!seen.has(t)) {
        seen.add(t);
        hosts.push(t);
      }
    }
  }

  return hosts;
}

export async function readConfiguredSshHosts(): Promise<{
  configPath: string;
  hosts: string[];
  exists: boolean;
  readError?: string;
}> {
  const configPath = resolveSshConfigPath();
  const file = Bun.file(configPath);
  const exists = await file.exists();
  if (!exists) return { configPath, hosts: [], exists: false };

  try {
    const text = await file.text();
    const hosts = parseSshHostsFromConfigText(text);
    return { configPath, hosts, exists: true };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { configPath, hosts: [], exists: true, readError: msg };
  }
}

export async function requireConfiguredSshHost(host: string): Promise<void> {
  const configured = await readConfiguredSshHosts();
  if (configured.readError) {
    throw new Error(
      `Failed to read SSH config at ${configured.configPath}: ${configured.readError}`,
    );
  }

  if (configured.hosts.length === 0) {
    throw new Error(
      `No SSH hosts are configured. Add host aliases to ${configured.configPath} (and ensure known_hosts + keys are configured), then retry.`,
    );
  }

  if (!configured.hosts.includes(host)) {
    throw new Error(
      `Unknown SSH host alias '${host}'. Add a Host entry to ${configured.configPath} or use ssh.hosts to see configured aliases.`,
    );
  }
}
