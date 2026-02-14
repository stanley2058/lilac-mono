import { $ } from "bun";
import { z } from "zod";
import path from "node:path";
import fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { createHash } from "node:crypto";

import {
  env,
  ensurePromptWorkspace,
  getCoreConfig,
  resolveCoreConfigPath,
  resolvePromptDir,
  seedCoreConfig,
} from "@stanley2058/lilac-utils";

import type { ServerTool } from "../types";
import { zodObjectToCliLines } from "./zod-cli";
import { chromium } from "playwright";

import {
  clearGithubAppSecret,
  deriveApiBaseUrl,
  readGithubAppSecret,
  writeGithubAppSecret,
} from "../../github/github-app";
import { getGithubInstallationTokenOrThrow } from "../../github/github-app-token";

const bootstrapInputSchema = z.object({
  dataDir: z.string().optional().describe("Override DATA_DIR for this call"),
  overwriteConfig: z
    .boolean()
    .optional()
    .default(false)
    .describe("Overwrite core-config.yaml if it exists"),
  overwritePrompts: z
    .boolean()
    .optional()
    .default(false)
    .describe("Overwrite prompt files under dataDir/prompts"),
});

const playwrightInputSchema = z.object({
  withDeps: z
    .boolean()
    .optional()
    .default(false)
    .describe("If true, attempts to install OS deps via Playwright (requires root)."),
});

const defaultsInputSchema = z.object({
  dataDir: z.string().optional().describe("Override DATA_DIR for this call"),
  overwriteSkills: z
    .boolean()
    .optional()
    .default(false)
    .describe("Overwrite default skill templates under DATA_DIR/skills"),
  network: z
    .boolean()
    .optional()
    .default(true)
    .describe("Allow downloading/installing tools from the network"),
  strict: z
    .boolean()
    .optional()
    .default(false)
    .describe("If true, fail the whole run on the first error"),
});

const reloadConfigInputSchema = z.object({
  mode: z
    .enum(["cache", "restart"])
    .optional()
    .default("cache")
    .describe("cache: force reload config cache; restart: exit process for supervisor restart"),
});

const vcsEnvInputSchema = z.object({
  dataDir: z.string().optional().describe("Override DATA_DIR for this call"),
});

const gitIdentityInputSchema = z.object({
  dataDir: z.string().optional().describe("Override DATA_DIR for this call"),
  mode: z
    .enum(["status", "configure", "test", "clear"])
    .optional()
    .default("status")
    .describe(
      "status: show git identity; configure: persist identity; test: create a temp repo and commit; clear: remove identity keys",
    ),
  userName: z.string().min(1).optional().describe("Git user.name"),
  userEmail: z.string().min(1).optional().describe("Git user.email"),
  enableSigning: z
    .boolean()
    .optional()
    .default(false)
    .describe("If true, configure commit/tag signing via GPG"),
  signingKey: z
    .string()
    .min(1)
    .optional()
    .describe("GPG signing key fingerprint (user.signingkey)"),
});

const gnupgInputSchema = z.object({
  dataDir: z.string().optional().describe("Override DATA_DIR for this call"),
  mode: z
    .enum(["status", "generate", "export_public", "clear"])
    .optional()
    .default("status")
    .describe(
      "status: show key info; generate: create a no-passphrase key; export_public: export ASCII-armored public key; clear: delete GNUPGHOME",
    ),
  userName: z.string().min(1).optional().describe("Key user name"),
  userEmail: z.string().min(1).optional().describe("Key user email"),
  uidComment: z.string().optional().describe("Optional UID comment (for display only)"),
  fingerprint: z
    .string()
    .min(1)
    .optional()
    .describe("Fingerprint to export (default: first secret key)"),
});

const githubAppInputSchema = z.object({
  dataDir: z.string().optional().describe("Override DATA_DIR for this call"),
  mode: z
    .enum(["status", "configure", "test", "clear"])
    .optional()
    .default("status")
    .describe(
      "status: show config; configure: persist GitHub App credentials; test: mint token and call GitHub API; clear: remove stored secret",
    ),
  appId: z.coerce.number().int().positive().optional().describe("GitHub App ID"),
  installationId: z.coerce
    .number()
    .int()
    .positive()
    .optional()
    .describe("GitHub App installation ID"),
  host: z.string().min(1).optional().describe("GitHub host (github.com or your GHES host)"),
  apiBaseUrl: z
    .url()
    .optional()
    .describe(
      "GitHub API base URL (default: https://api.github.com; GHES example: https://github.example.com/api/v3)",
    ),
  privateKeyPem: z.string().min(1).optional().describe("GitHub App private key PEM contents"),
  privateKeyPath: z
    .string()
    .min(1)
    .optional()
    .describe("Path to a GitHub App private key PEM file"),
});

const allInputSchema = z.object({
  dataDir: z.string().optional().describe("Override DATA_DIR for this call"),
  overwriteConfig: z.boolean().optional().default(false),
  overwritePrompts: z.boolean().optional().default(false),
  overwriteSkills: z.boolean().optional().default(false),
  playwrightWithDeps: z.boolean().optional().default(false),
  restart: z.boolean().optional().default(false).describe("If true, exits the process at the end"),
});

