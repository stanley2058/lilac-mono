import path from "node:path";
import fs from "node:fs/promises";
import { z } from "zod";

const githubUserTokenSecretSchema = z.object({
  type: z.literal("github_user_token"),
  token: z.string().min(1),
  /** Optional; used for gh (GH_HOST) and/or to derive apiBaseUrl. */
  host: z.string().min(1).optional(),
  /** Optional; used for GHES. Example: https://github.example.com/api/v3 */
  apiBaseUrl: z.url().optional(),
  /** Optional cached login from onboarding test/configure flow. */
  login: z.string().min(1).optional(),
});

export type GithubUserTokenSecret = z.infer<typeof githubUserTokenSecretSchema>;

export function resolveGithubUserTokenSecretPath(dataDir: string): string {
  return path.join(dataDir, "secret", "github-user-token.json");
}

async function ensureSecretDir(dataDir: string): Promise<void> {
  await fs.mkdir(path.join(dataDir, "secret"), { recursive: true });
}

async function chmod0600(p: string): Promise<void> {
  try {
    await fs.chmod(p, 0o600);
  } catch {
    // Best-effort.
  }
}

export async function readGithubUserTokenSecret(
  dataDir: string,
): Promise<GithubUserTokenSecret | null> {
  const jsonPath = resolveGithubUserTokenSecretPath(dataDir);
  const file = Bun.file(jsonPath);
  if (!(await file.exists())) return null;

  const raw: unknown = await file.json().catch(() => null as unknown);
  if (!raw || typeof raw !== "object") return null;

  return githubUserTokenSecretSchema.parse(raw);
}

export async function writeGithubUserTokenSecret(params: {
  dataDir: string;
  token: string;
  host?: string;
  apiBaseUrl?: string;
  login?: string;
}): Promise<{ jsonPath: string; overwritten: boolean }> {
  await ensureSecretDir(params.dataDir);
  const jsonPath = resolveGithubUserTokenSecretPath(params.dataDir);
  const existed = await Bun.file(jsonPath).exists();

  const secret = githubUserTokenSecretSchema.parse({
    type: "github_user_token",
    token: params.token.trim(),
    host: params.host,
    apiBaseUrl: params.apiBaseUrl,
    login: params.login,
  }) satisfies GithubUserTokenSecret;

  await fs.writeFile(jsonPath, JSON.stringify(secret, null, 2), "utf8");
  await chmod0600(jsonPath);

  return { jsonPath, overwritten: existed };
}

export async function clearGithubUserTokenSecret(dataDir: string): Promise<void> {
  const jsonPath = resolveGithubUserTokenSecretPath(dataDir);
  await fs.rm(jsonPath, { force: true }).catch(() => undefined);
}
