import fsSync from "node:fs";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

import { FileSystem, type FileEdit, type HashlineEdit } from "@stanley2058/lilac-fs";

const PACKAGE_VERSION = "0.0.0";
const DEFAULT_IDLE_MS = 5 * 60 * 1000;
const STARTUP_TIMEOUT_MS = 15_000;
const CONNECT_RETRY_MS = 100;

type JsonObject = Record<string, unknown>;

type RequestEnvelope = {
  op: string;
  input: JsonObject;
  denyPaths: string[];
  cwd: string;
};

type ResponseEnvelope = { ok: true; value: unknown } | { ok: false; error: string };

function isRecord(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function numberOrUndefined(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map((item) => String(item)) : [];
}

function parseEnvelope(value: unknown): RequestEnvelope {
  if (!isRecord(value)) {
    throw new Error("request must be a JSON object");
  }

  const input = value["input"];
  return {
    op: String(value["op"] ?? ""),
    input: isRecord(input) ? input : {},
    denyPaths: stringArray(value["denyPaths"]),
    cwd: typeof value["cwd"] === "string" ? value["cwd"] : process.cwd(),
  };
}

function runtimeBaseDir(): string {
  const fromEnv = process.env.LILAC_REMOTE_FS_RUNNER_DIR;
  if (fromEnv && fromEnv.trim().length > 0) return path.resolve(fromEnv);

  const cacheHome = process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache");
  return path.join(cacheHome, "lilac", "remote-fs-runner", PACKAGE_VERSION);
}

function socketPath(baseDir = runtimeBaseDir()): string {
  if (process.platform === "win32") {
    return `\\\\.\\pipe\\lilac-remote-fs-${PACKAGE_VERSION.replace(/[^a-zA-Z0-9]/g, "-")}`;
  }
  return path.join(baseDir, "daemon.sock");
}

function lockPath(baseDir = runtimeBaseDir()): string {
  return path.join(baseDir, "startup.lock");
}

function fffCacheDir(baseDir = runtimeBaseDir()): string {
  return path.join(baseDir, "fff-cache");
}

async function ensureRuntimeDir(baseDir = runtimeBaseDir()): Promise<void> {
  await fs.mkdir(baseDir, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") {
    await fs.chmod(baseDir, 0o700).catch(() => undefined);
  }
}

async function readStdinJson(): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  const raw = Buffer.concat(chunks).toString("utf8");
  if (raw.trim().length === 0) return {};
  return JSON.parse(raw) as unknown;
}

function writeJson(value: unknown): void {
  process.stdout.write(JSON.stringify(value));
}

function responseError(error: unknown): ResponseEnvelope {
  return { ok: false, error: error instanceof Error ? error.message : String(error) };
}

function normalizeEditOutput(result: unknown): unknown {
  if (!isRecord(result)) return result;
  if (result["success"] === true) {
    return {
      success: true,
      resolvedPath: result["resolvedPath"],
      oldHash: result["oldHash"],
      newHash: result["newHash"],
      changesMade: result["changesMade"],
      replacementsMade: result["replacementsMade"],
    };
  }

  return {
    success: false,
    resolvedPath: result["resolvedPath"],
    currentHash: result["currentHash"],
    error: result["error"],
  };
}

