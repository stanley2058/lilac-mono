import path from "node:path";
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, chmod, copyFile, rm } from "node:fs/promises";
import { Result, TaggedError } from "better-result";
import { parseDocument, Document } from "yaml";
import { z } from "zod";
import type { SetupDraft } from "./types";
import { writeDataFiles, type DataFileWriter } from "./data-files";
import { command } from "./system";

export class InstallerDeploymentFailed extends TaggedError("InstallerDeploymentFailed")<{
  readonly message: string;
}> {}

export const installerVersion = process.env.LILAC_INSTALLER_VERSION ?? "dev";
export const installerCommit = process.env.LILAC_INSTALLER_COMMIT ?? "dev";

export type ImageReferences = { core: string; gateway: string; runner: string };

const referenceSchema = z
  .string()
  .min(1)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._/:@-]*$/);

export function validateDeploymentInputs(draft: SetupDraft, images: ImageReferences) {
  for (const image of Object.values(images)) {
    if (!referenceSchema.safeParse(image).success)
      return Result.err(
        new InstallerDeploymentFailed({
          message: "An image reference is invalid. Check the LILAC_IMAGE overrides.",
        }),
      );
  }
  for (const [key, value] of Object.entries(draft.secrets)) {
    if (
      !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) ||
      value.includes("\r") ||
      value.includes("\n") ||
      value.includes("\0")
    ) {
      return Result.err(
        new InstallerDeploymentFailed({
          message:
            "An environment credential contains an invalid name or line break. Re-enter the credential before installing.",
        }),
      );
    }
  }
  for (const file of draft.files) {
    const segments = file.relativePath.split(/[\\/]/);
    if (path.isAbsolute(file.relativePath) || segments.includes("..") || segments.includes("")) {
      return Result.err(
        new InstallerDeploymentFailed({ message: "A setup file has an invalid relative path." }),
      );
    }
  }
  return Result.ok(undefined);
}

export function resolveImages(existing?: Document): ImageReferences {
  const stringAt = (parts: string[]) => {
    const value = existing?.getIn(parts);
    return typeof value === "string" ? value : undefined;
  };
  return {
    core:
      process.env.LILAC_IMAGE ??
      stringAt(["services", "lilac", "image"]) ??
      process.env.LILAC_DEFAULT_IMAGE ??
      "ghcr.io/stanley2058/lilac-mono:latest",
    gateway:
      process.env.LILAC_COMPUTER_GATEWAY_IMAGE ??
      stringAt(["services", "computer-use-gateway", "image"]) ??
      process.env.LILAC_DEFAULT_COMPUTER_GATEWAY_IMAGE ??
      "ghcr.io/stanley2058/lilac-computer-gateway:latest",
    runner:
      process.env.LILAC_COMPUTER_RUNNER_IMAGE ??
      stringAt(["services", "computer-use-gateway", "environment", "RUNNER_IMAGE"]) ??
      process.env.LILAC_DEFAULT_COMPUTER_RUNNER_IMAGE ??
      "ghcr.io/stanley2058/lilac-computer:latest",
  };
}

export function readEnvironment(source: string): Record<string, string> {
  const entries: Record<string, string> = {};
  for (const line of source.split(/\r?\n/)) {
    const matched = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (matched?.[1] !== undefined && matched[2] !== undefined) entries[matched[1]] = matched[2];
  }
  return entries;
}

export function serializeEnvironment(values: Record<string, string>): string {
  return (
    Object.entries(values)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => `${key}=${value}`)
      .join("\n") + "\n"
  );
}

export function readOptionalFile(filename: string): Promise<string | undefined> {
  return Bun.file(filename)
    .exists()
    .then((exists) => (exists ? readFile(filename, "utf8") : undefined));
}

export function parseDeployment(source: string) {
  const document = parseDocument(source);
  if (document.errors.length || document.getIn(["services", "lilac"]) === undefined) {
    return Result.err(
      new InstallerDeploymentFailed({
        message:
          "The existing compose.yaml is not a readable Lilac deployment. Choose another directory.",
      }),
    );
  }
  return Result.ok(document);
}

