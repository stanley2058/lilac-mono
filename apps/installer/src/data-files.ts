import path from "node:path";
import { mkdir, readFile } from "node:fs/promises";
import { Result, TaggedError, type Result as ResultType } from "better-result";
import { command } from "./system";
import type { SetupFile } from "./types";

export class InstallerDataFailed extends TaggedError("InstallerDataFailed")<{
  readonly message: string;
}> {}

export const DATA_FILES_PROGRAM = String.raw`
const fs = await import("node:fs/promises");
const path = await import("node:path");
const root = process.argv[1];
const request = await Bun.stdin.json();
const target = (relative) => {
  if (typeof relative !== "string" || path.isAbsolute(relative) || relative.split(/[\\/]/).some((part) => !part || part === "..")) throw new Error("Invalid data path");
  return path.join(root, relative);
};
const ownTree = async (directory) => {
  await fs.chown(directory, 1000, 1000);
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      await fs.lchown(filename, 1000, 1000);
      continue;
    }
    if (entry.isDirectory()) {
      await ownTree(filename);
      continue;
    }
    await fs.chown(filename, 1000, 1000);
  }
};
const run = async () => {
  if (request.action === "read") {
    const content = await fs.readFile(target(request.relativePath), "utf8");
    process.stdout.write(content);
    return;
  }
  if (request.action !== "write" || !Array.isArray(request.files)) throw new Error("Invalid data operation");
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  const previousOwner = (await fs.stat(root)).uid;
  await fs.mkdir(path.join(root, "secret"), { recursive: true, mode: 0o700 });
  await fs.mkdir(path.join(root, "workspace"), { recursive: true, mode: 0o700 });
  await fs.chmod(root, 0o700);
  await fs.chmod(path.join(root, "secret"), 0o700);
  await fs.chown(root, 1000, 1000);
  await fs.chown(path.join(root, "secret"), 1000, 1000);
  await fs.chown(path.join(root, "workspace"), 1000, 1000);
  for (const file of request.files) {
    const filename = target(file.relativePath);
    await fs.mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
    for (let parent = path.dirname(filename); parent !== root; parent = path.dirname(parent)) {
      await fs.chown(parent, 1000, 1000);
    }
    const temporary = filename + "." + crypto.randomUUID() + ".tmp";
    await fs.writeFile(temporary, file.content, { mode: file.mode ?? 0o600 });
    await fs.chmod(temporary, file.mode ?? 0o600);
    await fs.chown(temporary, 1000, 1000);
    await fs.rename(temporary, filename);
  }
  if (previousOwner !== 1000) await ownTree(root);
};
await run().catch((failure) => {
  if (request.action === "read" && failure?.code === "ENOENT") {
    process.exitCode = 44;
    return;
  }
  process.stderr.write("Could not access Lilac data.\n");
  process.exitCode = 1;
});
`;

type DataRequest =
  | { action: "read"; relativePath: string }
  | { action: "write"; files: readonly SetupFile[] };

function validDataPath(relativePath: string): boolean {
  return (
    !path.isAbsolute(relativePath) &&
    !relativePath.split(/[\\/]/).some((part) => !part || part === "..")
  );
}

async function prepareDataImage(image: string): Promise<ResultType<void, InstallerDataFailed>> {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._/:@-]*$/.test(image)) {
    return Result.err(
      new InstallerDataFailed({
        message: "The configured Core image is not a valid image reference.",
      }),
    );
  }
  const prepared = await Result.gen(async function* () {
    const available = yield* Result.await(
      command(["docker", "image", "inspect", image, "--format", "{{.Id}}"]),
    );
    if (available.code === 0) return Result.ok(undefined);
    const pulled = yield* Result.await(
      command(["docker", "pull", image], { inherit: true, timeoutMs: 20 * 60_000 }),
    );
    if (pulled.code !== 0) {
      return Result.err(
        new InstallerDataFailed({
          message:
            "Could not pull the Core image needed to access private data files. Check registry access, then rerun setup.",
        }),
      );
    }
    return Result.ok(undefined);
  });
  return prepared.mapError((failure) => new InstallerDataFailed({ message: failure.message }));
}