async function handleRequest(envelope: RequestEnvelope): Promise<unknown> {
  const fsTool = new FileSystem(envelope.cwd, {
    denyPaths: envelope.denyPaths,
    fsBackend: "fff",
    fffCacheDir: fffCacheDir(),
  });
  const input = envelope.input;

  if (envelope.op === "fs.read_text") {
    return await fsTool.readFile({
      path: String(input["path"] ?? ""),
      startLine: numberOrUndefined(input["startLine"]),
      maxLines: numberOrUndefined(input["maxLines"]),
      maxCharacters: numberOrUndefined(input["maxCharacters"]),
      format:
        input["format"] === "numbered"
          ? "numbered"
          : input["format"] === "hashline"
            ? "hashline"
            : "raw",
    });
  }

  if (envelope.op === "fs.read_bytes") {
    const result = await fsTool.readFileBytes({ path: String(input["path"] ?? "") });
    if (!result.success) return result;

    const maxBytes = numberOrUndefined(input["maxBytes"]);
    if (maxBytes !== undefined && result.bytesLength > maxBytes) {
      return {
        ok: false,
        resolvedPath: result.resolvedPath,
        error: `Remote file too large (${result.bytesLength} bytes). Max allowed is ${maxBytes}.`,
      };
    }

    return {
      ok: true,
      resolvedPath: result.resolvedPath,
      fileHash: result.fileHash,
      bytesLength: result.bytesLength,
      base64: Buffer.from(result.bytes).toString("base64"),
    };
  }

  if (envelope.op === "fs.glob") {
    return await fsTool.glob({
      patterns: stringArray(input["patterns"]),
      maxEntries: numberOrUndefined(input["maxEntries"]),
      mode: input["mode"] === "detailed" ? "detailed" : "default",
    });
  }

  if (envelope.op === "fs.grep") {
    return await fsTool.grep({
      pattern: String(input["pattern"] ?? ""),
      regex: Boolean(input["regex"]),
      maxResults: numberOrUndefined(input["maxResults"]),
      fileExtensions: stringArray(input["fileExtensions"]).map((ext) => ext.replace(/^\./, "")),
      includeContextLines: numberOrUndefined(input["includeContextLines"]),
      mode:
        input["mode"] === "detailed"
          ? "detailed"
          : input["mode"] === "hashline"
            ? "hashline"
            : "default",
    });
  }

  if (envelope.op === "fs.edit") {
    const pathInput = String(input["path"] ?? "");
    const edits = Array.isArray(input["edits"]) ? input["edits"] : [];
    const expectedHashRaw = input["expectedHash"];
    const expectedHash =
      typeof expectedHashRaw === "string" && expectedHashRaw.length > 0
        ? expectedHashRaw
        : undefined;

    if (input["mode"] === "hashline") {
      return normalizeEditOutput(
        await fsTool.hashlineEditFile({
          path: pathInput,
          edits: edits as HashlineEdit[],
          expectedHash,
        }),
      );
    }

    return normalizeEditOutput(
      await fsTool.editFile({
        path: pathInput,
        edits: edits as FileEdit[],
        expectedHash,
      }),
    );
  }

  if (envelope.op === "health") {
    return { pid: process.pid };
  }

  throw new Error(`Unknown op: ${envelope.op}`);
}

