import { afterEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { getBuildInfo } from "../build-info";

describe("getBuildInfo", () => {
  let tmpRoot: string | null = null;

  afterEach(async () => {
    if (!tmpRoot) return;
    await fs.rm(tmpRoot, { recursive: true, force: true });
    tmpRoot = null;
  });

  it("prefers explicit lilac build env metadata", () => {
    const buildInfo = getBuildInfo({
      cwd: "/tmp/non-repo",
      env: {
        LILAC_BUILD_VERSION: "2026.03.22",
        LILAC_BUILD_COMMIT: "abc123def456",
        LILAC_BUILD_DIRTY: "true",
        LILAC_BUILD_AT: "2026-03-22T00:00:00.000Z",
      },
    });

    expect(buildInfo).toEqual({
      version: "2026.03.22",
      commit: "abc123def456",
      dirty: true,
      builtAt: "2026-03-22T00:00:00.000Z",
    });
  });

  it("uses the generated build info file when present", async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-build-info-"));
    await fs.mkdir(path.join(tmpRoot, "build"), { recursive: true });
    await fs.writeFile(
      path.join(tmpRoot, "package.json"),
      JSON.stringify({ private: true, workspaces: ["apps/*", "packages/*"] }),
      "utf8",
    );
    await fs.writeFile(
      path.join(tmpRoot, "build", "build-info.json"),
      JSON.stringify(
        {
          version: "2026.03.22",
          commit: "filecommit1234",
          dirty: false,
        },
        null,
        2,
      ),
      "utf8",
    );

    const buildInfo = getBuildInfo({
      cwd: tmpRoot,
      env: {},
    });

    expect(buildInfo).toEqual({
      version: "2026.03.22",
      commit: "filecommit1234",
      dirty: false,
      builtAt: undefined,
    });
  });

  it("prefers live git metadata over a stale generated build info file", async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-build-info-"));
    await fs.mkdir(path.join(tmpRoot, "build"), { recursive: true });
    await fs.writeFile(
      path.join(tmpRoot, "package.json"),
      JSON.stringify({ private: true, workspaces: ["apps/*", "packages/*"] }),
      "utf8",
    );
    await fs.writeFile(
      path.join(tmpRoot, "build", "build-info.json"),
      JSON.stringify(
        {
          version: "2026.03.22",
          commit: "stalecommit000",
          dirty: false,
        },
        null,
        2,
      ),
      "utf8",
    );

    execFileSync("git", ["init"], { cwd: tmpRoot, stdio: ["ignore", "pipe", "pipe"] });
    execFileSync("git", ["add", "package.json", "build/build-info.json"], {
      cwd: tmpRoot,
      stdio: ["ignore", "pipe", "pipe"],
    });
    execFileSync("git", ["commit", "-m", "init"], {
      cwd: tmpRoot,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "Lilac Test",
        GIT_AUTHOR_EMAIL: "lilac@example.com",
        GIT_COMMITTER_NAME: "Lilac Test",
        GIT_COMMITTER_EMAIL: "lilac@example.com",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    const expectedCommit = execFileSync("git", ["rev-parse", "--short=12", "HEAD"], {
      cwd: tmpRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();

    const buildInfo = getBuildInfo({
      cwd: tmpRoot,
      env: {},
    });

    expect(buildInfo).toEqual({
      version: "dev",
      commit: expectedCommit,
      dirty: false,
      builtAt: undefined,
    });
  });

  it("falls back to dev when no env or git metadata is available", () => {
    const buildInfo = getBuildInfo({
      cwd: "/tmp/non-repo",
      env: {},
    });

    expect(buildInfo).toEqual({
      version: "dev",
      commit: "dev",
      dirty: undefined,
      builtAt: undefined,
    });
  });
});
