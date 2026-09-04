import { captureError } from "../../shared/error-capture";
import { $ } from "bun";
import { z } from "zod";
import path from "node:path";
import fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { createHash } from "node:crypto";
import { Panic, Result, TaggedError, type Result as ResultType } from "better-result";
import { preserveToolPanic } from "../../tools/tool-result-adapters";

type OnboardingCapturedFailure = {
  readonly cause: Error | Panic;
  readonly code?: string;
  readonly name?: string;
};

function captureOnboardingFailure(cause: unknown): OnboardingCapturedFailure {
  const code =
    typeof cause === "object" && cause !== null && "code" in cause && typeof cause.code === "string"
      ? cause.code
      : undefined;
  const name =
    typeof cause === "object" && cause !== null && "name" in cause && typeof cause.name === "string"
      ? cause.name
      : undefined;
  if (Panic.is(cause)) return { cause, code, name };
  if (cause instanceof Error) return { cause, code, name };
  const message =
    typeof cause === "object" &&
    cause !== null &&
    "message" in cause &&
    typeof cause.message === "string"
      ? cause.message
      : "Onboarding operation failed";
  return { cause: new Error(message, { cause }), code, name };
}

async function settleCapturedPromise<T, E>(
  result: Promise<ResultType<T, OnboardingCapturedFailure>>,
  resolve: (failure: OnboardingCapturedFailure) => E,
): Promise<ResultType<T, E>> {
  return (await result).mapError(resolve);
}
import {
  serverToolFailure,
  type ServerToolFailure,
  type ServerToolResult,
} from "@stanley2058/lilac-plugin-runtime";

import {
  env,
  errorMessage,
  ensurePromptWorkspace,
  findWorkspaceRootResult,
  getCoreConfig,
  resolveCoreConfigPath,
  resolvePromptDir,
  seedCoreConfig,
} from "@stanley2058/lilac-utils";
import { defineServerTool, type ServerTool, type ServerToolCallOptions } from "../types";

import { chromium } from "playwright";

import {
  clearGithubAppSecret,
  deriveApiBaseUrl,
  readGithubAppSecret,
  writeGithubAppSecret,
} from "../../github/github-app";
import { getGithubViewerLoginOrNull } from "../../github/github-auth";
import { getGithubInstallationTokenOrThrow } from "../../github/github-app-token";
import {
  clearGithubUserTokenSecret,
  readGithubUserTokenSecret,
  writeGithubUserTokenSecret,
} from "../../github/github-user-token";

function onboardingFailure(kind: ServerToolFailure["kind"], message: string): ServerToolFailure {
  return serverToolFailure({
    kind,
    code: `onboarding_${kind}`,
    message,
    retryable: kind === "unavailable" || kind === "timeout",
  });
}

function requireWorkspaceRoot(): ResultType<string, ServerToolFailure> {
  return findWorkspaceRootResult().match<() => ResultType<string, ServerToolFailure>>({
    ok: (value) => () => Result.ok(value),
    err: (error) => () => {
      if (Panic.is(error)) return preserveToolPanic(error);
      return Result.err(onboardingFailure("not_found", error.message));
    },
  })();
}

const githubBashEnvDocs = {
  onlyWhenConfigured:
    "Injected only when GitHub outbound auth is configured (user token and/or app auth).",
  canonicalAuthVars: ["GH_TOKEN", "GITHUB_TOKEN"],
  hostVar: "GH_HOST",
  alternateAuthVars: ["LILAC_GITHUB_USER_TOKEN", "LILAC_GITHUB_APP_TOKEN"],
  alternateHostVars: ["LILAC_GITHUB_USER_HOST", "LILAC_GITHUB_APP_HOST"],
  precedence:
    "Canonical GH_TOKEN/GITHUB_TOKEN prefer user token when configured, otherwise app token.",
  forceAppHint:
    "To force app auth in a command, set GH_TOKEN=$LILAC_GITHUB_APP_TOKEN (and GH_HOST=$LILAC_GITHUB_APP_HOST when present).",
} as const;

const githubInstallationRepositoriesSchema = z.object({
  repositories: z.array(z.object({}).loose()),
});

export function decodeGithubInstallationRepositoriesCount(value: unknown): number | undefined {
  const decoded = githubInstallationRepositoriesSchema.safeParse(value);
  return decoded.success ? decoded.data.repositories.length : undefined;
}

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