function connectOnce(payload: unknown): Promise<ResponseEnvelope> {
  return new Promise((resolve, reject) => {
    const client = net.createConnection(socketPath());
    let response = "";
    let settled = false;

    const settleReject = (error: unknown) => {
      if (settled) return;
      settled = true;
      client.destroy();
      reject(error);
    };

    client.setEncoding("utf8");
    client.on("connect", () => {
      client.end(JSON.stringify(payload));
    });
    client.on("data", (chunk) => {
      response += chunk;
    });
    client.on("error", settleReject);
    client.on("end", () => {
      if (settled) return;
      settled = true;
      try {
        const parsed = JSON.parse(response) as unknown;
        if (!isRecord(parsed) || typeof parsed["ok"] !== "boolean") {
          resolve({ ok: false, error: "daemon returned invalid response" });
          return;
        }
        resolve(parsed as ResponseEnvelope);
      } catch (error) {
        reject(error);
      }
    });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function spawnDaemon(): void {
  const child = spawn(process.execPath, [process.argv[1] ?? "", "daemon"], {
    detached: true,
    stdio: "ignore",
    env: process.env,
  });
  child.unref();
}

async function tryConnectUntil(
  deadline: number,
  payload: unknown,
): Promise<ResponseEnvelope | null> {
  while (Date.now() < deadline) {
    try {
      return await connectOnce(payload);
    } catch {
      await sleep(CONNECT_RETRY_MS);
    }
  }
  return null;
}

async function tryAcquireStartupLock(): Promise<boolean> {
  const target = lockPath();
  try {
    await fs.mkdir(target);
    return true;
  } catch {
    const stat = await fs.stat(target).catch(() => null);
    if (!stat) return false;

    const lockAgeMs = Date.now() - stat.mtimeMs;
    if (lockAgeMs <= STARTUP_TIMEOUT_MS) return false;

    await fs.rm(target, { recursive: true, force: true }).catch(() => undefined);
    try {
      await fs.mkdir(target);
      return true;
    } catch {
      return false;
    }
  }
}

async function runRequest(): Promise<void> {
  const payload = { ...parseEnvelope(await readStdinJson()), cwd: process.cwd() };
  await ensureRuntimeDir();

  const direct = await tryConnectUntil(Date.now() + CONNECT_RETRY_MS, payload);
  if (direct) {
    writeJson(direct);
    return;
  }

  let acquiredLock = false;
  acquiredLock = await tryAcquireStartupLock();
  if (acquiredLock) {
    spawnDaemon();
  }

  try {
    const response = await tryConnectUntil(Date.now() + STARTUP_TIMEOUT_MS, payload);
    writeJson(response ?? { ok: false, error: "remote fs daemon did not start" });
  } finally {
    if (acquiredLock) {
      await fs.rm(lockPath(), { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

function createServer(idleMs: number): net.Server {
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let inFlight = 0;

  const scheduleIdleExit = () => {
    if (idleTimer) clearTimeout(idleTimer);
    if (inFlight > 0) return;
    idleTimer = setTimeout(() => process.exit(0), idleMs);
  };

  const server = net.createServer({ allowHalfOpen: true }, (socket) => {
    inFlight += 1;
    if (idleTimer) clearTimeout(idleTimer);

    let requestText = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      requestText += chunk;
    });
    socket.on("error", () => {
      // The client may give up during daemon startup races. The next request will retry.
    });
    socket.on("end", () => {
      void (async () => {
        try {
          const envelope = parseEnvelope(JSON.parse(requestText) as unknown);
          const value = await handleRequest(envelope);
          socket.end(JSON.stringify({ ok: true, value } satisfies ResponseEnvelope));
        } catch (error) {
          socket.end(JSON.stringify(responseError(error)));
        } finally {
          inFlight -= 1;
          scheduleIdleExit();
        }
      })();
    });
  });

  server.on("close", () => {
    if (idleTimer) clearTimeout(idleTimer);
  });

  scheduleIdleExit();
  return server;
}

async function runDaemon(): Promise<void> {
  await ensureRuntimeDir();
  const sock = socketPath();
  if (process.platform !== "win32" && fsSync.existsSync(sock)) {
    await fs.unlink(sock).catch(() => undefined);
  }

  const idleMs = numberOrUndefined(process.env.LILAC_REMOTE_FS_IDLE_MS) ?? DEFAULT_IDLE_MS;
  const server = createServer(idleMs);

  const shutdown = () => {
    server.close(() => process.exit(0));
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(sock, () => {
      if (process.platform !== "win32") {
        void fs.chmod(sock, 0o600).catch(() => undefined);
      }
      resolve();
    });
  });
}

async function main(): Promise<void> {
  const command = process.argv[2] ?? "request";
  if (command === "daemon") {
    await runDaemon();
    return;
  }
  if (command === "request") {
    await runRequest();
    return;
  }
  if (command === "health") {
    await ensureRuntimeDir();
    writeJson(await connectOnce({ op: "health", input: {}, denyPaths: [] }).catch(responseError));
    return;
  }

  writeJson({ ok: false, error: `Unknown command: ${command}` } satisfies ResponseEnvelope);
}

main().catch((error) => {
  writeJson(responseError(error));
  process.exitCode = 1;
});