export function createDeployment(
  root: string,
  draft: SetupDraft,
  images: ImageReferences,
  existing?: Document,
) {
  const document = existing?.clone() ?? new Document();
  if (!document.has("name"))
    document.set("name", `lilac-${createHash("sha256").update(root).digest("hex").slice(0, 10)}`);
  if (!existing) {
    document.set(
      "services",
      document.createNode({
        lilac: {
          image: images.core,
          depends_on: { redis: { condition: "service_healthy" } },
          env_file: [{ path: "./secrets.env", format: "raw" }],
          environment: {
            REDIS_URL: "redis://redis:6379",
            DATA_DIR: "/data",
            LL_TOOL_SERVER_PORT: "8080",
            LILAC_WORKSPACE_DIR: "/data/workspace",
            GIT_CONFIG_GLOBAL: "/data/.gitconfig",
            GNUPGHOME: "/data/secret/gnupg",
            BUN_INSTALL_GLOBAL_DIR: "/data/.bun/install/global",
            BUN_INSTALL_BIN: "/data/bin",
            BUN_INSTALL_CACHE_DIR: "/data/.bun/install/cache",
            NPM_CONFIG_PREFIX: "/data/.npm-global",
            XDG_CONFIG_HOME: "/data/.config",
          },
          volumes: ["./data:/data"],
          extra_hosts: ["host.docker.internal:host-gateway"],
          tmpfs: [
            "/run:rw,nosuid,nodev,mode=755,size=64m",
            "/tmp:rw,nosuid,nodev,mode=1777,size=1g",
          ],
          mem_limit: "4g",
          pids_limit: 1024,
          stop_grace_period: "30s",
          healthcheck: {
            test: [
              "CMD",
              "curl",
              "--connect-timeout",
              "1",
              "--max-time",
              "4",
              "-fsS",
              "http://127.0.0.1:8080/readyz",
            ],
            interval: "5s",
            timeout: "5s",
            retries: 12,
            start_period: "30s",
          },
          restart: "unless-stopped",
        },
        redis: {
          image: "redis:7-alpine",
          command: ["redis-server", "--appendonly", "yes"],
          volumes: ["redis-data:/data"],
          healthcheck: {
            test: ["CMD", "redis-cli", "ping"],
            interval: "5s",
            timeout: "3s",
            retries: 20,
          },
          restart: "unless-stopped",
        },
      }),
    );
    document.set("volumes", document.createNode({ "redis-data": {} }));
  }
  document.setIn(["services", "lilac", "image"], images.core);
  document.deleteIn(["services", "lilac", "build"]);
  document.set("x-lilac-installer", { version: installerVersion, commit: installerCommit });
  if (!draft.computerEnabled) return document;
  if (!document.hasIn(["services", "computer-use-gateway"])) {
    document.setIn(
      ["services", "computer-use-gateway"],
      document.createNode({
        image: images.gateway,
        env_file: [{ path: "./secrets.env", format: "raw" }],
        environment: { RUNNER_IMAGE: images.runner },
        volumes: ["/var/run/docker.sock:/var/run/docker.sock", "computer-use-data:/data"],
        ports: ["127.0.0.1:8081:8080"],
        stop_grace_period: "180s",
        healthcheck: {
          test: [
            "CMD",
            "bun",
            "-e",
            "fetch('http://127.0.0.1:8080/health').then(r => process.exit(r.ok ? 0 : 1))",
          ],
          interval: "5s",
          timeout: "5s",
          retries: 12,
          start_period: "60s",
        },
        restart: "unless-stopped",
      }),
    );
    document.setIn(["volumes", "computer-use-data"], {});
  }
  document.setIn(["services", "computer-use-gateway", "image"], images.gateway);
  document.deleteIn(["services", "computer-use-gateway", "build"]);
  document.setIn(
    ["services", "computer-use-gateway", "environment", "RUNNER_IMAGE"],
    images.runner,
  );
  return document;
}

