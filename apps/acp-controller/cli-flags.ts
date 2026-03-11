function toInt(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.trunc(parsed) : null;
  }
  return null;
}

function toBool(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true" || normalized === "1" || normalized === "yes") return true;
    if (normalized === "false" || normalized === "0" || normalized === "no") return false;
  }
  return null;
}

export function parseFlags(args: readonly string[]): {
  flags: Record<string, string | boolean>;
  positionals: string[];
} {
  const flags: Record<string, string | boolean> = {};
  const positionals: string[] = [];

  for (let index = 0; index < args.length; index++) {
    const value = args[index] ?? "";
    if (!value.startsWith("--")) {
      positionals.push(value);
      continue;
    }

    if (value.startsWith("--no-")) {
      flags[value.slice("--no-".length)] = false;
      continue;
    }

    const equalsIndex = value.indexOf("=");
    if (equalsIndex !== -1) {
      flags[value.slice(2, equalsIndex)] = value.slice(equalsIndex + 1);
      continue;
    }

    const key = value.slice(2);
    const next = args[index + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags[key] = next;
      index++;
      continue;
    }

    flags[key] = true;
  }

  return { flags, positionals };
}

export function getStringFlag(
  flags: Record<string, string | boolean>,
  key: string,
): string | undefined {
  const value = flags[key];
  return typeof value === "string" ? value : undefined;
}

export function getBoolFlag(
  flags: Record<string, string | boolean>,
  key: string,
  defaultValue: boolean,
): boolean {
  const value = flags[key];
  if (value === undefined) return defaultValue;
  if (typeof value === "boolean") return value;
  return toBool(value) ?? defaultValue;
}

export function getIntFlag(
  flags: Record<string, string | boolean>,
  key: string,
  defaultValue: number,
): number {
  const value = flags[key];
  if (value === undefined) return defaultValue;
  return toInt(value) ?? defaultValue;
}

export async function readStdinText(): Promise<string> {
  if (process.stdin.isTTY) return "";

  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.from(chunk));
  }

  return Buffer.concat(chunks).toString("utf8");
}
