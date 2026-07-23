import { afterEach, describe, expect, it } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { CodexOAuthLogin } from "@stanley2058/lilac-utils";

import {
  acquireDatabaseLock,
  createMiniLilacAuthDependencies,
  databaseLockPath,
  MINI_LILAC_SERVER_HELP,
  main,
  miniLilacStatePaths,
  parseCliArgs,
  shutdownMiniLilacServer,
  type MiniLilacAuthDependencies,
} from "../src/main";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function temporaryDatabase(): Promise<{ directory: string; databasePath: string }> {
  const directory = await mkdtemp(path.join(tmpdir(), "mini-lilac-main-"));
  temporaryDirectories.push(directory);
  return { directory, databasePath: path.join(directory, "data", "mini-lilac.sqlite") };
}

function testDependencies(overrides: Partial<MiniLilacAuthDependencies> = {}): {
  dependencies: MiniLilacAuthDependencies;
  logs: string[];
} {
  const logs: string[] = [];
  return {
    logs,
    dependencies: {
      startLogin: async () => {
        throw new Error("unexpected login");
      },
      readTokens: async () => null,
      clearTokens: async () => {},
      storagePath: () => "/data/secret/codex.json",
      log: (message) => logs.push(message),
      ...overrides,
    },
  };
}

describe("mini-lilac-server CLI", () => {
  it("keeps the existing serve invocation and parses auth actions without config", () => {
    expect(parseCliArgs(["--config", "config.yaml", "--database", "db.sqlite"])).toEqual({
      command: "serve",
      config: "config.yaml",
      database: "db.sqlite",
    });
    expect(parseCliArgs(["auth", "codex"])).toEqual({
      command: "auth",
      provider: "codex",
      action: "login",
    });
    expect(parseCliArgs(["auth", "codex", "--status"])).toEqual({
      command: "auth",
      provider: "codex",
      action: "status",
    });
    expect(parseCliArgs(["auth", "codex", "--logout"])).toEqual({
      command: "auth",
      provider: "codex",
      action: "logout",
    });
    expect(parseCliArgs(["--help"])).toEqual({ command: "help" });
    expect(parseCliArgs([])).toEqual({ command: "serve" });
    expect(MINI_LILAC_SERVER_HELP).toContain("auth codex --status");
    expect(() => parseCliArgs(["auth", "codex", "--status", "--logout"])).toThrow("only one");
    expect(() => parseCliArgs(["auth", "openai"])).toThrow();
  });

  it("centralizes default server state under XDG_STATE_HOME", () => {
    const paths = miniLilacStatePaths({ XDG_STATE_HOME: "/state" });
    expect(paths).toEqual({
      directory: path.join("/state", "mini-lilac"),
      configFile: path.join("/state", "mini-lilac", "config.yaml"),
      databaseFile: path.join("/state", "mini-lilac", "mini-lilac.sqlite"),
      codexOAuthFile: path.join("/state", "mini-lilac", "codex.json"),
      modelsDevCacheFile: path.join("/state", "mini-lilac", "models-dev.json"),
    });
    expect(createMiniLilacAuthDependencies(paths).storagePath()).toBe(
      path.join("/state", "mini-lilac", "codex.json"),
    );
  });

  it("reports status and logout without starting network auth", async () => {
    let cleared = false;
    const status = testDependencies({
      readTokens: async () => ({
        type: "oauth",
        access: "not-logged",
        refresh: "not-logged",
        expires: 1_800_000,
        accountId: "account-123",
      }),
    });
    await main(["auth", "codex", "--status"], status.dependencies);
    expect(status.logs.join("\n")).toContain("Codex OAuth: configured");
    expect(status.logs.join("\n")).toContain("Account: account-123");
    expect(status.logs.join("\n")).not.toContain("not-logged");

    const logout = testDependencies({ clearTokens: async () => void (cleared = true) });
    await main(["auth", "codex", "--logout"], logout.dependencies);
    expect(cleared).toBe(true);
    expect(logout.logs).toEqual(["Codex OAuth cleared from /data/secret/codex.json"]);
  });

  it("prints the authorization URL and storage location, waits, and closes", async () => {
    let closed = 0;
    const login: CodexOAuthLogin = {
      authorizeUrl: "https://auth.example/authorize",
      redirectUri: "http://localhost:1455/auth/callback",
      port: 1455,
      state: "state",
      pkce: { verifier: "verifier", challenge: "challenge" },
      storagePath: "/data/secret/codex.json",
      result: Promise.resolve({
        ok: true,
        accountId: "account-123",
        expires: 123,
        storagePath: "/data/secret/codex.json",
      }),
      exchange: async () => {
        throw new Error("unexpected exchange");
      },
      close: async () => void (closed += 1),
    };
    const { dependencies, logs } = testDependencies({ startLogin: async () => login });

    await main(["auth", "codex"], dependencies);
    expect(logs.join("\n")).toContain(login.authorizeUrl);
    expect(logs.join("\n")).toContain(login.storagePath);
    expect(logs.join("\n")).toContain("account-123");
    expect(closed).toBe(1);
  });
});