const githubUserTokenInputSchema = z.object({
  dataDir: z.string().optional().describe("Override DATA_DIR for this call"),
  mode: z
    .enum(["status", "configure", "test", "clear"])
    .optional()
    .default("status")
    .describe(
      "status: show config; configure: persist GitHub user token; test: call GitHub API /user; clear: remove stored token",
    ),
  token: z
    .string()
    .min(1)
    .optional()
    .describe("GitHub personal access token (classic or fine-grained)"),
  host: z.string().min(1).optional().describe("GitHub host (github.com or your GHES host)"),
  apiBaseUrl: z
    .url()
    .optional()
    .describe(
      "GitHub API base URL (default: https://api.github.com; GHES example: https://github.example.com/api/v3)",
    ),
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
  {
    const attempt = await Result.tryPromise({
      try: async () => {
        await fs.access(p, fsConstants.X_OK);
        return true;
      },
      catch: captureError,
    });

    if (attempt.isErr()) {
      const cause = attempt.error.cause;
      if (Panic.is(cause)) return preserveToolPanic(cause);
      return false;
    }
    return attempt.value;
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
  {
    const attempt = Result.try({
      try: () => {
        return typeof process.getuid === "function" && process.getuid() === 0;
      },
      catch: captureError,
    });

    if (attempt.isErr()) {
      const cause = attempt.error.cause;
      if (Panic.is(cause)) return preserveToolPanic(cause);
      return false;
    }
    return attempt.value;
  }
}

async function ensurePlaywrightChromiumInstalled(options: {
  withDeps: boolean;
}): Promise<ResultType<{ installed: boolean; executablePath: string }, ServerToolFailure>> {
  const pwPath = chromium.executablePath();
  const exists = await Bun.file(pwPath).exists();
  if (exists) {
    return Result.ok({ installed: false, executablePath: pwPath });
  }

  if (options.withDeps && !isRootUser()) {
    return Result.err(
      onboardingFailure(
        "denied",
        "Playwright --with-deps requires root. Re-run as root or omit withDeps.",
      ),
    );
  }

  const installed = await settleCapturedPromise(
    Result.tryPromise({
      try: () =>
        options.withDeps
          ? $`bunx playwright install chromium --with-deps`.then(() => undefined)
          : $`bunx playwright install chromium`.then(() => undefined),
      catch: captureOnboardingFailure,
    }),
    ({ cause }) => {
      if (Panic.is(cause)) return preserveToolPanic(cause);
      return onboardingFailure("unavailable", errorMessage(cause));
    },
  );
  const installFailure = installed.match({
    ok: () => undefined,
    err: (failure) => failure,
  });
  if (installFailure) return Result.err(installFailure);

  const nowExists = await Bun.file(pwPath).exists();
  if (!nowExists) {
    return Result.err(
      onboardingFailure(
        "unavailable",
        `Playwright install completed, but chromium still missing at ${pwPath}`,
      ),
    );
  }

  return Result.ok({ installed: true, executablePath: pwPath });
}

function scheduleRestart(): { ok: true; scheduled: true } {
  // Give the HTTP response a moment to flush.
  setTimeout(() => {
    const signalled = Result.try({
      try: () => process.kill(process.pid, "SIGTERM"),
      catch: captureError,
    }).match<{ readonly kind: "success" } | { readonly kind: "failure"; readonly failure: Error }>({
      ok: () => ({ kind: "success" }),
      err: ({ cause }) => ({ kind: "failure", failure: cause }),
    });
    if (signalled.kind === "success") return;
    const cause = signalled.failure;
    if (Panic.is(cause)) preserveToolPanic(cause);
    process.exit(0);
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
  const changed = (
    await Result.tryPromise({
      try: () => fs.chmod(p, 0o700),
      catch: captureError,
    })
  ).match<{ readonly kind: "success" } | { readonly kind: "failure"; readonly failure: Error }>({
    ok: () => ({ kind: "success" }),
    err: ({ cause }) => ({ kind: "failure", failure: cause }),
  });
  if (changed.kind === "failure" && Panic.is(changed.failure)) {
    preserveToolPanic(changed.failure);
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

async function downloadToFile(
  url: string,
  filePath: string,
): Promise<ResultType<void, ServerToolFailure>> {
  return Result.gen(async function* () {
    const res = yield* Result.await(
      settleCapturedPromise(
        Result.tryPromise({
          try: () => fetch(url),
          catch: captureOnboardingFailure,
        }),
        ({ cause }) => {
          if (Panic.is(cause)) return preserveToolPanic(cause);
          return onboardingFailure("unavailable", errorMessage(cause));
        },
      ),
    );
    if (!res.ok) {
      return Result.err(
        onboardingFailure("unavailable", `Download failed (${res.status}): ${url}`),
      );
    }
    yield* Result.await(
      settleCapturedPromise(
        Result.tryPromise({
          try: () => Bun.write(filePath, res).then(() => undefined),
          catch: captureOnboardingFailure,
        }),
        ({ cause }) => {
          if (Panic.is(cause)) return preserveToolPanic(cause);
          return onboardingFailure("unavailable", errorMessage(cause));
        },
      ),
    );
    return Result.ok(undefined);
  });
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

export class GithubReleaseResponseInvalid extends TaggedError("GithubReleaseResponseInvalid")<{
  readonly message: string;
}> {}

export function decodeGithubReleaseResponse(
  value: unknown,
): ResultType<GithubRelease, GithubReleaseResponseInvalid> {
  const decoded = githubReleaseSchema.safeParse(value);
  if (decoded.success) return Result.ok(decoded.data);
  return Result.err(
    new GithubReleaseResponseInvalid({ message: "GitHub returned an invalid release response" }),
  );
}

async function fetchGithubLatestRelease(
  repo: string,
): Promise<ResultType<GithubRelease, ServerToolFailure>> {
  return Result.gen(async function* () {
    const res = yield* Result.await(
      settleCapturedPromise(
        Result.tryPromise({
          try: () => fetch(`https://api.github.com/repos/${repo}/releases/latest`),
          catch: captureOnboardingFailure,
        }),
        ({ cause }) => {
          if (Panic.is(cause)) return preserveToolPanic(cause);
          return onboardingFailure("unavailable", errorMessage(cause));
        },
      ),
    );
    if (!res.ok) {
      return Result.err(
        onboardingFailure(
          "unavailable",
          `GitHub releases/latest failed (${res.status} ${res.statusText}) for ${repo}`,
        ),
      );
    }
    const raw = yield* Result.await(
      settleCapturedPromise(
        Result.tryPromise({
          try: async () => (await res.json()) as unknown,
          catch: captureOnboardingFailure,
        }),
        ({ cause }) => {
          if (Panic.is(cause)) return preserveToolPanic(cause);
          return onboardingFailure("unavailable", errorMessage(cause));
        },
      ),
    );
    return decodeGithubReleaseResponse(raw).match<
      () => ResultType<GithubRelease, ServerToolFailure>
    >({
      ok: (value) => () => Result.ok(value),
      err: (error) => () => {
        if (Panic.is(error)) return preserveToolPanic(error);
        return Result.err(onboardingFailure("unavailable", `${error.message} for ${repo}`));
      },
    })();
  });
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
}): Promise<
  ResultType<{ status: DefaultInstallStatus; details?: Record<string, unknown> }, ServerToolFailure>
> {
  return Result.gen(async function* () {
    const existed = await Bun.file(params.destPath).exists();
    if (existed && !params.overwrite) {
      return Result.ok({ status: "already_present" as const });
    }

    if (!params.network) {
      return Result.ok({
        status: "skipped" as const,
        details: { reason: "network disabled" },
      });
    }

    if (process.platform !== "linux") {
      return Result.ok({
        status: "skipped" as const,
        details: { reason: "unsupported platform", platform: process.platform },
      });
    }

    const tarBin = Bun.which("tar");
    if (!tarBin) {
      return Result.err(
        onboardingFailure(
          "unavailable",
          "Missing dependency: tar (required to extract GitHub releases)",
        ),
      );
    }

    const release = yield* Result.await(fetchGithubLatestRelease(params.repo));
    const version = stripLeadingV(release.tag_name);
    const arch = platformArchLabel();

    const tarName = params.tarAssetName(version, arch);
    const checksumName = params.checksumAssetName(version);

    const tarAsset = release.assets.find((a) => a.name === tarName);
    if (!tarAsset) {
      return Result.err(
        onboardingFailure(
          "not_found",
          `Asset not found in ${params.repo} ${release.tag_name}: ${tarName}`,
        ),
      );
    }

    const checksumAsset = release.assets.find((a) => a.name === checksumName);
    if (!checksumAsset) {
      return Result.err(
        onboardingFailure(
          "not_found",
          `Checksums asset not found in ${params.repo} ${release.tag_name}: ${checksumName}`,
        ),
      );
    }

    await fs.mkdir(params.tmpDir, { recursive: true });

    const tarPath = path.join(params.tmpDir, `${params.repo.replaceAll("/", "-")}-${tarName}`);
    const checksumsPath = path.join(
      params.tmpDir,
      `${params.repo.replaceAll("/", "-")}-${checksumName}`,
    );

    yield* Result.await(downloadToFile(tarAsset.browser_download_url, tarPath));
    yield* Result.await(downloadToFile(checksumAsset.browser_download_url, checksumsPath));

    const checksumRaw = await Bun.file(checksumsPath).text();
    const byName = parseChecksumsText(checksumRaw);
    const expected = byName.get(tarName);
    if (!expected) {
      return Result.err(
        onboardingFailure("unavailable", `No checksum entry for ${tarName} in ${checksumName}`),
      );
    }

    const got = await sha256Hex(tarPath);
    if (got.toLowerCase() !== expected.toLowerCase()) {
      return Result.err(
        onboardingFailure(
          "denied",
          `Checksum mismatch for ${tarName}: expected ${expected}, got ${got}`,
        ),
      );
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
      return Result.err(
        onboardingFailure("unavailable", `tar failed: ${untar.stderr || untar.stdout}`),
      );
    }

    const extracted = await params.findExtractedPath(extractDir);
    if (!extracted) {
      return Result.err(
        onboardingFailure("not_found", `Failed to locate extracted binary from ${tarName}`),
      );
    }

    await fs.mkdir(path.dirname(params.destPath), { recursive: true });
    await fs.copyFile(extracted, params.destPath);
    await fs.chmod(params.destPath, 0o755);

    return Result.ok({
      status: "installed" as const,
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
    });
  });
}

async function hasAnySkillMdUnder(dir: string): Promise<boolean> {
  const accessed = (
    await Result.tryPromise({
      try: () => fs.access(dir),
      catch: captureError,
    })
  ).match<{ readonly kind: "success" } | { readonly kind: "failure"; readonly failure: Error }>({
    ok: () => ({ kind: "success" }),
    err: ({ cause }) => ({ kind: "failure", failure: cause }),
  });
  if (accessed.kind === "failure") {
    if (Panic.is(accessed.failure)) preserveToolPanic(accessed.failure);
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

  constructor(
    private readonly dependencies: {
      fetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
      getGithubViewerLogin: typeof getGithubViewerLoginOrNull;
      getGithubInstallationToken: typeof getGithubInstallationTokenOrThrow;
    } = {
      fetch,
      getGithubViewerLogin: getGithubViewerLoginOrNull,
      getGithubInstallationToken: getGithubInstallationTokenOrThrow,
    },
  ) {}

  private readonly tool = defineServerTool({
    id: this.id,
    callables: ({ callable }) => ({
      "onboarding.bootstrap": callable({
        name: "Onboarding Bootstrap",
        description: "Bootstrap DATA_DIR (core-config.yaml + prompts/*). Hidden by default.",
        inputSchema: bootstrapInputSchema,
        validation: "zod",
        hidden: true,
        run: (input) => this.runCallable("onboarding.bootstrap", input),
      }),
      "onboarding.playwright": callable({
        name: "Onboarding Playwright",
        description:
          "Ensure Chromium is available for Playwright (prefer system chromium; fallback to Playwright install). Hidden by default.",
        inputSchema: playwrightInputSchema,
        validation: "zod",
        hidden: true,
        run: (input) => this.runCallable("onboarding.playwright", input),
      }),
      "onboarding.defaults": callable({
        name: "Onboarding Defaults",
        description: "Install default CLIs + skills into DATA_DIR (persisted). Hidden by default.",
        inputSchema: defaultsInputSchema,
        validation: "zod",
        hidden: true,
        run: (input) => this.runCallable("onboarding.defaults", input),
      }),
      "onboarding.github_app": callable({
        name: "Onboarding GitHub App",
        description:
          "Configure GitHub App credentials for the agent (installs GH_TOKEN/GITHUB_TOKEN in bash env). Hidden by default.",
        inputSchema: githubAppInputSchema,
        validation: "zod",
        hidden: true,
        run: (input) => this.runCallable("onboarding.github_app", input),
      }),
      "onboarding.github_user_token": callable({
        name: "Onboarding GitHub User Token",
        description:
          "Configure GitHub user outbound auth via PAT/fine-grained PAT (preferred for GH_TOKEN/GITHUB_TOKEN in bash env). Hidden by default.",
        inputSchema: githubUserTokenInputSchema,
        validation: "zod",
        hidden: true,
        run: (input) => this.runCallable("onboarding.github_user_token", input),
      }),
      "onboarding.vcs_env": callable({
        name: "Onboarding VCS Env",
        description:
          "Show effective GIT_CONFIG_GLOBAL and GNUPGHOME paths under DATA_DIR. Hidden by default.",
        inputSchema: vcsEnvInputSchema,
        validation: "zod",
        hidden: true,
        run: (input) => this.runCallable("onboarding.vcs_env", input),
      }),
      "onboarding.git_identity": callable({
        name: "Onboarding Git Identity",
        description:
          "Configure agent git identity (name/email) and optional GPG signing, persisted under DATA_DIR. Hidden by default.",
        inputSchema: gitIdentityInputSchema,
        validation: "zod",
        hidden: true,
        run: (input) => this.runCallable("onboarding.git_identity", input),
      }),
      "onboarding.gnupg": callable({
        name: "Onboarding GnuPG",
        description:
          "Generate/export a no-passphrase GPG key for commit signing (stored under DATA_DIR/secret). Hidden by default.",
        inputSchema: gnupgInputSchema,
        validation: "zod",
        hidden: true,
        run: (input) => this.runCallable("onboarding.gnupg", input),
      }),
      "onboarding.reload_tools": callable({
        name: "Onboarding Reload Tools",
        description: "Reload tool instances. Hidden by default.",
        inputSchema: z.object({}),
        validation: "zod",
        hidden: true,
        run: (input) => this.runCallable("onboarding.reload_tools", input),
      }),
      "onboarding.reload_config": callable({
        name: "Onboarding Reload Config",
        description: "Reload core config cache (or restart process). Hidden by default.",
        inputSchema: reloadConfigInputSchema,
        validation: "zod",
        hidden: true,
        run: (input) => this.runCallable("onboarding.reload_config", input),
      }),
      "onboarding.restart": callable({
        name: "Onboarding Restart",
        description: "Exit the process (docker/systemd should restart it). Hidden by default.",
        inputSchema: z.object({}),
        validation: "zod",
        hidden: true,
        run: (input) => this.runCallable("onboarding.restart", input),
      }),
      "onboarding.all": callable({
        name: "Onboarding All",
        description:
          "Run bootstrap + playwright check/install + defaults + config reload (and optional restart). Hidden by default.",
        inputSchema: allInputSchema,
        validation: "zod",
        hidden: true,
        run: (input) => this.runCallable("onboarding.all", input),
      }),
    }),
  });

  async init(): Promise<void> {
    await this.tool.init();
  }

  async destroy(): Promise<void> {
    await this.tool.destroy();
  }

  async list() {
    return this.tool.list();
  }

  async call(
    callableId: string,
    rawInput: Record<string, unknown>,
    opts?: ServerToolCallOptions,
  ): Promise<ServerToolResult> {
    return this.tool.call(callableId, rawInput, opts);
  }

  private async runCallable(
    callableId: string,
    rawInput: Record<string, unknown>,
  ): Promise<ServerToolResult> {
    const captureOperation = <T>(
      operation: () => Promise<T>,
      kind: ServerToolFailure["kind"] = "unavailable",
      fallbackMessage?: string,
    ): Promise<ResultType<T, ServerToolFailure>> =>
      settleCapturedPromise(
        Result.tryPromise({
          try: operation,
          catch: captureOnboardingFailure,
        }),
        ({ cause, code, name }) => {
          if (Panic.is(cause)) return preserveToolPanic(cause);
          let classifiedKind = kind;
          switch (true) {
            case code === "EACCES" || code === "EPERM":
              classifiedKind = "denied";
              break;
            case code === "ENOENT":
              classifiedKind = "not_found";
              break;
            case name === "AbortError":
              classifiedKind = "cancelled";
              break;
            case name === "TimeoutError" || name === "timeout" || code === "ETIMEDOUT":
              classifiedKind = "timeout";
              break;
          }
          return onboardingFailure(
            classifiedKind,
            cause.message || fallbackMessage || errorMessage(cause),
          );
        },
      );

    return Result.gen(
      async function* (this: Onboarding) {
        if (callableId === "onboarding.vcs_env") {
          const input = rawInput as z.output<typeof vcsEnvInputSchema>;
          const dataDir = input.dataDir ?? env.dataDir;
          const paths = resolveVcsPaths(dataDir);

          return Result.ok({
            ok: true as const,
            dataDir: paths.dataDir,
            gitConfigGlobal: paths.gitConfigGlobal,
            gnupgHome: paths.gnupgHome,
            xdgConfigHome: paths.xdgConfigHome,
          });
        }

        if (callableId === "onboarding.gnupg") {
          const input = rawInput as z.output<typeof gnupgInputSchema>;
          const dataDir = input.dataDir ?? env.dataDir;
          const paths = resolveVcsPaths(dataDir);
          yield* Result.await(captureOperation(() => ensureVcsDirs(paths)));
          const vcsEnv = buildVcsEnv(paths);

          const gpgBin = Bun.which("gpg");
          if (!gpgBin) {
            return Result.err(
              onboardingFailure(
                "unavailable",
                "Missing dependency: gpg (install gnupg). Required for commit signing.",
              ),
            );
          }

          if (input.mode === "clear") {
            yield* Result.await(
              captureOperation(async () => {
                await fs.rm(paths.gnupgHome, { recursive: true, force: true });
                await ensureDir0700(paths.gnupgHome);
              }),
            );
            return Result.ok({ ok: true as const, dataDir: paths.dataDir, cleared: true as const });
          }

          const list = await runGpg({
            args: ["--list-secret-keys", "--with-colons"],
            env: vcsEnv,
          });
          const existingFpr = list.code === 0 ? parseFirstGpgFingerprint(list.stdout) : null;

          if (input.mode === "status") {
            return Result.ok({
              ok: true as const,
              dataDir: paths.dataDir,
              gnupgHome: paths.gnupgHome,
              hasSecretKey: Boolean(existingFpr),
              fingerprint: existingFpr ?? undefined,
            });
          }

          if (input.mode === "generate") {
            if (existingFpr) {
              return Result.ok({
                ok: true as const,
                dataDir: paths.dataDir,
                generated: false as const,
                fingerprint: existingFpr,
                status: "already_present" as const,
              });
            }

            const userName = input.userName ?? "lilac-agent[bot]";
            const userEmail = input.userEmail ?? "lilac-agent[bot]@users.noreply.github.com";
            const comment = input.uidComment ? ` (${input.uidComment})` : "";
            const uid = `${userName}${comment} <${userEmail}>`;

            // Ensure loopback pinentry works even if gpg decides to ask.
            yield* Result.await(
              captureOperation(() =>
                fs.writeFile(
                  path.join(paths.gnupgHome, "gpg-agent.conf"),
                  "allow-loopback-pinentry\n",
                  "utf8",
                ),
              ),
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
              return Result.err(
                onboardingFailure(
                  "unavailable",
                  gen.stderr || gen.stdout || "gpg key generation failed",
                ),
              );
            }

            const after = await runGpg({
              args: ["--list-secret-keys", "--with-colons"],
              env: vcsEnv,
            });
            const fingerprint = after.code === 0 ? parseFirstGpgFingerprint(after.stdout) : null;
            if (!fingerprint) {
              return Result.err(
                onboardingFailure(
                  "internal",
                  "gpg key generation succeeded, but no secret key fingerprint was found",
                ),
              );
            }

            return Result.ok({
              ok: true as const,
              dataDir: paths.dataDir,
              generated: true as const,
              fingerprint,
              status: "generated" as const,
            });
          }

          if (input.mode === "export_public") {
            const fingerprint = input.fingerprint ?? existingFpr;
            if (!fingerprint) {
              return Result.err(onboardingFailure("not_found", "No secret key found to export"));
            }

            const exp = await runGpg({
              args: ["--armor", "--export", fingerprint],
              env: vcsEnv,
            });
            if (exp.code !== 0) {
              return Result.err(
                onboardingFailure("unavailable", exp.stderr || exp.stdout || "gpg export failed"),
              );
            }

            return Result.ok({
              ok: true as const,
              dataDir: paths.dataDir,
              fingerprint,
              publicKeyArmored: exp.stdout,
            });
          }

          const _exhaustive: never = input.mode;
          return Result.err(onboardingFailure("internal", String(_exhaustive)));
        }

        if (callableId === "onboarding.git_identity") {
          const input = rawInput as z.output<typeof gitIdentityInputSchema>;
          const dataDir = input.dataDir ?? env.dataDir;
          const paths = resolveVcsPaths(dataDir);
          yield* Result.await(captureOperation(() => ensureVcsDirs(paths)));
          const vcsEnv = buildVcsEnv(paths);

          const get = async (key: string): Promise<string | undefined> => {
            const res = await runGit({ args: ["config", "--global", "--get", key], env: vcsEnv });
            if (res.code !== 0) return undefined;
            const v = res.stdout.trim();
            return v.length > 0 ? v : undefined;
          };

          const unsetAll = async (key: string) => {
            const res = await runGit({
              args: ["config", "--global", "--unset-all", key],
              env: vcsEnv,
            });
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

            return Result.ok({
              ok: true as const,
              dataDir: paths.dataDir,
              gitConfigGlobal: paths.gitConfigGlobal,
              userName,
              userEmail,
              signingKey,
              commitGpgSign: commitSign,
              tagGpgSign: tagSign,
              gpgProgram,
            });
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
            return Result.ok({ ok: true as const, dataDir: paths.dataDir, cleared });
          }

          if (input.mode === "configure") {
            if (!input.userName)
              return Result.err(onboardingFailure("usage", "Missing required input: userName"));
            if (!input.userEmail)
              return Result.err(onboardingFailure("usage", "Missing required input: userEmail"));

            const set = async (
              key: string,
              value: string,
            ): Promise<ResultType<void, ServerToolFailure>> => {
              const res = await runGit({
                args: ["config", "--global", key, value],
                env: vcsEnv,
              });
              if (res.code !== 0) {
                return Result.err(
                  onboardingFailure(
                    "unavailable",
                    res.stderr || res.stdout || `git config failed: ${key}`,
                  ),
                );
              }
              return Result.ok(undefined);
            };

            yield* Result.await(set("user.name", input.userName));
            yield* Result.await(set("user.email", input.userEmail));

            if (input.enableSigning) {
              const signingKey = input.signingKey;
              if (!signingKey) {
                return Result.err(
                  onboardingFailure(
                    "usage",
                    "Missing required input: signingKey (required when enableSigning=true)",
                  ),
                );
              }

              yield* Result.await(set("gpg.program", "gpg"));
              yield* Result.await(set("user.signingkey", signingKey));
              yield* Result.await(set("commit.gpgsign", "true"));
              yield* Result.await(set("tag.gpgsign", "true"));
            } else {
              await unsetAll("user.signingkey");
              await unsetAll("commit.gpgsign");
              await unsetAll("tag.gpgsign");
              await unsetAll("gpg.program");
            }

            return Result.ok({
              ok: true as const,
              dataDir: paths.dataDir,
              configured: true as const,
            });
          }

          if (input.mode === "test") {
            yield* Result.await(
              captureOperation(() => fs.mkdir(paths.tmpDir, { recursive: true })),
            );
            const repoDir = yield* Result.await(
              captureOperation(() => fs.mkdtemp(path.join(paths.tmpDir, "git-test-"))),
            );

            const init = await runGit({ args: ["init"], cwd: repoDir, env: vcsEnv });
            if (init.code !== 0) {
              return Result.err(
                onboardingFailure("unavailable", init.stderr || init.stdout || "git init failed"),
              );
            }

            yield* Result.await(
              captureOperation(() =>
                fs.writeFile(path.join(repoDir, "README.md"), "test\n", "utf8"),
              ),
            );
            const add = await runGit({ args: ["add", "README.md"], cwd: repoDir, env: vcsEnv });
            if (add.code !== 0) {
              return Result.err(
                onboardingFailure("unavailable", add.stderr || add.stdout || "git add failed"),
              );
            }

            const commit = await runGit({
              args: ["commit", "-m", "test commit"],
              cwd: repoDir,
              env: vcsEnv,
            });
            const ok = commit.code === 0;

            return Result.ok({
              ok: true as const,
              dataDir: paths.dataDir,
              repoDir,
              committed: ok,
              exitCode: commit.code,
              stdout: commit.stdout,
              stderr: commit.stderr,
            });
          }

          const _exhaustive: never = input.mode;
          return Result.err(onboardingFailure("internal", String(_exhaustive)));
        }

        if (callableId === "onboarding.bootstrap") {
          const input = rawInput as z.output<typeof bootstrapInputSchema>;
          const dataDir = input.dataDir ?? env.dataDir;

          const ensuredDirs: string[] = [];
          for (const sub of ["prompts", "skills", "secret", "workspace"]) {
            const p = path.join(dataDir, sub);
            yield* Result.await(captureOperation(() => fs.mkdir(p, { recursive: true })));
            ensuredDirs.push(p);
          }

          const config = yield* Result.await(
            captureOperation(() =>
              seedCoreConfig({
                dataDir,
                overwrite: input.overwriteConfig,
              }),
            ),
          );

          const prompts = yield* Result.await(
            captureOperation(() =>
              ensurePromptWorkspace({
                dataDir,
                overwrite: input.overwritePrompts,
              }),
            ),
          );

          return Result.ok({
            ok: true as const,
            dataDir,
            ensuredDirs,
            config,
            prompts,
          });
        }

        if (callableId === "onboarding.playwright") {
          const input = rawInput as z.output<typeof playwrightInputSchema>;

          const systemPath = await findSystemChromiumExecutable();
          if (systemPath) {
            return Result.ok({
              ok: true as const,
              strategy: "system" as const,
              executablePath: systemPath,
              installed: false,
              notes: [
                "Using system chromium.",
                "If Playwright fails to launch, try onboarding.playwright withDeps=true as root or use Playwright-managed chromium.",
              ],
            });
          }

          const pw = yield* Result.await(
            ensurePlaywrightChromiumInstalled({
              withDeps: input.withDeps,
            }),
          );

          return Result.ok({
            ok: true as const,
            strategy: "playwright" as const,
            executablePath: pw.executablePath,
            installed: pw.installed,
            notes: ["System chromium not found; using Playwright-managed chromium."],
          });
        }

        if (callableId === "onboarding.defaults") {
          const input = rawInput as z.output<typeof defaultsInputSchema>;
          const dataDir = input.dataDir ?? env.dataDir;

          const paths = resolveDefaultInstallPaths(dataDir);
          const installEnv = buildInstallEnv(paths);
          const bunBin = Bun.which("bun") ?? "bun";

          yield* Result.await(
            captureOperation(async () => {
              await Promise.all(
                [
                  paths.binDir,
                  paths.bunGlobalDir,
                  paths.bunCacheDir,
                  paths.npmPrefix,
                  paths.xdgConfigHome,
                  paths.tmpDir,
                  paths.lilacSkillsDir,
                ].map((directory) => fs.mkdir(directory, { recursive: true })),
              );
            }),
          );

          const steps: DefaultInstallStep[] = [];

          const runStep = async (
            id: string,
            fn: () => Promise<ResultType<Omit<DefaultInstallStep, "id">, ServerToolFailure>>,
          ): Promise<ResultType<void, ServerToolFailure>> => {
            const attempted = (await captureOperation(fn)).andThen((result) => result);
            return attempted.match({
              ok: (step) => {
                steps.push({ id, ...step });
                return Result.ok(undefined);
              },
              err: (failure) => {
                if (input.strict) return Result.err(failure);
                steps.push({ id, status: "failed", error: failure.message });
                return Result.ok(undefined);
              },
            });
          };

          yield* Result.await(
            runStep("skills.mcporter", () =>
              Result.gen(async function* () {
                const workspaceRoot = yield* requireWorkspaceRoot();
                const src = path.join(
                  workspaceRoot,
                  "packages",
                  "utils",
                  "skill-templates",
                  "mcporter",
                  "SKILL.md",
                );
                const dst = path.join(paths.lilacSkillsDir, "mcporter", "SKILL.md");
                const { copied, overwritten } = await copyFileIfNeeded({
                  from: src,
                  to: dst,
                  overwrite: input.overwriteSkills,
                });
                return Result.ok({
                  status: copied ? ("installed" as const) : ("already_present" as const),
                  details: { src, dst, overwritten },
                });
              }),
            ),
          );

          yield* Result.await(
            runStep("skills.gog", () =>
              Result.gen(async function* () {
                const workspaceRoot = yield* requireWorkspaceRoot();
                const src = path.join(
                  workspaceRoot,
                  "packages",
                  "utils",
                  "skill-templates",
                  "gog",
                  "SKILL.md",
                );
                const dst = path.join(paths.lilacSkillsDir, "gog", "SKILL.md");
                const { copied, overwritten } = await copyFileIfNeeded({
                  from: src,
                  to: dst,
                  overwrite: input.overwriteSkills,
                });
                return Result.ok({
                  status: copied ? ("installed" as const) : ("already_present" as const),
                  details: { src, dst, overwritten },
                });
              }),
            ),
          );

          yield* Result.await(
            runStep("cli.mcporter", async () => {
              const dest = path.join(paths.binDir, "mcporter");
              if (await Bun.file(dest).exists()) return Result.ok({ status: "already_present" });
              if (!input.network) {
                return Result.ok({ status: "skipped", details: { reason: "network disabled" } });
              }

              const res = await runCommand({
                cmd: [bunBin, "install", "--global", "mcporter"],
                env: installEnv,
              });
              if (res.code !== 0) {
                return Result.err(
                  onboardingFailure(
                    "unavailable",
                    res.stderr || res.stdout || "bun install failed",
                  ),
                );
              }

              const installed = await Bun.file(dest).exists();
              if (!installed) {
                return Result.ok({
                  status: "failed",
                  error: `bun install succeeded but ${dest} not found`,
                });
              }

              return Result.ok({ status: "installed", details: { dest } });
            }),
          );

          yield* Result.await(
            runStep("cli.agent-browser", async () => {
              const dest = path.join(paths.binDir, "agent-browser");
              if (await Bun.file(dest).exists()) return Result.ok({ status: "already_present" });
              if (!input.network) {
                return Result.ok({ status: "skipped", details: { reason: "network disabled" } });
              }

              const res = await runCommand({
                cmd: [bunBin, "install", "--global", "agent-browser"],
                env: installEnv,
              });
              if (res.code !== 0) {
                return Result.err(
                  onboardingFailure(
                    "unavailable",
                    res.stderr || res.stdout || "bun install failed",
                  ),
                );
              }

              const installed = await Bun.file(dest).exists();
              if (!installed) {
                return Result.ok({
                  status: "failed",
                  error: `bun install succeeded but ${dest} not found`,
                });
              }

              return Result.ok({ status: "installed", details: { dest } });
            }),
          );

          yield* Result.await(
            runStep("skill.agent-browser", async () => {
              const opencodeSkillsDir = path.join(paths.xdgConfigHome, "opencode", "skills");
              if (await hasAnySkillMdUnder(opencodeSkillsDir)) {
                return Result.ok({ status: "already_present", details: { opencodeSkillsDir } });
              }
              if (!input.network) {
                return Result.ok({ status: "skipped", details: { reason: "network disabled" } });
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
                return Result.err(
                  onboardingFailure(
                    "unavailable",
                    res.stderr || res.stdout || "`skills add` failed",
                  ),
                );
              }

              const installedNow = await hasAnySkillMdUnder(opencodeSkillsDir);
              return Result.ok({
                status: installedNow ? "installed" : "failed",
                details: { opencodeSkillsDir },
                error: installedNow ? undefined : "skill install ran but no SKILL.md found",
              });
            }),
          );

          yield* Result.await(
            runStep("cli.gh", () =>
              Result.gen(async function* () {
                const dest = path.join(paths.binDir, "gh");
                const result = yield* Result.await(
                  installGithubTarGzBinary({
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
                  }),
                );
                return Result.ok({ status: result.status, details: result.details });
              }),
            ),
          );

          yield* Result.await(
            runStep("cli.gog", () =>
              Result.gen(async function* () {
                const dest = path.join(paths.binDir, "gog");
                const result = yield* Result.await(
                  installGithubTarGzBinary({
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
                  }),
                );
                return Result.ok({ status: result.status, details: result.details });
              }),
            ),
          );

          return Result.ok({
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
          });
        }

        if (callableId === "onboarding.github_user_token") {
          const input = rawInput as z.output<typeof githubUserTokenInputSchema>;
          const dataDir = input.dataDir ?? env.dataDir;

          const normalizeHost = (h: string | undefined) =>
            (() => {
              const trimmed = h?.trim();
              if (!trimmed) return undefined;
              const cleaned = trimmed.replace(/^https?:\/\//, "").replace(/\/+$/, "");
              return cleaned.length > 0 ? cleaned : undefined;
            })();

          if (input.mode === "status") {
            const secret = yield* Result.await(
              captureOperation(() => readGithubUserTokenSecret(dataDir)),
            );
            const apiBaseUrl = secret
              ? deriveApiBaseUrl({
                  host: secret.host,
                  apiBaseUrl: secret.apiBaseUrl,
                })
              : undefined;
            return Result.ok({
              ok: true as const,
              dataDir,
              configured: Boolean(secret),
              bashEnvVars: githubBashEnvDocs,
              ...(secret
                ? {
                    host: secret.host,
                    apiBaseUrl,
                    login: secret.login,
                  }
                : {}),
            });
          }

          if (input.mode === "clear") {
            yield* Result.await(captureOperation(() => clearGithubUserTokenSecret(dataDir)));
            return Result.ok({ ok: true as const, dataDir, cleared: true as const });
          }

          if (input.mode === "configure") {
            if (!input.token) {
              return Result.err(onboardingFailure("usage", "Missing required input: token"));
            }

            const token = input.token.trim();
            if (!token) {
              return Result.err(onboardingFailure("usage", "Input token is empty"));
            }

            const host = normalizeHost(input.host);
            const apiBaseUrl = input.apiBaseUrl ?? deriveApiBaseUrl({ host });
            const loginAttempt = await captureOperation(() =>
              this.dependencies.getGithubViewerLogin({ apiBaseUrl, token }),
            );
            const login = loginAttempt.match({
              ok: (value) => value,
              err: () => null,
            });

            const wrote = yield* Result.await(
              captureOperation(() =>
                writeGithubUserTokenSecret({
                  dataDir,
                  token,
                  host,
                  apiBaseUrl,
                  login: login ?? undefined,
                }),
              ),
            );

            return Result.ok({
              ok: true as const,
              dataDir,
              configured: true as const,
              bashEnvVars: githubBashEnvDocs,
              host,
              apiBaseUrl,
              login,
              jsonPath: wrote.jsonPath,
              overwritten: wrote.overwritten,
            });
          }

          if (input.mode === "test") {
            const secret = yield* Result.await(
              captureOperation(() => readGithubUserTokenSecret(dataDir)),
            );
            if (!secret) {
              return Result.err(
                onboardingFailure(
                  "conflict",
                  "GitHub user token not configured (run onboarding.github_user_token mode=configure)",
                ),
              );
            }

            const apiBaseUrl = deriveApiBaseUrl({
              host: secret.host,
              apiBaseUrl: secret.apiBaseUrl,
            });
            const login = yield* Result.await(
              captureOperation(() =>
                this.dependencies.getGithubViewerLogin({
                  apiBaseUrl,
                  token: secret.token,
                }),
              ),
            );
            if (!login) {
              return Result.err(
                onboardingFailure(
                  "denied",
                  `GitHub API test failed at ${apiBaseUrl}/user (invalid token or permissions)`,
                ),
              );
            }

            if (secret.login !== login) {
              yield* Result.await(
                captureOperation(() =>
                  writeGithubUserTokenSecret({
                    dataDir,
                    token: secret.token,
                    host: secret.host,
                    apiBaseUrl: secret.apiBaseUrl,
                    login,
                  }),
                ),
              );
            }

            return Result.ok({
              ok: true as const,
              dataDir,
              bashEnvVars: githubBashEnvDocs,
              host: secret.host,
              apiBaseUrl,
              login,
            });
          }

          const _exhaustive: never = input.mode;
          return Result.err(onboardingFailure("internal", String(_exhaustive)));
        }

        if (callableId === "onboarding.github_app") {
          const input = rawInput as z.output<typeof githubAppInputSchema>;
          const dataDir = input.dataDir ?? env.dataDir;

          const normalizeHost = (h: string | undefined) =>
            (() => {
              const trimmed = h?.trim();
              if (!trimmed) return undefined;
              const cleaned = trimmed.replace(/^https?:\/\//, "").replace(/\/+$/, "");
              return cleaned.length > 0 ? cleaned : undefined;
            })();

          if (input.mode === "status") {
            const secret = yield* Result.await(
              captureOperation(() => readGithubAppSecret(dataDir)),
            );
            const apiBaseUrl = secret
              ? deriveApiBaseUrl({
                  host: secret.host,
                  apiBaseUrl: secret.apiBaseUrl,
                })
              : undefined;
            return Result.ok({
              ok: true as const,
              dataDir,
              configured: Boolean(secret),
              bashEnvVars: githubBashEnvDocs,
              ...(secret
                ? {
                    appId: secret.appId,
                    installationId: secret.installationId,
                    host: secret.host,
                    apiBaseUrl,
                    privateKeyPath: secret.privateKeyPath,
                  }
                : {}),
            });
          }

          if (input.mode === "clear") {
            yield* Result.await(captureOperation(() => clearGithubAppSecret(dataDir)));
            return Result.ok({ ok: true as const, dataDir, cleared: true as const });
          }

          if (input.mode === "configure") {
            if (!input.appId) {
              return Result.err(onboardingFailure("usage", "Missing required input: appId"));
            }
            if (!input.installationId) {
              return Result.err(
                onboardingFailure("usage", "Missing required input: installationId"),
              );
            }

            let privateKeyPem = input.privateKeyPem ?? null;
            if (!privateKeyPem && input.privateKeyPath) {
              privateKeyPem = yield* Result.await(
                captureOperation(
                  () => Bun.file(input.privateKeyPath!).text(),
                  "not_found",
                  "Private key file could not be read",
                ),
              );
            }
            if (!privateKeyPem) {
              return Result.err(
                onboardingFailure(
                  "usage",
                  "Missing required input: privateKeyPem or privateKeyPath",
                ),
              );
            }

            const host = normalizeHost(input.host);
            const apiBaseUrl = input.apiBaseUrl ?? deriveApiBaseUrl({ host });

            const wrote = yield* Result.await(
              captureOperation(() =>
                writeGithubAppSecret({
                  dataDir,
                  appId: input.appId!,
                  installationId: input.installationId!,
                  host,
                  apiBaseUrl,
                  privateKeyPem,
                }),
              ),
            );

            return Result.ok({
              ok: true as const,
              dataDir,
              configured: true as const,
              bashEnvVars: githubBashEnvDocs,
              appId: input.appId,
              installationId: input.installationId,
              host,
              apiBaseUrl,
              jsonPath: wrote.jsonPath,
              pemPath: wrote.pemPath,
              overwritten: wrote.overwritten,
            });
          }

          if (input.mode === "test") {
            const t = yield* Result.await(
              captureOperation(
                () => this.dependencies.getGithubInstallationToken({ dataDir }),
                "unavailable",
                "GitHub App token is unavailable",
              ),
            );
            const res = yield* Result.await(
              captureOperation(() =>
                this.dependencies.fetch(`${t.apiBaseUrl}/installation/repositories?per_page=1`, {
                  headers: {
                    "User-Agent": "lilac-onboarding",
                    Accept: "application/vnd.github+json",
                    Authorization: `token ${t.token}`,
                  },
                }),
              ),
            );
            if (!res.ok) {
              return Result.err(
                onboardingFailure(
                  res.status === 401 || res.status === 403 ? "denied" : "unavailable",
                  `GitHub API test failed (${res.status} ${res.statusText}) at ${t.apiBaseUrl}`,
                ),
              );
            }

            const body = yield* Result.await(
              captureOperation(async () => (await res.json()) as unknown),
            );
            const repoCount = decodeGithubInstallationRepositoriesCount(body);

            return Result.ok({
              ok: true as const,
              dataDir,
              bashEnvVars: githubBashEnvDocs,
              host: t.host,
              apiBaseUrl: t.apiBaseUrl,
              expiresAtMs: t.expiresAtMs,
              repoCount,
            });
          }

          const _exhaustive: never = input.mode;
          return Result.err(onboardingFailure("internal", String(_exhaustive)));
        }

        if (callableId === "onboarding.reload_tools") {
          return Result.ok({ ok: true as const });
        }

        if (callableId === "onboarding.reload_config") {
          const input = rawInput as z.output<typeof reloadConfigInputSchema>;

          if (input.mode === "restart") {
            return Result.ok(scheduleRestart());
          }

          const cfg = yield* Result.await(
            captureOperation(() => getCoreConfig({ forceReload: true })),
          );
          return Result.ok({
            ok: true as const,
            mode: "cache" as const,
            dataDir: env.dataDir,
            coreConfigPath: resolveCoreConfigPath(),
            promptDir: resolvePromptDir(),
            discord: {
              tokenEnv: cfg.surface.discord.tokenEnv,
              botName: cfg.surface.discord.botName,
            },
          });
        }

        if (callableId === "onboarding.restart") {
          return Result.ok(scheduleRestart());
        }

        if (callableId === "onboarding.all") {
          const input = rawInput as z.output<typeof allInputSchema>;
          const dataDir = input.dataDir ?? env.dataDir;

          const bootstrap = yield* Result.await(
            this.runCallable("onboarding.bootstrap", {
              dataDir,
              overwriteConfig: input.overwriteConfig,
              overwritePrompts: input.overwritePrompts,
            }),
          );

          const playwright = yield* Result.await(
            this.runCallable("onboarding.playwright", {
              withDeps: input.playwrightWithDeps,
            }),
          );

          const defaults = yield* Result.await(
            this.runCallable("onboarding.defaults", {
              dataDir,
              overwriteSkills: input.overwriteSkills,
              network: true,
              strict: false,
            }),
          );

          const reloadConfig = yield* Result.await(
            this.runCallable("onboarding.reload_config", {
              mode: "cache",
            }),
          );

          const restart = input.restart ? scheduleRestart() : undefined;

          return Result.ok({
            ok: true as const,
            bootstrap,
            playwright,
            defaults,
            reloadConfig,
            restart,
          });
        }

        return Result.err(onboardingFailure("usage", `Invalid callable ID '${callableId}'`));
      }.bind(this),
    );
  }
}