export async function writeInstallation(
  options: {
    root: string;
    draft: SetupDraft;
    config: string;
    compose: string;
    installExecutable: boolean;
    image: string;
  },
  writeData: DataFileWriter = writeDataFiles,
) {
  return Result.gen(async function* () {
    yield* Result.await(
      writeData(
        path.join(options.root, "data"),
        [
          { relativePath: "core-config.yaml", content: options.config, mode: 0o600 },
          ...options.draft.files,
        ],
        options.image,
      ),
    );
    yield* Result.await(
      Result.tryPromise({
        try: async () => {
          const { root, draft } = options;
          await mkdir(root, { recursive: true });
          const files = [
            {
              filename: path.join(root, "secrets.env"),
              content: serializeEnvironment(draft.secrets),
              mode: 0o600,
            },
            { filename: path.join(root, "compose.yaml"), content: options.compose, mode: 0o600 },
          ];
          for (const file of files) {
            await mkdir(path.dirname(file.filename), { recursive: true, mode: 0o700 });
            const temporary = `${file.filename}.${crypto.randomUUID()}.tmp`;
            await Bun.write(temporary, file.content, { mode: file.mode });
            await chmod(temporary, file.mode);
            await rename(temporary, file.filename);
          }
          if (options.installExecutable) {
            const binaryDir = path.join(root, "bin");
            await mkdir(binaryDir, { recursive: true });
            const destination = path.join(binaryDir, "lilac");
            if (process.execPath !== destination) {
              const temporary = `${destination}.tmp`;
              await copyFile(process.execPath, temporary);
              await chmod(temporary, 0o755);
              await rename(temporary, destination);
            }
          }
        },
        catch: () =>
          new InstallerDeploymentFailed({
            message:
              "Could not write installation files. Check directory permissions and free disk space, then rerun setup.",
          }),
      }),
    );
    return Result.ok(undefined);
  });
}

export async function startDeployment(
  root: string,
  images: ImageReferences,
  computerEnabled: boolean,
) {
  return Result.gen(async function* () {
    for (const image of Object.values(images)) {
      if (!referenceSchema.safeParse(image).success)
        return Result.err(
          new InstallerDeploymentFailed({
            message: "An image reference is invalid. Check the LILAC_IMAGE overrides.",
          }),
        );
    }
    if (computerEnabled) {
      const runner = yield* Result.await(
        command(["docker", "pull", images.runner], { inherit: true, timeoutMs: 20 * 60_000 }),
      );
      if (runner.code !== 0)
        return Result.err(
          new InstallerDeploymentFailed({
            message:
              "Could not pull the computer-use runner image. Check the image reference and registry access.",
          }),
        );
    }
    const pull = yield* Result.await(
      command(["docker", "compose", "pull"], { cwd: root, inherit: true, timeoutMs: 20 * 60_000 }),
    );
    if (pull.code !== 0)
      return Result.err(
        new InstallerDeploymentFailed({
          message: "Image pull failed. Check registry access, then rerun the installer to retry.",
        }),
      );
    const args = [
      "docker",
      "compose",
      "up",
      "--detach",
      "--wait",
      "--wait-timeout",
      "180",
      "--force-recreate",
    ];
    const started = yield* Result.await(
      command(args, { cwd: root, inherit: true, timeoutMs: 20 * 60_000 }),
    );
    if (started.code !== 0)
      return Result.err(
        new InstallerDeploymentFailed({
          message:
            "Containers did not become healthy. Run docker compose logs in the installation directory, fix the reported issue, and rerun setup.",
        }),
      );
    return Result.ok(undefined);
  });
}

export async function clearStaging(directory: string) {
  return Result.tryPromise({
    try: () => rm(directory, { recursive: true, force: true }),
    catch: () =>
      new InstallerDeploymentFailed({ message: "Could not remove the temporary setup directory." }),
  });
}
