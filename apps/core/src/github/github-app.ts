import path from "node:path";
import fs from "node:fs/promises";
import { z } from "zod";

const githubAppSecretSchema = z.object({
  type: z.literal("github_app"),
  appId: z.coerce.number().int().positive(),
  installationId: z.coerce.number().int().positive(),
  /** Optional; used for gh (GH_HOST) and/or to derive apiBaseUrl. */
  host: z.string().min(1).optional(),
  /** Optional; used to mint tokens against GHES. Example: https://github.example.com/api/v3 */
  apiBaseUrl: z.url().optional(),
  /** Absolute path to the stored private key pem file. */
  privateKeyPath: z.string().min(1),
});

export type GithubAppSecret = z.infer<typeof githubAppSecretSchema>;

export function resolveGithubAppSecretPaths(dataDir: string): {
  jsonPath: string;
  pemPath: string;
} {
  const secretDir = path.join(dataDir, "secret");
  return {
    jsonPath: path.join(secretDir, "github-app.json"),
    pemPath: path.join(secretDir, "github-app.private-key.pem"),
  };
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

export function deriveApiBaseUrl(input: { host?: string; apiBaseUrl?: string }): string {
  if (input.apiBaseUrl) return input.apiBaseUrl;
  const host = input.host;
  if (!host || host === "github.com") return "https://api.github.com";
  return `https://${host.replace(/^https?:\/\//, "")}/api/v3`;
}

export async function readGithubAppSecret(dataDir: string): Promise<GithubAppSecret | null> {
  const { jsonPath } = resolveGithubAppSecretPaths(dataDir);
  const file = Bun.file(jsonPath);
  if (!(await file.exists())) return null;

  const raw: unknown = await file.json().catch(() => null as unknown);
  if (!raw || typeof raw !== "object") return null;

  return githubAppSecretSchema.parse(raw);
}

export async function writeGithubAppSecret(params: {
  dataDir: string;
  appId: number;
  installationId: number;
  host?: string;
  apiBaseUrl?: string;
  /** Raw PEM content. */
  privateKeyPem: string;
}): Promise<{ jsonPath: string; pemPath: string; overwritten: boolean }> {
  await ensureSecretDir(params.dataDir);
  const { jsonPath, pemPath } = resolveGithubAppSecretPaths(params.dataDir);
  const existed = await Bun.file(jsonPath).exists();

  await fs.writeFile(pemPath, params.privateKeyPem, "utf8");
  await chmod0600(pemPath);

  const secret: GithubAppSecret = {
    type: "github_app",
    appId: params.appId,
    installationId: params.installationId,
    host: params.host,
    apiBaseUrl: params.apiBaseUrl,
    privateKeyPath: pemPath,
  };

  await fs.writeFile(jsonPath, JSON.stringify(secret, null, 2), "utf8");
  await chmod0600(jsonPath);

  return { jsonPath, pemPath, overwritten: existed };
}

export async function clearGithubAppSecret(dataDir: string): Promise<void> {
  const { jsonPath, pemPath } = resolveGithubAppSecretPaths(dataDir);
  await fs.rm(jsonPath, { force: true }).catch(() => undefined);
  await fs.rm(pemPath, { force: true }).catch(() => undefined);
}

export async function readGithubAppPrivateKeyPem(secret: GithubAppSecret): Promise<string> {
  const raw = await Bun.file(secret.privateKeyPath).text();
  if (!raw.trim()) {
    throw new Error(`GitHub App private key is empty: ${secret.privateKeyPath}`);
  }
  return raw;
}
