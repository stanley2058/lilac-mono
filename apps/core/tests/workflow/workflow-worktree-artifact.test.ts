import { afterEach, describe, expect, it } from "bun:test";
import fs from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  captureWorkflowWorktreePatch,
  readWorkflowWorktreePatch,
} from "../../src/workflow/workflow-worktree-artifact";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function runGit(cwd: string, args: readonly string[]): Promise<string> {
  const process = Bun.spawn(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  if (exitCode !== 0) throw new Error(stderr);
  return stdout.trim();
}

async function createRepo(prefix: string): Promise<{
  root: string;
  repo: string;
  dataDir: string;
  baseCommit: string;
}> {
  const root = await fs.mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  const repo = join(root, "repo");
  const dataDir = join(root, "data");
  await Promise.all([fs.mkdir(repo), fs.mkdir(dataDir)]);
  await runGit(repo, ["init"]);
  await runGit(repo, ["config", "user.name", "Workflow Test"]);
  await runGit(repo, ["config", "user.email", "workflow@example.test"]);
  await fs.writeFile(join(repo, "tracked.txt"), "before\n");
  await runGit(repo, ["add", "tracked.txt"]);
  await runGit(repo, ["commit", "-m", "base"]);
  return { root, repo, dataDir, baseCommit: await runGit(repo, ["rev-parse", "HEAD"]) };
}

describe("workflow worktree patch capture", () => {
  it("disables repository external diff commands and publishes a readable patch", async () => {
    const { root, repo, dataDir, baseCommit } = await createRepo("workflow-patch-isolation-");
    const marker = join(root, "external-diff-ran");
    await runGit(repo, ["config", "diff.external", `/bin/sh -c 'touch ${marker}'`]);
    await fs.writeFile(join(repo, "tracked.txt"), "after\n");

    const artifact = await captureWorkflowWorktreePatch({
      dataDir,
      worktreePath: repo,
      baseCommit,
    });
    const patch = Buffer.from(
      await readWorkflowWorktreePatch({
        dataDir,
        artifactId: artifact.artifactId,
        expectedBytes: artifact.bytes,
      }),
    ).toString("utf8");

    expect(patch).toContain("+after");
    await expect(fs.lstat(marker)).rejects.toThrow();
  });

  it("rejects repository clean filters before they can execute", async () => {
    const { root, repo, dataDir, baseCommit } = await createRepo("workflow-patch-filter-");
    const marker = join(root, "clean-filter-ran");
    await fs.writeFile(join(repo, ".gitattributes"), "*.txt filter=hostile\n");
    await runGit(repo, ["add", ".gitattributes"]);
    await runGit(repo, ["commit", "-m", "attributes"]);
    const captureBase = await runGit(repo, ["rev-parse", "HEAD"]);
    await runGit(repo, ["config", "filter.hostile.clean", `/bin/sh -c 'touch ${marker}; cat'`]);
    await fs.writeFile(join(repo, "tracked.txt"), "after\n");

    await expect(
      captureWorkflowWorktreePatch({
        dataDir,
        worktreePath: repo,
        baseCommit: captureBase || baseCommit,
      }),
    ).rejects.toThrow("clean/smudge filters");
    await expect(fs.lstat(marker)).rejects.toThrow();
  });

  it("rejects ignored files, embedded repositories, and dirty submodules", async () => {
    const ignored = await createRepo("workflow-patch-ignored-");
    await fs.writeFile(join(ignored.repo, ".gitignore"), "*.cache\n");
    await runGit(ignored.repo, ["add", ".gitignore"]);
    await runGit(ignored.repo, ["commit", "-m", "ignore"]);
    const ignoredBase = await runGit(ignored.repo, ["rev-parse", "HEAD"]);
    await fs.writeFile(join(ignored.repo, "only-copy.cache"), "ignored bytes\n");
    await expect(
      captureWorkflowWorktreePatch({
        dataDir: ignored.dataDir,
        worktreePath: ignored.repo,
        baseCommit: ignoredBase,
      }),
    ).rejects.toThrow("Ignored worktree content");

    const embedded = await createRepo("workflow-patch-embedded-");
    const nested = join(embedded.repo, "nested");
    await fs.mkdir(nested);
    await runGit(nested, ["init"]);
    await expect(
      captureWorkflowWorktreePatch({
        dataDir: embedded.dataDir,
        worktreePath: embedded.repo,
        baseCommit: embedded.baseCommit,
      }),
    ).rejects.toThrow("Embedded repository content");

    const parent = await createRepo("workflow-patch-submodule-");
    const child = join(parent.root, "child");
    await fs.mkdir(child);
    await runGit(child, ["init"]);
    await runGit(child, ["config", "user.name", "Workflow Test"]);
    await runGit(child, ["config", "user.email", "workflow@example.test"]);
    await fs.writeFile(join(child, "child.txt"), "before\n");
    await runGit(child, ["add", "child.txt"]);
    await runGit(child, ["commit", "-m", "child base"]);
    await runGit(parent.repo, [
      "-c",
      "protocol.file.allow=always",
      "submodule",
      "add",
      child,
      "module",
    ]);
    await runGit(parent.repo, ["commit", "-m", "add submodule"]);
    const parentBase = await runGit(parent.repo, ["rev-parse", "HEAD"]);
    await fs.writeFile(join(parent.repo, "module", "child.txt"), "dirty\n");
    await expect(
      captureWorkflowWorktreePatch({
        dataDir: parent.dataDir,
        worktreePath: parent.repo,
        baseCommit: parentBase,
      }),
    ).rejects.toThrow("submodule");
  });

  it("honors an already-aborted capture signal", async () => {
    const { repo, dataDir, baseCommit } = await createRepo("workflow-patch-abort-");
    const controller = new AbortController();
    controller.abort("cancelled");

    await expect(
      captureWorkflowWorktreePatch({
        dataDir,
        worktreePath: repo,
        baseCommit,
        signal: controller.signal,
      }),
    ).rejects.toThrow("cancelled");
  });
});