async function runDataHelper(
  dataDir: string,
  image: string,
  request: DataRequest,
): Promise<ResultType<{ code: number; stdout: string }, InstallerDataFailed>> {
  const mount = `type=bind,"source=${dataDir.replaceAll('"', '""')}",target=/data${request.action === "read" ? ",readonly" : ""}`;
  return Result.tryPromise({
    try: async () => {
      const child = Bun.spawn(
        [
          "docker",
          "run",
          "--rm",
          "--pull=never",
          "--interactive",
          "--user",
          "0:0",
          "--network",
          "none",
          "--read-only",
          "--mount",
          mount,
          "--entrypoint",
          "/usr/local/bin/bun",
          image,
          "--eval",
          DATA_FILES_PROGRAM,
          "--",
          "/data",
        ],
        {
          stdin: new Blob([JSON.stringify(request)]),
          stdout: "pipe",
          stderr: "pipe",
          signal: AbortSignal.timeout(120_000),
        },
      );
      const [code, stdout] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      return { code, stdout };
    },
    catch: () =>
      new InstallerDataFailed({
        message:
          "Could not access Lilac data through Docker. Check Docker access and the installed Core image.",
      }),
  });
}

export async function readDataFileResult(
  dataDir: string,
  relativePath: string,
  image: string,
): Promise<ResultType<string | undefined, InstallerDataFailed>> {
  if (!validDataPath(relativePath)) {
    return Result.err(
      new InstallerDataFailed({ message: "A setup file has an invalid relative path." }),
    );
  }
  const captured = await Result.tryPromise({
    try: () => readFile(path.join(dataDir, relativePath), "utf8"),
    catch: (cause) => {
      if (cause instanceof Error && "code" in cause && cause.code === "ENOENT")
        return "missing" as const;
      return "protected" as const;
    },
  });
  const decision = captured.match<
    { kind: "found"; content: string } | { kind: "missing" | "protected" }
  >({
    ok: (content) => ({ kind: "found", content }),
    err: (kind) => ({ kind }),
  });
  if (decision.kind === "found") return Result.ok(decision.content);
  if (decision.kind === "missing") return Result.ok(undefined);
  return Result.gen(async function* () {
    yield* Result.await(prepareDataImage(image));
    const { code, stdout } = yield* Result.await(
      runDataHelper(dataDir, image, { action: "read", relativePath }),
    );
    if (code === 0) return Result.ok(stdout);
    if (code === 44) return Result.ok(undefined);
    return Result.err(
      new InstallerDataFailed({
        message:
          "Could not read the existing Lilac data. Check Docker access to the data directory and the installed Core image.",
      }),
    );
  });
}

export async function readSetupFiles(
  dataDir: string,
  image: string,
): Promise<ResultType<Record<string, string>, InstallerDataFailed>> {
  return Result.gen(async function* () {
    const files: Record<string, string> = {};
    for (const relativePath of [
      "core-config.yaml",
      "mcp-config.yaml",
      "secret/codex.json",
      "secret/github-user-token.json",
      "secret/github-app.json",
      "secret/github-app.private-key.pem",
      "secret/computer-use-authorization",
    ]) {
      const content = yield* Result.await(readDataFileResult(dataDir, relativePath, image));
      if (content === undefined) continue;
      files[relativePath] = content;
    }
    return Result.ok(files);
  });
}

export async function writeDataFiles(
  dataDir: string,
  files: readonly SetupFile[],
  image: string,
): Promise<ResultType<void, InstallerDataFailed>> {
  return Result.gen(async function* () {
    yield* Result.await(
      Result.tryPromise({
        try: () => mkdir(dataDir, { recursive: true, mode: 0o700 }),
        catch: () =>
          new InstallerDataFailed({
            message: "Could not create the Lilac data directory. Check directory permissions.",
          }),
      }),
    );
    yield* Result.await(prepareDataImage(image));
    const helper = yield* Result.await(runDataHelper(dataDir, image, { action: "write", files }));
    if (helper.code !== 0)
      return Result.err(
        new InstallerDataFailed({
          message:
            "Could not prepare Lilac data for container UID 1000. Check Docker access and data directory permissions.",
        }),
      );
    return Result.ok(undefined);
  });
}

export type DataFileWriter = typeof writeDataFiles;