describe("mini-lilac-server database lock", () => {
  it("allows exactly one owner under high contention and reacquires after release", async () => {
    const { databasePath } = await temporaryDatabase();
    const attempts = await Promise.allSettled(
      Array.from({ length: 64 }, () =>
        acquireDatabaseLock(path.join(path.dirname(databasePath), ".", "mini-lilac.sqlite")),
      ),
    );
    const owners = attempts
      .filter((attempt) => attempt.status === "fulfilled")
      .map((attempt) => attempt.value);
    const contenders = attempts.filter((attempt) => attempt.status === "rejected");

    expect(owners).toHaveLength(1);
    expect(contenders).toHaveLength(63);
    for (const contender of contenders) {
      expect(contender.reason).toBeInstanceOf(Error);
      expect(String(contender.reason)).toContain("already using database");
    }

    await Promise.all([owners[0]!.release(), owners[0]!.release()]);
    const second = await acquireDatabaseLock(databasePath);
    expect(await stat(second.lockPath).then((entry) => entry.isFile())).toBe(true);
    await second.release();
    expect(await stat(databaseLockPath(databasePath)).then((entry) => entry.isFile())).toBe(true);
  });

  it("treats a persistent unlocked lock file as available", async () => {
    const { databasePath } = await temporaryDatabase();
    const lockPath = databaseLockPath(databasePath);
    await mkdir(path.dirname(databasePath), { recursive: true });

    const initial = await acquireDatabaseLock(databasePath);
    await initial.release();
    const lock = await acquireDatabaseLock(databasePath);
    expect(lock.lockPath).toBe(lockPath);
    await expect(acquireDatabaseLock(databasePath)).rejects.toThrow("already using database");
    await lock.release();
  });

  it("does not change permissions on an existing database parent", async () => {
    const { directory, databasePath } = await temporaryDatabase();
    const parent = path.dirname(databasePath);
    await mkdir(parent);
    await chmod(parent, 0o755);

    const lock = await acquireDatabaseLock(databasePath);
    expect((await stat(parent)).mode & 0o777).toBe(0o755);
    await lock.release();
    expect((await stat(directory)).isDirectory()).toBe(true);
  });

  it("releases the lock when server setup fails", async () => {
    const { directory, databasePath } = await temporaryDatabase();
    await expect(
      main(["--config", path.join(directory, "missing-config.yaml"), "--database", databasePath]),
    ).rejects.toThrow();

    const lock = await acquireDatabaseLock(databasePath);
    await lock.release();
  });
});

describe("mini-lilac-server shutdown", () => {
  it("starts listener drain before cancellation and closes after runs drain", async () => {
    const events: string[] = [];
    let active = true;

    await shutdownMiniLilacServer({
      stopListener: (force) => void events.push(`stop:${force}`),
      listActiveRuns: () => (active ? [{ sessionId: "session-1", runId: "run-1" }] : []),
      cancelRun: async () => {
        events.push("cancel");
        active = false;
      },
      closeRuntime: () => void events.push("close"),
    });

    expect(events).toEqual(["stop:false", "cancel", "close"]);
  });

  it("force-closes connections after the bounded grace", async () => {
    const events: string[] = [];
    let now = 0;
    let finishGracefulStop: (() => void) | undefined;

    await shutdownMiniLilacServer({
      stopListener: (force) => {
        events.push(`stop:${force}`);
        if (force) {
          finishGracefulStop?.();
          return;
        }
        return new Promise<void>((resolve) => void (finishGracefulStop = resolve));
      },
      listActiveRuns: () => [{ sessionId: "session-1", runId: "run-1" }],
      cancelRun: async () => void events.push("cancel"),
      closeRuntime: () => void events.push("close"),
      graceMs: 10,
      pollIntervalMs: 5,
      now: () => now,
      sleep: async (milliseconds) => void (now += milliseconds),
    });

    expect(events).toEqual(["stop:false", "cancel", "stop:true", "close"]);
  });

  it("does not let a stuck cancellation block force-close", async () => {
    const events: string[] = [];
    let now = 0;

    await shutdownMiniLilacServer({
      stopListener: (force) => void events.push(`stop:${force}`),
      listActiveRuns: () => [{ sessionId: "session-1", runId: "run-1" }],
      cancelRun: () => {
        events.push("cancel");
        return new Promise<void>(() => {});
      },
      closeRuntime: () => void events.push("close"),
      graceMs: 10,
      pollIntervalMs: 5,
      now: () => now,
      sleep: async (milliseconds) => void (now += milliseconds),
    });

    expect(events).toEqual(["stop:false", "cancel", "stop:true", "close"]);
  });
});
