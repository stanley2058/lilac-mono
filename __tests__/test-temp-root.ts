import {
  accessSync,
  closeSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { hostname, tmpdir } from "node:os";
import path from "node:path";

import { dlopen, FFIType } from "bun:ffi";

export const TEST_TEMP_ROOT_PREFIX = "lilac-test-data-";
export const TEST_TEMP_ROOT_BASE_ENV = "LILAC_TEST_TEMP_BASE";

const LOCK_EXCLUSIVE = 2;
const LOCK_NONBLOCKING = 4;
const CREATION_LOCK_PREFIX = ".lilac-test-data-creation-";
const OWNER_FILE = ".lilac-test-owner.json";
const OWNER_LOCK_FILE = ".lilac-test-owner.lock";
const TEST_TEMP_ROOT_SUFFIX = /^[A-Za-z0-9]{6}$/u;
const TEST_TEMP_ROOT_SUFFIX_LENGTH = 6;
// Keep room under TMPDIR for Unix domain sockets (Chromium SingletonSocket, Go t.TempDir, tool-bridge).
const TEST_TEMP_SOCKET_HEADROOM_BYTES = 54;
const POSIX_FALLBACK_TEMP_DIR = "/tmp";

const POSIX_FILE_LOCK_SYMBOLS = {
  flock: {
    args: [FFIType.i32, FFIType.i32],
    returns: FFIType.i32,
  },
} as const;

type TestTempRootMarker = {
  readonly hostIdentity: string;
  readonly ownership: "posix-flock";
  readonly pid: number;
  readonly rootDirectory: string;
  readonly userId: number;
  readonly version: 5;
};

type OwnershipLock = {
  release(): void;
};

export type OwnedTestTempRoot = {
  readonly dataDirectory: string;
  readonly rootDirectory: string;
  readonly tempDirectory: string;
  releaseOwnership(): void;
};

type CreateOwnedTestTempRootOptions = {
  readonly onRootCreated?: (rootDirectory: string) => void;
};

let posixFileLockApi: ReturnType<typeof openPosixFileLockApi> | undefined;

function ownerFile(rootDirectory: string): string {
  return path.join(rootDirectory, OWNER_FILE);
}

function ownerLockFile(rootDirectory: string): string {
  return path.join(rootDirectory, OWNER_LOCK_FILE);
}

function creationLockFile(baseDirectory: string, scopeName: string): string {
  return path.join(baseDirectory, `${CREATION_LOCK_PREFIX}${scopeName}.lock`);
}

function linuxLibcPath(): string {
  const maps = readFileSync("/proc/self/maps", "utf8");
  for (const line of maps.split("\n")) {
    const candidate = line.trim().split(/\s+/u).at(-1);
    if (!candidate?.startsWith("/")) continue;

    const basename = path.basename(candidate);
    const isGlibc = /^libc(?:-[0-9.]+)?\.so(?:\.\d+)*$/u.test(basename);
    const isMusl = /^(?:libc\.musl|ld-musl)-[^/]+\.so\.1$/u.test(basename);
    if (isGlibc || isMusl) return candidate;
  }
  throw new Error("Unable to locate the loaded Linux C library");
}

function openPosixFileLockApi() {
  if (process.platform !== "linux" && process.platform !== "darwin") return undefined;

  const libraryPath =
    process.platform === "darwin" ? "/usr/lib/libSystem.B.dylib" : linuxLibcPath();
  return dlopen(libraryPath, POSIX_FILE_LOCK_SYMBOLS);
}

function getPosixFileLockApi(): NonNullable<ReturnType<typeof openPosixFileLockApi>> {
  posixFileLockApi ??= openPosixFileLockApi();
  if (!posixFileLockApi) throw new Error("Test temporary ownership locks require POSIX flock");
  return posixFileLockApi;
}

function tryAcquireFileLock(lockFile: string, create: boolean): OwnershipLock | undefined {
  let descriptor: number;
  try {
    descriptor = openSync(lockFile, create ? "a+" : "r+", 0o600);
  } catch {
    return undefined;
  }

  let acquired = false;
  try {
    const result = getPosixFileLockApi().symbols.flock(
      descriptor,
      LOCK_EXCLUSIVE | LOCK_NONBLOCKING,
    );
    if (result !== 0) return undefined;
    acquired = true;

    let released = false;
    return {
      release() {
        if (released) return;
        released = true;
        closeSync(descriptor);
      },
    };
  } finally {
    if (!acquired) closeSync(descriptor);
  }
}

function tryAcquireOwnershipLock(rootDirectory: string): OwnershipLock | undefined {
  return tryAcquireFileLock(ownerLockFile(rootDirectory), false);
}

function acquireCreationLock(baseDirectory: string, scopeName: string): OwnershipLock {
  const lockFile = creationLockFile(baseDirectory, scopeName);
  let descriptor = openSync(lockFile, "a+", 0o600);
  let acquired = false;

  try {
    const result = getPosixFileLockApi().symbols.flock(descriptor, LOCK_EXCLUSIVE);
    if (result !== 0) throw new Error("Unable to acquire test temporary creation lock");
    acquired = true;

    let released = false;
    return {
      release() {
        if (released) return;
        released = true;
        closeSync(descriptor);
      },
    };
  } finally {
    if (!acquired) closeSync(descriptor);
  }
}

function currentHostIdentity(): string {
  const hostName = hostname();
  if (process.platform !== "linux") return `${process.platform}:${hostName}`;

  for (const machineIdFile of ["/etc/machine-id", "/var/lib/dbus/machine-id"]) {
    try {
      const machineId = readFileSync(machineIdFile, "utf8").trim();
      if (machineId) return `linux:${machineId}`;
    } catch {
      continue;
    }
  }
  return `linux-hostname:${hostname()}`;
}

function currentUserId(): number {
  const userId = process.getuid?.();
  if (userId === undefined) throw new Error("Unable to determine the test process user ID");
  return userId;
}

function currentScope(): {
  hostIdentity: string;
  rootPrefix: string;
  scopeName: string;
  userId: number;
} {
  const hostIdentity = currentHostIdentity();
  const userId = currentUserId();
  const hostHash = createHash("sha256").update(hostIdentity).digest("hex").slice(0, 12);
  const scopeName = `${userId}-${hostHash}`;
  return {
    hostIdentity,
    rootPrefix: `${TEST_TEMP_ROOT_PREFIX}${scopeName}-`,
    scopeName,
    userId,
  };
}

function readOwner(rootDirectory: string): TestTempRootMarker | undefined {
  try {
    const value: unknown = JSON.parse(readFileSync(ownerFile(rootDirectory), "utf8"));
    if (typeof value !== "object" || value === null) return undefined;

    const record = value as Record<string, unknown>;
    if (record["version"] !== 5) return undefined;
    if (record["ownership"] !== "posix-flock") return undefined;
    if (typeof record["hostIdentity"] !== "string" || record["hostIdentity"].length === 0) {
      return undefined;
    }
    if (!Number.isSafeInteger(record["pid"]) || Number(record["pid"]) <= 0) return undefined;
    if (!Number.isSafeInteger(record["userId"]) || Number(record["userId"]) < 0) return undefined;
    if (record["rootDirectory"] !== rootDirectory) return undefined;

    return {
      version: 5,
      hostIdentity: record["hostIdentity"],
      ownership: "posix-flock",
      pid: Number(record["pid"]),
      rootDirectory,
      userId: Number(record["userId"]),
    };
  } catch {
    return undefined;
  }
}

export function resolveTestTempBaseDirectory(candidate: string): string {
  if (!path.isAbsolute(candidate)) throw new Error("Test temporary base must be absolute");
  return realpathSync(candidate);
}

function posixSocketPathLimit(): number {
  return process.platform === "darwin" ? 103 : 107;
}

function projectedTempDirectoryBytes(baseDirectory: string): number {
  const { rootPrefix } = currentScope();
  const sampleTempDirectory = path.join(
    baseDirectory,
    `${rootPrefix}${"x".repeat(TEST_TEMP_ROOT_SUFFIX_LENGTH)}`,
    "tmp",
  );
  return Buffer.byteLength(sampleTempDirectory);
}

function resolveWritableDirectory(candidate: string): string | undefined {
  try {
    const resolved = resolveTestTempBaseDirectory(candidate);
    if (!statSync(resolved).isDirectory()) return undefined;
    accessSync(resolved, constants.W_OK | constants.X_OK);
    return resolved;
  } catch {
    return undefined;
  }
}

export function selectTestTempBaseDirectory(options?: {
  readonly explicitBase?: string;
  readonly defaultTempDir?: string;
  readonly fallbackTempDir?: string;
}): string {
  if (options?.explicitBase !== undefined) {
    return resolveTestTempBaseDirectory(options.explicitBase);
  }
  const candidate = resolveTestTempBaseDirectory(options?.defaultTempDir ?? tmpdir());
  if (process.platform !== "linux" && process.platform !== "darwin") return candidate;

  const maxTempDirectoryBytes = posixSocketPathLimit() - TEST_TEMP_SOCKET_HEADROOM_BYTES;
  if (projectedTempDirectoryBytes(candidate) <= maxTempDirectoryBytes) return candidate;

  const fallback = resolveWritableDirectory(options?.fallbackTempDir ?? POSIX_FALLBACK_TEMP_DIR);
  if (!fallback) return candidate;
  return Buffer.byteLength(fallback) < Buffer.byteLength(candidate) ? fallback : candidate;
}

export function createOwnedTestTempRoot(
  baseDirectory: string,
  options: CreateOwnedTestTempRootOptions = {},
): OwnedTestTempRoot {
  const scope = currentScope();
  const creationLock = acquireCreationLock(baseDirectory, scope.scopeName);
  let rootDirectory: string | undefined;
  let ownershipLock: OwnershipLock | undefined;

  try {
    rootDirectory = mkdtempSync(path.join(baseDirectory, scope.rootPrefix));
    options.onRootCreated?.(rootDirectory);
    writeFileSync(ownerLockFile(rootDirectory), "", { flag: "wx", mode: 0o600 });
    ownershipLock = tryAcquireOwnershipLock(rootDirectory);
    if (!ownershipLock) throw new Error("Unable to acquire test temporary ownership lock");

    const marker: TestTempRootMarker = {
      version: 5,
      hostIdentity: scope.hostIdentity,
      ownership: "posix-flock",
      pid: process.pid,
      rootDirectory,
      userId: scope.userId,
    };
    writeFileSync(ownerFile(rootDirectory), `${JSON.stringify(marker)}\n`, { mode: 0o600 });

    const dataDirectory = path.join(rootDirectory, "data");
    const tempDirectory = path.join(rootDirectory, "tmp");
    mkdirSync(dataDirectory);
    mkdirSync(tempDirectory);

    let released = false;
    return {
      dataDirectory,
      rootDirectory,
      tempDirectory,
      releaseOwnership() {
        if (released) return;
        released = true;
        ownershipLock?.release();
      },
    };
  } catch (error) {
    ownershipLock?.release();
    if (rootDirectory) rmSync(rootDirectory, { recursive: true, force: true });
    throw error;
  } finally {
    creationLock.release();
  }
}

export function removeOwnedTestTempRoot(owned: OwnedTestTempRoot): void {
  owned.releaseOwnership();
  rmSync(owned.rootDirectory, { recursive: true, force: true });
}

export function reapStaleTestTempRoots(baseDirectory: string): string[] {
  const scope = currentScope();
  const creationLock = tryAcquireFileLock(creationLockFile(baseDirectory, scope.scopeName), true);
  if (!creationLock) return [];

  const removed: string[] = [];

  try {
    for (const entry of readdirSync(baseDirectory, { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.startsWith(scope.rootPrefix)) continue;
      if (!TEST_TEMP_ROOT_SUFFIX.test(entry.name.slice(scope.rootPrefix.length))) continue;

      const rootDirectory = path.join(baseDirectory, entry.name);
      try {
        if (lstatSync(rootDirectory).uid !== scope.userId) continue;
      } catch {
        continue;
      }

      const owner = readOwner(rootDirectory);
      if (!owner) {
        const ownershipLock = tryAcquireOwnershipLock(rootDirectory);
        if (existsSync(ownerLockFile(rootDirectory)) && !ownershipLock) continue;

        try {
          rmSync(rootDirectory, { recursive: true, force: true });
          removed.push(rootDirectory);
        } finally {
          ownershipLock?.release();
        }
        continue;
      }
      if (owner.hostIdentity !== scope.hostIdentity || owner.userId !== scope.userId) continue;

      const ownershipLock = tryAcquireOwnershipLock(rootDirectory);
      if (!ownershipLock) continue;

      try {
        const verifiedOwner = readOwner(rootDirectory);
        if (
          !verifiedOwner ||
          verifiedOwner.hostIdentity !== scope.hostIdentity ||
          verifiedOwner.userId !== scope.userId
        )
          continue;
        rmSync(rootDirectory, { recursive: true, force: true });
        removed.push(rootDirectory);
      } finally {
        ownershipLock.release();
      }
    }
  } finally {
    creationLock.release();
  }

  return removed;
}
