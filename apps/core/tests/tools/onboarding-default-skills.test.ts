import { afterEach, describe, expect, it, spyOn } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import type { ServerToolResult } from "@stanley2058/lilac-plugin-runtime";
import { Panic } from "better-result";

import { Onboarding } from "../../src/tool-server/tools/onboarding";

function onboardingWith(
  overrides: Partial<ConstructorParameters<typeof Onboarding>[0]> = {},
): Onboarding {
  return new Onboarding({
    fetch,
    getGithubViewerLogin: async () => null,
    getGithubInstallationToken: async () => ({
      token: "test-token",
      expiresAtMs: Date.now() + 60_000,
      apiBaseUrl: "https://api.example.test",
    }),
    ...overrides,
  });
}

function value(result: ServerToolResult): unknown {
  if (result.status === "error") throw new Error(result.error.message);
  return result.value;
}

describe("onboarding default skills", () => {
  let dataDir: string | undefined;

  afterEach(async () => {
    if (dataDir) await fs.rm(dataDir, { recursive: true, force: true });
    dataDir = undefined;
  });

  it("seeds only setup-dependent skill templates without network access", async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-onboarding-skills-"));
    const result = z
      .object({
        ok: z.literal(true),
        steps: z.array(z.object({ id: z.string(), status: z.string() })),
      })
      .parse(
        value(
          await new Onboarding().call("onboarding.defaults", {
            dataDir,
            network: false,
          }),
        ),
      );
    const skillPath = path.join(dataDir, "skills", "mcporter", "SKILL.md");

    expect(result.steps).toContainEqual({ id: "skills.mcporter", status: "installed" });
    expect(result.steps.some((step) => step.id === "skills.coding-agent")).toBe(false);
    expect(result.steps.some((step) => step.id === "skills.mcp-management")).toBe(false);
    expect(await fs.readFile(skillPath, "utf8")).toContain("name: mcporter");
  });

  it("reports each bundled skill failure outside a workspace in non-strict mode", async () => {
    const originalCwd = process.cwd();
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-onboarding-no-workspace-"));

    let result: unknown;
    try {
      process.chdir(dataDir);
      result = value(
        await new Onboarding().call("onboarding.defaults", {
          dataDir: path.join(dataDir, "data"),
          network: false,
        }),
      );
    } finally {
      process.chdir(originalCwd);
    }

    const parsed = z
      .object({
        ok: z.literal(true),
        steps: z.array(
          z.object({
            id: z.string(),
            status: z.string(),
            error: z.string().optional(),
          }),
        ),
      })
      .parse(result);
    const bundledSkillSteps = parsed.steps.filter((step) => step.id.startsWith("skills."));

    expect(bundledSkillSteps.map(({ id, status }) => ({ id, status }))).toEqual([
      { id: "skills.mcporter", status: "failed" },
      { id: "skills.gog", status: "failed" },
    ]);
    for (const step of bundledSkillSteps) {
      expect(step.error).toContain("Workspace root not found");
    }
  });

  it("returns bootstrap filesystem failures as semantic errors", async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-onboarding-bootstrap-"));
    const blockedDataDir = path.join(dataDir, "not-a-directory");
    await fs.writeFile(blockedDataDir, "blocked", "utf8");

    await expect(
      onboardingWith().call("onboarding.bootstrap", { dataDir: blockedDataDir }),
    ).resolves.toMatchObject({
      status: "error",
      error: { kind: "unavailable", code: "onboarding_unavailable" },
    });
  });

  it.each([
    ["EACCES", Object.assign(new Error("access denied"), { code: "EACCES" }), "denied", false],
    ["EPERM", Object.assign(new Error("operation denied"), { code: "EPERM" }), "denied", false],
    ["ENOENT", Object.assign(new Error("missing"), { code: "ENOENT" }), "not_found", false],
    [
      "AbortError",
      Object.assign(new Error("cancelled"), { name: "AbortError" }),
      "cancelled",
      false,
    ],
    [
      "TimeoutError",
      Object.assign(new Error("timed out"), { name: "TimeoutError" }),
      "timeout",
      true,
    ],
    ["ETIMEDOUT", Object.assign(new Error("timed out"), { code: "ETIMEDOUT" }), "timeout", true],
  ] as const)("classifies %s operation failures", async (_label, error, kind, retryable) => {
    const mkdir = spyOn(fs, "mkdir").mockRejectedValue(error);

    try {
      await expect(
        onboardingWith().call("onboarding.bootstrap", { dataDir: "/unused" }),
      ).resolves.toMatchObject({
        status: "error",
        error: { kind, retryable },
      });
    } finally {
      mkdir.mockRestore();
    }
  });

  it("returns GnuPG directory permission failures as denied", async () => {
    const denied = Object.assign(new Error("GnuPG directory denied"), { code: "EACCES" });
    const mkdir = spyOn(fs, "mkdir").mockRejectedValue(denied);

    try {
      await expect(
        onboardingWith().call("onboarding.gnupg", { mode: "status", dataDir: "/unused" }),
      ).resolves.toMatchObject({
        status: "error",
        error: { kind: "denied", retryable: false, message: "GnuPG directory denied" },
      });
    } finally {
      mkdir.mockRestore();
    }
  });

  it("captures Git identity test writes and preserves filesystem Panic", async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-onboarding-git-test-"));
    const denied = Object.assign(new Error("test write denied"), { code: "EPERM" });
    const writeFile = spyOn(fs, "writeFile").mockRejectedValue(denied);

    try {
      await expect(
        onboardingWith().call("onboarding.git_identity", { mode: "test", dataDir }),
      ).resolves.toMatchObject({
        status: "error",
        error: { kind: "denied", retryable: false, message: "test write denied" },
      });
    } finally {
      writeFile.mockRestore();
    }

    const panic = new Panic({ message: "git temp invariant failed" });
    const mkdtemp = spyOn(fs, "mkdtemp").mockRejectedValue(panic);
    try {
      await expect(
        onboardingWith().call("onboarding.git_identity", { mode: "test", dataDir }),
      ).rejects.toBeInstanceOf(Panic);
    } finally {
      mkdtemp.mockRestore();
    }
  });

  it("returns GitHub user and App service failures as semantic errors", async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-onboarding-github-"));
    const tool = onboardingWith({
      fetch: async () => {
        throw new Error("GitHub repositories unavailable");
      },
      getGithubViewerLogin: async () => {
        throw new Error("GitHub viewer unavailable");
      },
    });
    expect(
      await tool.call("onboarding.github_user_token", {
        mode: "configure",
        dataDir,
        token: "configured-token",
      }),
    ).toMatchObject({ status: "ok" });

    await expect(
      tool.call("onboarding.github_user_token", { mode: "test", dataDir }),
    ).resolves.toMatchObject({
      status: "error",
      error: { kind: "unavailable", message: "GitHub viewer unavailable" },
    });
    await expect(
      tool.call("onboarding.github_app", { mode: "test", dataDir }),
    ).resolves.toMatchObject({
      status: "error",
      error: { kind: "unavailable", message: "GitHub repositories unavailable" },
    });
  });

  it("leaves tool reload execution to the server-owned post-call path", async () => {
    let fetchCalls = 0;
    const onboarding = onboardingWith({
      fetch: async () => {
        fetchCalls++;
        throw new Error("reload must not use the network");
      },
    });
    await expect(onboarding.call("onboarding.reload_tools", {})).resolves.toMatchObject({
      status: "ok",
      value: { ok: true },
    });
    expect(fetchCalls).toBe(0);
  });
});
