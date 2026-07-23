import { describe, expect, it } from "bun:test";
import path from "node:path";

import type { CodexOAuthLogin } from "@stanley2058/lilac-utils";

import {
  createMiniLilacAuthDependencies,
  MINI_LILAC_SERVER_HELP,
  main,
  miniLilacStatePaths,
  parseCliArgs,
  type MiniLilacAuthDependencies,
} from "../src/main";

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