async function pathExecutable(p: string): Promise<boolean> {
  try {
    await fs.access(p, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function findSystemChromiumExecutable(): Promise<string | null> {
  const fromEnv = process.env.LILAC_CHROMIUM_PATH ?? process.env.CHROMIUM_PATH ?? null;
  if (fromEnv && (await pathExecutable(fromEnv))) return fromEnv;

  const fromWhich =
    Bun.which("chromium") ??
    Bun.which("chromium-browser") ??
    Bun.which("google-chrome") ??
    Bun.which("google-chrome-stable") ??
    null;

  if (fromWhich && (await pathExecutable(fromWhich))) return fromWhich;

  const candidates = [
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
  ];
  for (const c of candidates) {
    if (await pathExecutable(c)) return c;
  }

  return null;
}

function isRootUser(): boolean {
  try {
    return typeof process.getuid === "function" && process.getuid() === 0;
  } catch {
    return false;
  }
}

async function ensurePlaywrightChromiumInstalled(options: {
  withDeps: boolean;
}): Promise<{ installed: boolean; executablePath: string }> {
  const pwPath = chromium.executablePath();
  const exists = await Bun.file(pwPath).exists();
  if (exists) {
    return { installed: false, executablePath: pwPath };
  }

  if (options.withDeps && !isRootUser()) {
    throw new Error("Playwright --with-deps requires root. Re-run as root or omit withDeps.");
  }

  if (options.withDeps) {
    await $`bunx playwright install chromium --with-deps`;
  } else {
    await $`bunx playwright install chromium`;
  }

  const nowExists = await Bun.file(pwPath).exists();
  if (!nowExists) {
    throw new Error(`Playwright install completed, but chromium still missing at ${pwPath}`);
  }

  return { installed: true, executablePath: pwPath };
}

function scheduleRestart(): { ok: true; scheduled: true } {
  // Give the HTTP response a moment to flush.
  setTimeout(() => {
    try {
      process.kill(process.pid, "SIGTERM");
    } catch {
      process.exit(0);
    }
  }, 250);
  return { ok: true as const, scheduled: true as const };
}

type DefaultInstallStatus = "already_present" | "installed" | "skipped" | "failed";

type DefaultInstallStep = {
  id: string;
  status: DefaultInstallStatus;
  details?: Record<string, unknown>;
  error?: string;
};

function normalizeDataDir(dataDir: string): string {
  // Keep relative paths stable by resolving against CWD.
  // In Docker, this is typically /app.
  return path.resolve(process.cwd(), dataDir);
}

function resolveDefaultInstallPaths(dataDir: string) {
  const resolved = normalizeDataDir(dataDir);

  const binDir = path.join(resolved, "bin");
  const bunGlobalDir = path.join(resolved, ".bun", "install", "global");
  const bunCacheDir = path.join(resolved, ".bun", "install", "cache");
  const npmPrefix = path.join(resolved, ".npm-global");
  const npmBinDir = path.join(npmPrefix, "bin");
  const xdgConfigHome = path.join(resolved, ".config");
  const tmpDir = path.join(resolved, "tmp");
  const lilacSkillsDir = path.join(resolved, "skills");

  return {
    dataDir: resolved,
    binDir,
    bunGlobalDir,
    bunCacheDir,
    npmPrefix,
    npmBinDir,
    xdgConfigHome,
    tmpDir,
    lilacSkillsDir,
  };
}

function resolveVcsPaths(dataDir: string): {
  dataDir: string;
  gitConfigGlobal: string;
  secretDir: string;
  gnupgHome: string;
  xdgConfigHome: string;
  tmpDir: string;
} {
  const resolved = normalizeDataDir(dataDir);
  const secretDir = path.join(resolved, "secret");
  return {
    dataDir: resolved,
    gitConfigGlobal: path.join(resolved, ".gitconfig"),
    secretDir,
    // Store unencrypted signing keys under secret/.
    gnupgHome: path.join(secretDir, "gnupg"),
    xdgConfigHome: path.join(resolved, ".config"),
    tmpDir: path.join(resolved, "tmp"),
  };
}

async function ensureDir0700(p: string): Promise<void> {
  await fs.mkdir(p, { recursive: true });
  try {
    await fs.chmod(p, 0o700);
  } catch {
    // Best-effort.
  }
}

async function ensureVcsDirs(paths: ReturnType<typeof resolveVcsPaths>) {
  await ensureDir0700(paths.secretDir);
  await ensureDir0700(paths.gnupgHome);
  await fs.mkdir(paths.tmpDir, { recursive: true });
}

function buildVcsEnv(paths: ReturnType<typeof resolveVcsPaths>) {
  return {
    ...process.env,
    GIT_CONFIG_GLOBAL: paths.gitConfigGlobal,
    // Avoid surprises from system-wide config in sandboxed/agent environments.
    GIT_CONFIG_NOSYSTEM: "1",
    GNUPGHOME: paths.gnupgHome,
    XDG_CONFIG_HOME: paths.xdgConfigHome,
  };
}

async function runGit(params: {
  args: string[];
  cwd?: string;
  env: Record<string, string | undefined>;
}) {
  return runCommand({ cmd: ["git", ...params.args], cwd: params.cwd, env: params.env });
}

async function runGpg(params: {
  args: string[];
  cwd?: string;
  env: Record<string, string | undefined>;
}) {
  return runCommand({ cmd: ["gpg", ...params.args], cwd: params.cwd, env: params.env });
}

function parseFirstGpgFingerprint(listSecretKeysOutput: string): string | null {
  // gpg --with-colons includes lines like: fpr:::::::::FINGERPRINT:
  for (const line of listSecretKeysOutput.split(/\r?\n/)) {
    if (!line.startsWith("fpr:")) continue;
    const parts = line.split(":");
    const fpr = parts[9];
    if (typeof fpr === "string" && fpr.length >= 16) return fpr;
  }
  return null;
}

function buildInstallEnv(paths: ReturnType<typeof resolveDefaultInstallPaths>) {
  const existingPath = process.env.PATH ?? "";
  const pathPrefix = [paths.binDir, paths.npmBinDir].join(":");

  return {
    ...process.env,
    BUN_INSTALL_GLOBAL_DIR: paths.bunGlobalDir,
    BUN_INSTALL_BIN: paths.binDir,
    BUN_INSTALL_CACHE_DIR: paths.bunCacheDir,
    NPM_CONFIG_PREFIX: paths.npmPrefix,
    XDG_CONFIG_HOME: paths.xdgConfigHome,
    PATH: `${pathPrefix}:${existingPath}`,
  };
}

async function runCommand(params: {
  cmd: string[];
  cwd?: string;
  env?: Record<string, string | undefined>;
}): Promise<{ code: number; stdout: string; stderr: string }> {
  const p = Bun.spawn(params.cmd, {
    cwd: params.cwd,
    env: params.env,
    stdout: "pipe",
    stderr: "pipe",
  });

  const stdout = p.stdout ? await new Response(p.stdout).text() : "";
  const stderr = p.stderr ? await new Response(p.stderr).text() : "";
  const code = await p.exited;

  return { code, stdout, stderr };
}

async function downloadToFile(url: string, filePath: string): Promise<void> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Download failed (${res.status}): ${url}`);
  }
  await Bun.write(filePath, res);
}

async function sha256Hex(filePath: string): Promise<string> {
  const buf = await Bun.file(filePath).arrayBuffer();
  return createHash("sha256").update(Buffer.from(buf)).digest("hex");
}

function parseChecksumsText(raw: string): Map<string, string> {
  const byName = new Map<string, string>();
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // Format: "<sha256>  <filename>" (allow extra whitespace)
    const parts = trimmed.split(/\s+/);
    if (parts.length < 2) continue;
    const hash = parts[0]!;
    const name = parts[parts.length - 1]!;
    if (hash.length >= 32 && name.length > 0) {
      byName.set(name, hash);
    }
  }
  return byName;
}

async function findFirstFile(params: { absolutePattern: string }): Promise<string | null> {
  const glob = new Bun.Glob(params.absolutePattern);
  for await (const p of glob.scan({ onlyFiles: true, absolute: true })) {
    return p;
  }
  return null;
}

async function copyFileIfNeeded(params: { from: string; to: string; overwrite: boolean }) {
  const existed = await Bun.file(params.to).exists();
  if (existed && !params.overwrite) {
    return { copied: false, overwritten: false };
  }

  await fs.mkdir(path.dirname(params.to), { recursive: true });
  await fs.copyFile(params.from, params.to);
  return { copied: true, overwritten: existed };
}

const githubReleaseSchema = z.object({
  tag_name: z.string(),
  assets: z.array(
    z.object({
      name: z.string(),
      browser_download_url: z.string(),
    }),
  ),
});

type GithubRelease = z.infer<typeof githubReleaseSchema>;

async function fetchGithubLatestRelease(repo: string): Promise<GithubRelease> {
  const res = await fetch(`https://api.github.com/repos/${repo}/releases/latest`);
  if (!res.ok) {
    throw new Error(`GitHub releases/latest failed (${res.status} ${res.statusText}) for ${repo}`);
  }
  const raw: unknown = await res.json();
  return githubReleaseSchema.parse(raw);
}

function stripLeadingV(tag: string): string {
  return tag.startsWith("v") ? tag.slice(1) : tag;
}

function platformArchLabel(): "amd64" | "arm64" {
  if (process.arch === "arm64") return "arm64";
  return "amd64";
}

async function installGithubTarGzBinary(params: {
  repo: string;
  destPath: string;
  tarAssetName: (version: string, arch: "amd64" | "arm64") => string;
  checksumAssetName: (version: string) => string;
  findExtractedPath: (extractDir: string) => Promise<string | null>;
  tmpDir: string;
  overwrite: boolean;
  network: boolean;
}): Promise<{
  status: DefaultInstallStatus;
  details?: Record<string, unknown>;
}> {
  const existed = await Bun.file(params.destPath).exists();
  if (existed && !params.overwrite) {
    return { status: "already_present" };
  }

  if (!params.network) {
    return {
      status: "skipped",
      details: { reason: "network disabled" },
    };
  }

  if (process.platform !== "linux") {
    return {
      status: "skipped",
      details: { reason: "unsupported platform", platform: process.platform },
    };
  }

  const tarBin = Bun.which("tar");
  if (!tarBin) {
    throw new Error("Missing dependency: tar (required to extract GitHub releases)");
  }

  const release = await fetchGithubLatestRelease(params.repo);
  const version = stripLeadingV(release.tag_name);
  const arch = platformArchLabel();

  const tarName = params.tarAssetName(version, arch);
  const checksumName = params.checksumAssetName(version);

  const tarAsset = release.assets.find((a) => a.name === tarName);
  if (!tarAsset) {
    throw new Error(`Asset not found in ${params.repo} ${release.tag_name}: ${tarName}`);
  }

  const checksumAsset = release.assets.find((a) => a.name === checksumName);
  if (!checksumAsset) {
    throw new Error(
      `Checksums asset not found in ${params.repo} ${release.tag_name}: ${checksumName}`,
    );
  }

  await fs.mkdir(params.tmpDir, { recursive: true });

  const tarPath = path.join(params.tmpDir, `${params.repo.replaceAll("/", "-")}-${tarName}`);
  const checksumsPath = path.join(
    params.tmpDir,
    `${params.repo.replaceAll("/", "-")}-${checksumName}`,
  );

  await downloadToFile(tarAsset.browser_download_url, tarPath);
  await downloadToFile(checksumAsset.browser_download_url, checksumsPath);

  const checksumRaw = await Bun.file(checksumsPath).text();
  const byName = parseChecksumsText(checksumRaw);
  const expected = byName.get(tarName);
  if (!expected) {
    throw new Error(`No checksum entry for ${tarName} in ${checksumName}`);
  }

  const got = await sha256Hex(tarPath);
  if (got.toLowerCase() !== expected.toLowerCase()) {
    throw new Error(`Checksum mismatch for ${tarName}: expected ${expected}, got ${got}`);
  }

  const extractDir = path.join(
    params.tmpDir,
    `extract-${params.repo.replaceAll("/", "-")}-${Date.now()}`,
  );
  await fs.mkdir(extractDir, { recursive: true });

  const untar = await runCommand({
    cmd: [tarBin, "-xzf", tarPath, "-C", extractDir],
  });
  if (untar.code !== 0) {
    throw new Error(`tar failed: ${untar.stderr || untar.stdout}`);
  }

  const extracted = await params.findExtractedPath(extractDir);
  if (!extracted) {
    throw new Error(`Failed to locate extracted binary from ${tarName}`);
  }

  await fs.mkdir(path.dirname(params.destPath), { recursive: true });
  await fs.copyFile(extracted, params.destPath);
  await fs.chmod(params.destPath, 0o755);

  return {
    status: "installed",
    details: {
      repo: params.repo,
      tag: release.tag_name,
      version,
      arch,
      tarName,
      extracted,
      destPath: params.destPath,
      replaced: existed,
    },
  };
}

async function hasAnySkillMdUnder(dir: string): Promise<boolean> {
  try {
    await fs.access(dir);
  } catch {
    return false;
  }
  const glob = new Bun.Glob(path.join(dir, "**", "SKILL.md"));
  for await (const _ of glob.scan({ onlyFiles: true, absolute: true })) {
    return true;
  }
  return false;
}

export class Onboarding implements ServerTool {
  id = "onboarding";

  async init(): Promise<void> {}
  async destroy(): Promise<void> {}

  async list() {
    return [
      {
        callableId: "onboarding.bootstrap",
        name: "Onboarding Bootstrap",
        description: "Bootstrap DATA_DIR (core-config.yaml + prompts/*). Hidden by default.",
        shortInput: zodObjectToCliLines(bootstrapInputSchema, {
          mode: "required",
        }),
        input: zodObjectToCliLines(bootstrapInputSchema),
        hidden: true,
      },
      {
        callableId: "onboarding.playwright",
        name: "Onboarding Playwright",
        description:
          "Ensure Chromium is available for Playwright (prefer system chromium; fallback to Playwright install). Hidden by default.",
        shortInput: zodObjectToCliLines(playwrightInputSchema, {
          mode: "required",
        }),
        input: zodObjectToCliLines(playwrightInputSchema),
        hidden: true,
      },
      {
        callableId: "onboarding.defaults",
        name: "Onboarding Defaults",
        description: "Install default CLIs + skills into DATA_DIR (persisted). Hidden by default.",
        shortInput: zodObjectToCliLines(defaultsInputSchema, {
          mode: "required",
        }),
        input: zodObjectToCliLines(defaultsInputSchema),
        hidden: true,
      },
      {
        callableId: "onboarding.github_app",
        name: "Onboarding GitHub App",
        description:
          "Configure GitHub App credentials for the agent (installs GH_TOKEN/GITHUB_TOKEN in bash env). Hidden by default.",
        shortInput: zodObjectToCliLines(githubAppInputSchema, {
          mode: "required",
        }),
        input: zodObjectToCliLines(githubAppInputSchema),
        hidden: true,
      },
      {
        callableId: "onboarding.vcs_env",
        name: "Onboarding VCS Env",
        description:
          "Show effective GIT_CONFIG_GLOBAL and GNUPGHOME paths under DATA_DIR. Hidden by default.",
        shortInput: zodObjectToCliLines(vcsEnvInputSchema, { mode: "required" }),
        input: zodObjectToCliLines(vcsEnvInputSchema),
        hidden: true,
      },
      {
        callableId: "onboarding.git_identity",
        name: "Onboarding Git Identity",
        description:
          "Configure agent git identity (name/email) and optional GPG signing, persisted under DATA_DIR. Hidden by default.",
        shortInput: zodObjectToCliLines(gitIdentityInputSchema, {
          mode: "required",
        }),
        input: zodObjectToCliLines(gitIdentityInputSchema),
        hidden: true,
      },
      {
        callableId: "onboarding.gnupg",
        name: "Onboarding GnuPG",
        description:
          "Generate/export a no-passphrase GPG key for commit signing (stored under DATA_DIR/secret). Hidden by default.",
        shortInput: zodObjectToCliLines(gnupgInputSchema, {
          mode: "required",
        }),
        input: zodObjectToCliLines(gnupgInputSchema),
        hidden: true,
      },
      {
        callableId: "onboarding.reload_tools",
        name: "Onboarding Reload Tools",
        description:
          "Reload tool instances (calls POST /reload on the local tool server). Hidden by default.",
        shortInput: [],
        input: [],
        hidden: true,
      },
      {
        callableId: "onboarding.reload_config",
        name: "Onboarding Reload Config",
        description: "Reload core config cache (or restart process). Hidden by default.",
        shortInput: zodObjectToCliLines(reloadConfigInputSchema, {
          mode: "required",
        }),
        input: zodObjectToCliLines(reloadConfigInputSchema),
        hidden: true,
      },
      {
        callableId: "onboarding.restart",
        name: "Onboarding Restart",
        description: "Exit the process (docker/systemd should restart it). Hidden by default.",
        shortInput: [],
        input: [],
        hidden: true,
      },
      {
        callableId: "onboarding.all",
        name: "Onboarding All",
        description:
          "Run bootstrap + playwright check/install + defaults + config reload (and optional restart). Hidden by default.",
        shortInput: zodObjectToCliLines(allInputSchema, { mode: "required" }),
        input: zodObjectToCliLines(allInputSchema),
        hidden: true,
      },
    ];
  }

  async call(callableId: string, rawInput: Record<string, unknown>) {
    if (callableId === "onboarding.vcs_env") {
      const input = vcsEnvInputSchema.parse(rawInput);
      const dataDir = input.dataDir ?? env.dataDir;
      const paths = resolveVcsPaths(dataDir);

      return {
        ok: true as const,
        dataDir: paths.dataDir,
        gitConfigGlobal: paths.gitConfigGlobal,
        gnupgHome: paths.gnupgHome,
        xdgConfigHome: paths.xdgConfigHome,
      };
    }

    if (callableId === "onboarding.gnupg") {
      const input = gnupgInputSchema.parse(rawInput);
      const dataDir = input.dataDir ?? env.dataDir;
      const paths = resolveVcsPaths(dataDir);
      await ensureVcsDirs(paths);
      const vcsEnv = buildVcsEnv(paths);

      const gpgBin = Bun.which("gpg");
      if (!gpgBin) {
        throw new Error("Missing dependency: gpg (install gnupg). Required for commit signing.");
      }

      if (input.mode === "clear") {
        await fs.rm(paths.gnupgHome, { recursive: true, force: true });
        await ensureDir0700(paths.gnupgHome);
        return { ok: true as const, dataDir: paths.dataDir, cleared: true as const };
      }

      const list = await runGpg({
        args: ["--list-secret-keys", "--with-colons"],
        env: vcsEnv,
      });
      const existingFpr = list.code === 0 ? parseFirstGpgFingerprint(list.stdout) : null;

      if (input.mode === "status") {
        return {
          ok: true as const,
          dataDir: paths.dataDir,
          gnupgHome: paths.gnupgHome,
          hasSecretKey: Boolean(existingFpr),
          fingerprint: existingFpr ?? undefined,
        };
      }

      if (input.mode === "generate") {
        if (existingFpr) {
          return {
            ok: true as const,
            dataDir: paths.dataDir,
            generated: false as const,
            fingerprint: existingFpr,
            status: "already_present" as const,
          };
        }

        const userName = input.userName ?? "lilac-agent[bot]";
        const userEmail = input.userEmail ?? "lilac-agent[bot]@users.noreply.github.com";
        const comment = input.uidComment ? ` (${input.uidComment})` : "";
        const uid = `${userName}${comment} <${userEmail}>`;

        // Ensure loopback pinentry works even if gpg decides to ask.
        await fs.writeFile(
          path.join(paths.gnupgHome, "gpg-agent.conf"),
          "allow-loopback-pinentry\n",
          "utf8",
        );

        const gen = await runGpg({
          args: [
            "--batch",
            "--pinentry-mode",
            "loopback",
            "--passphrase",
            "",
            "--quick-generate-key",
            uid,
            "default",
            "default",
            "never",
          ],
          env: vcsEnv,
        });
        if (gen.code !== 0) {
          throw new Error(gen.stderr || gen.stdout || "gpg key generation failed");
        }

        const after = await runGpg({
          args: ["--list-secret-keys", "--with-colons"],
          env: vcsEnv,
        });
        const fingerprint = after.code === 0 ? parseFirstGpgFingerprint(after.stdout) : null;
        if (!fingerprint) {
          throw new Error("gpg key generation succeeded, but no secret key fingerprint was found");
        }

        return {
          ok: true as const,
          dataDir: paths.dataDir,
          generated: true as const,
          fingerprint,
          status: "generated" as const,
        };
      }

      if (input.mode === "export_public") {
        const fingerprint = input.fingerprint ?? existingFpr;
        if (!fingerprint) {
          throw new Error("No secret key found to export");
        }

        const exp = await runGpg({
          args: ["--armor", "--export", fingerprint],
          env: vcsEnv,
        });
        if (exp.code !== 0) {
          throw new Error(exp.stderr || exp.stdout || "gpg export failed");
        }

        return {
          ok: true as const,
          dataDir: paths.dataDir,
          fingerprint,
          publicKeyArmored: exp.stdout,
        };
      }

      const _exhaustive: never = input.mode;
      return _exhaustive;
    }

    if (callableId === "onboarding.git_identity") {
      const input = gitIdentityInputSchema.parse(rawInput);
      const dataDir = input.dataDir ?? env.dataDir;
      const paths = resolveVcsPaths(dataDir);
      await ensureVcsDirs(paths);
      const vcsEnv = buildVcsEnv(paths);

      const get = async (key: string): Promise<string | undefined> => {
        const res = await runGit({ args: ["config", "--global", "--get", key], env: vcsEnv });
        if (res.code !== 0) return undefined;
        const v = res.stdout.trim();
        return v.length > 0 ? v : undefined;
      };

      const unsetAll = async (key: string) => {
        const res = await runGit({ args: ["config", "--global", "--unset-all", key], env: vcsEnv });
        // git config --unset-all returns non-zero if the key is missing.
        return res.code === 0;
      };

      if (input.mode === "status") {
        const userName = await get("user.name");
        const userEmail = await get("user.email");
        const signingKey = await get("user.signingkey");
        const commitSign = await get("commit.gpgsign");
        const tagSign = await get("tag.gpgsign");
        const gpgProgram = await get("gpg.program");

        return {
          ok: true as const,
          dataDir: paths.dataDir,
          gitConfigGlobal: paths.gitConfigGlobal,
          userName,
          userEmail,
          signingKey,
          commitGpgSign: commitSign,
          tagGpgSign: tagSign,
          gpgProgram,
        };
      }

      if (input.mode === "clear") {
        const cleared: Record<string, boolean> = {
          "user.name": await unsetAll("user.name"),
          "user.email": await unsetAll("user.email"),
          "user.signingkey": await unsetAll("user.signingkey"),
          "commit.gpgsign": await unsetAll("commit.gpgsign"),
          "tag.gpgsign": await unsetAll("tag.gpgsign"),
          "gpg.program": await unsetAll("gpg.program"),
        };
        return { ok: true as const, dataDir: paths.dataDir, cleared };
      }

      if (input.mode === "configure") {
        if (!input.userName) throw new Error("Missing required input: userName");
        if (!input.userEmail) throw new Error("Missing required input: userEmail");

        const set = async (key: string, value: string) => {
          const res = await runGit({
            args: ["config", "--global", key, value],
            env: vcsEnv,
          });
          if (res.code !== 0) {
            throw new Error(res.stderr || res.stdout || `git config failed: ${key}`);
          }
        };

        await set("user.name", input.userName);
        await set("user.email", input.userEmail);

        if (input.enableSigning) {
          const signingKey = input.signingKey;
          if (!signingKey) {
            throw new Error(
              "Missing required input: signingKey (required when enableSigning=true)",
            );
          }

          await set("gpg.program", "gpg");
          await set("user.signingkey", signingKey);
          await set("commit.gpgsign", "true");
          await set("tag.gpgsign", "true");
        } else {
          await unsetAll("user.signingkey");
          await unsetAll("commit.gpgsign");
          await unsetAll("tag.gpgsign");
          await unsetAll("gpg.program");
        }

        return { ok: true as const, dataDir: paths.dataDir, configured: true as const };
      }

      if (input.mode === "test") {
        await fs.mkdir(paths.tmpDir, { recursive: true });
        const repoDir = await fs.mkdtemp(path.join(paths.tmpDir, "git-test-"));

        const init = await runGit({ args: ["init"], cwd: repoDir, env: vcsEnv });
        if (init.code !== 0) {
          throw new Error(init.stderr || init.stdout || "git init failed");
        }

        await fs.writeFile(path.join(repoDir, "README.md"), "test\n", "utf8");
        const add = await runGit({ args: ["add", "README.md"], cwd: repoDir, env: vcsEnv });
        if (add.code !== 0) {
          throw new Error(add.stderr || add.stdout || "git add failed");
        }

        const commit = await runGit({
          args: ["commit", "-m", "test commit"],
          cwd: repoDir,
          env: vcsEnv,
        });
        const ok = commit.code === 0;

        return {
          ok: true as const,
          dataDir: paths.dataDir,
          repoDir,
          committed: ok,
          exitCode: commit.code,
          stdout: commit.stdout,
          stderr: commit.stderr,
        };
      }

      const _exhaustive: never = input.mode;
      return _exhaustive;
    }

    if (callableId === "onboarding.bootstrap") {
      const input = bootstrapInputSchema.parse(rawInput);
      const dataDir = input.dataDir ?? env.dataDir;

      const ensuredDirs: string[] = [];
      for (const sub of ["prompts", "skills", "secret", "workspace"]) {
        const p = path.join(dataDir, sub);
        await fs.mkdir(p, { recursive: true });
        ensuredDirs.push(p);
      }

      const config = await seedCoreConfig({
        dataDir,
        overwrite: input.overwriteConfig,
      });

      const prompts = await ensurePromptWorkspace({
        dataDir,
        overwrite: input.overwritePrompts,
      });

      return {
        ok: true as const,
        dataDir,
        ensuredDirs,
        config,
        prompts,
      };
    }

    if (callableId === "onboarding.playwright") {
      const input = playwrightInputSchema.parse(rawInput);

      const systemPath = await findSystemChromiumExecutable();
      if (systemPath) {
        return {
          ok: true as const,
          strategy: "system" as const,
          executablePath: systemPath,
          installed: false,
          notes: [
            "Using system chromium.",
            "If Playwright fails to launch, try onboarding.playwright withDeps=true as root or use Playwright-managed chromium.",
          ],
        };
      }

      const pw = await ensurePlaywrightChromiumInstalled({
        withDeps: input.withDeps,
      });

      return {
        ok: true as const,
        strategy: "playwright" as const,
        executablePath: pw.executablePath,
        installed: pw.installed,
        notes: ["System chromium not found; using Playwright-managed chromium."],
      };
    }

    if (callableId === "onboarding.defaults") {
      const input = defaultsInputSchema.parse(rawInput);
      const dataDir = input.dataDir ?? env.dataDir;

      const paths = resolveDefaultInstallPaths(dataDir);
      const installEnv = buildInstallEnv(paths);
      const bunBin = Bun.which("bun") ?? "bun";

      await fs.mkdir(paths.binDir, { recursive: true });
      await fs.mkdir(paths.bunGlobalDir, { recursive: true });
      await fs.mkdir(paths.bunCacheDir, { recursive: true });
      await fs.mkdir(paths.npmPrefix, { recursive: true });
      await fs.mkdir(paths.xdgConfigHome, { recursive: true });
      await fs.mkdir(paths.tmpDir, { recursive: true });
      await fs.mkdir(paths.lilacSkillsDir, { recursive: true });

      const steps: DefaultInstallStep[] = [];

      const runStep = async (id: string, fn: () => Promise<Omit<DefaultInstallStep, "id">>) => {
        try {
          steps.push({ id, ...(await fn()) });
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          if (input.strict) throw e;
          steps.push({ id, status: "failed", error: msg });
        }
      };

      await runStep("skills.mcporter", async () => {
        const src = path.resolve(process.cwd(), "packages/utils/skill-templates/mcporter/SKILL.md");
        const dst = path.join(paths.lilacSkillsDir, "mcporter", "SKILL.md");
        const { copied, overwritten } = await copyFileIfNeeded({
          from: src,
          to: dst,
          overwrite: input.overwriteSkills,
        });
        return {
          status: copied ? "installed" : "already_present",
          details: { src, dst, overwritten },
        };
      });

      await runStep("skills.gog", async () => {
        const src = path.resolve(process.cwd(), "packages/utils/skill-templates/gog/SKILL.md");
        const dst = path.join(paths.lilacSkillsDir, "gog", "SKILL.md");
        const { copied, overwritten } = await copyFileIfNeeded({
          from: src,
          to: dst,
          overwrite: input.overwriteSkills,
        });
        return {
          status: copied ? "installed" : "already_present",
          details: { src, dst, overwritten },
        };
      });

      await runStep("cli.mcporter", async () => {
        const dest = path.join(paths.binDir, "mcporter");
        if (await Bun.file(dest).exists()) return { status: "already_present" };
        if (!input.network) {
          return { status: "skipped", details: { reason: "network disabled" } };
        }

        const res = await runCommand({
          cmd: [bunBin, "install", "--global", "mcporter"],
          env: installEnv,
        });
        if (res.code !== 0) {
          throw new Error(res.stderr || res.stdout || "bun install failed");
        }

        const installed = await Bun.file(dest).exists();
        if (!installed) {
          return {
            status: "failed",
            error: `bun install succeeded but ${dest} not found`,
          };
        }

        return { status: "installed", details: { dest } };
      });

      await runStep("cli.agent-browser", async () => {
        const dest = path.join(paths.binDir, "agent-browser");
        if (await Bun.file(dest).exists()) return { status: "already_present" };
        if (!input.network) {
          return { status: "skipped", details: { reason: "network disabled" } };
        }

        const res = await runCommand({
          cmd: [bunBin, "install", "--global", "agent-browser"],
          env: installEnv,
        });
        if (res.code !== 0) {
          throw new Error(res.stderr || res.stdout || "bun install failed");
        }

        const installed = await Bun.file(dest).exists();
        if (!installed) {
          return {
            status: "failed",
            error: `bun install succeeded but ${dest} not found`,
          };
        }

        return { status: "installed", details: { dest } };
      });

      await runStep("skill.agent-browser", async () => {
        const opencodeSkillsDir = path.join(paths.xdgConfigHome, "opencode", "skills");
        if (await hasAnySkillMdUnder(opencodeSkillsDir)) {
          return { status: "already_present", details: { opencodeSkillsDir } };
        }
        if (!input.network) {
          return { status: "skipped", details: { reason: "network disabled" } };
        }

        const res = await runCommand({
          cmd: [
            bunBin,
            "x",
            "skills",
            "add",
            "vercel-labs/agent-browser",
            "-a",
            "opencode",
            "-g",
            "-y",
          ],
          env: installEnv,
        });
        if (res.code !== 0) {
          throw new Error(res.stderr || res.stdout || "`skills add` failed");
        }

        const installedNow = await hasAnySkillMdUnder(opencodeSkillsDir);
        return {
          status: installedNow ? "installed" : "failed",
          details: { opencodeSkillsDir },
          error: installedNow ? undefined : "skill install ran but no SKILL.md found",
        };
      });

      await runStep("cli.gh", async () => {
        const dest = path.join(paths.binDir, "gh");
        const result = await installGithubTarGzBinary({
          repo: "cli/cli",
          destPath: dest,
          tarAssetName: (version, arch) => `gh_${version}_linux_${arch}.tar.gz`,
          checksumAssetName: (version) => `gh_${version}_checksums.txt`,
          findExtractedPath: async (extractDir) =>
            findFirstFile({
              absolutePattern: path.join(extractDir, "**", "bin", "gh"),
            }),
          tmpDir: paths.tmpDir,
          overwrite: false,
          network: input.network,
        });
        return { status: result.status, details: result.details };
      });

      await runStep("cli.gog", async () => {
        const dest = path.join(paths.binDir, "gog");
        const result = await installGithubTarGzBinary({
          repo: "steipete/gogcli",
          destPath: dest,
          tarAssetName: (version, arch) => `gogcli_${version}_linux_${arch}.tar.gz`,
          checksumAssetName: () => "checksums.txt",
          findExtractedPath: async (extractDir) =>
            findFirstFile({
              absolutePattern: path.join(extractDir, "**", "gog"),
            }),
          tmpDir: paths.tmpDir,
          overwrite: false,
          network: input.network,
        });
        return { status: result.status, details: result.details };
      });

      return {
        ok: true as const,
        dataDir: paths.dataDir,
        env: {
          BUN_INSTALL_GLOBAL_DIR: installEnv.BUN_INSTALL_GLOBAL_DIR,
          BUN_INSTALL_BIN: installEnv.BUN_INSTALL_BIN,
          BUN_INSTALL_CACHE_DIR: installEnv.BUN_INSTALL_CACHE_DIR,
          NPM_CONFIG_PREFIX: installEnv.NPM_CONFIG_PREFIX,
          XDG_CONFIG_HOME: installEnv.XDG_CONFIG_HOME,
        },
        steps,
      };
    }

    if (callableId === "onboarding.github_app") {
      const input = githubAppInputSchema.parse(rawInput);
      const dataDir = input.dataDir ?? env.dataDir;

      const normalizeHost = (h: string | undefined) =>
        h
          ? h
              .trim()
              .replace(/^https?:\/\//, "")
              .replace(/\/+$/, "")
          : undefined;

      if (input.mode === "status") {
        const secret = await readGithubAppSecret(dataDir);
        const apiBaseUrl = secret
          ? deriveApiBaseUrl({
              host: secret.host,
              apiBaseUrl: secret.apiBaseUrl,
            })
          : undefined;
        return {
          ok: true as const,
          dataDir,
          configured: Boolean(secret),
          ...(secret
            ? {
                appId: secret.appId,
                installationId: secret.installationId,
                host: secret.host,
                apiBaseUrl,
                privateKeyPath: secret.privateKeyPath,
              }
            : {}),
        };
      }

      if (input.mode === "clear") {
        await clearGithubAppSecret(dataDir);
        return { ok: true as const, dataDir, cleared: true as const };
      }

      if (input.mode === "configure") {
        if (!input.appId) {
          throw new Error("Missing required input: appId");
        }
        if (!input.installationId) {
          throw new Error("Missing required input: installationId");
        }

        const privateKeyPem = input.privateKeyPem
          ? input.privateKeyPem
          : input.privateKeyPath
            ? await Bun.file(input.privateKeyPath).text()
            : null;
        if (!privateKeyPem) {
          throw new Error("Missing required input: privateKeyPem or privateKeyPath");
        }

        const host = normalizeHost(input.host);
        const apiBaseUrl = input.apiBaseUrl ?? deriveApiBaseUrl({ host });

        const wrote = await writeGithubAppSecret({
          dataDir,
          appId: input.appId,
          installationId: input.installationId,
          host,
          apiBaseUrl,
          privateKeyPem,
        });

        return {
          ok: true as const,
          dataDir,
          configured: true as const,
          appId: input.appId,
          installationId: input.installationId,
          host,
          apiBaseUrl,
          jsonPath: wrote.jsonPath,
          pemPath: wrote.pemPath,
          overwritten: wrote.overwritten,
        };
      }

      if (input.mode === "test") {
        const t = await getGithubInstallationTokenOrThrow({ dataDir });
        const res = await fetch(`${t.apiBaseUrl}/installation/repositories?per_page=1`, {
          headers: {
            "User-Agent": "lilac-onboarding",
            Accept: "application/vnd.github+json",
            Authorization: `token ${t.token}`,
          },
        });
        if (!res.ok) {
          throw new Error(
            `GitHub API test failed (${res.status} ${res.statusText}) at ${t.apiBaseUrl}`,
          );
        }

        const body: unknown = await res.json().catch(() => null as unknown);
        const repoCount = (() => {
          if (!body || typeof body !== "object") return undefined;
          const repos = (body as Record<string, unknown>)["repositories"];
          return Array.isArray(repos) ? repos.length : undefined;
        })();

        return {
          ok: true as const,
          dataDir,
          host: t.host,
          apiBaseUrl: t.apiBaseUrl,
          expiresAtMs: t.expiresAtMs,
          repoCount,
        };
      }

      const _exhaustive: never = input.mode;
      return _exhaustive;
    }

    if (callableId === "onboarding.reload_tools") {
      const port = Number(env.toolServer.port ?? 8080);
      const res = await fetch(`http://127.0.0.1:${port}/reload`, {
        method: "POST",
      });
      if (!res.ok) {
        throw new Error(`POST /reload failed: ${res.status} ${res.statusText}`);
      }
      return { ok: true as const };
    }

    if (callableId === "onboarding.reload_config") {
      const input = reloadConfigInputSchema.parse(rawInput);

      if (input.mode === "restart") {
        return scheduleRestart();
      }

      const cfg = await getCoreConfig({ forceReload: true });
      return {
        ok: true as const,
        mode: "cache" as const,
        dataDir: env.dataDir,
        coreConfigPath: resolveCoreConfigPath(),
        promptDir: resolvePromptDir(),
        discord: {
          tokenEnv: cfg.surface.discord.tokenEnv,
          botName: cfg.surface.discord.botName,
        },
      };
    }

    if (callableId === "onboarding.restart") {
      return scheduleRestart();
    }

    if (callableId === "onboarding.all") {
      const input = allInputSchema.parse(rawInput);
      const dataDir = input.dataDir ?? env.dataDir;

      const bootstrap = (await this.call("onboarding.bootstrap", {
        dataDir,
        overwriteConfig: input.overwriteConfig,
        overwritePrompts: input.overwritePrompts,
      })) as unknown;

      const playwright = (await this.call("onboarding.playwright", {
        withDeps: input.playwrightWithDeps,
      })) as unknown;

      const defaults = (await this.call("onboarding.defaults", {
        dataDir,
        overwriteSkills: input.overwriteSkills,
        network: true,
        strict: false,
      })) as unknown;

      const reloadConfig = (await this.call("onboarding.reload_config", {
        mode: "cache",
      })) as unknown;

      const restart = input.restart ? scheduleRestart() : undefined;

      return {
        ok: true as const,
        bootstrap,
        playwright,
        defaults,
        reloadConfig,
        restart,
      };
    }

    throw new Error(`Invalid callable ID '${callableId}'`);
  }
}
