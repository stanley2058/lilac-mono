/**
 * Extracts the newest release build older than HEAD so upgrade scenarios can run the code that
 * wrote existing data. Release builds are tagged `build-<sha>-<run id>-<attempt>`.
 */
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export const REPO_ROOT = path.resolve(import.meta.dir, "../../../../..");

async function git(args: string[]): Promise<string> {
  const child = Bun.spawn(["git", ...args], { cwd: REPO_ROOT, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`git ${args.join(" ")} failed: ${stderr.trim()}`);
  return stdout.trim();
}

function runId(tag: string): number {
  return Number(tag.split("-")[2] ?? 0);
}

async function localTags(): Promise<string[]> {
  const listed = await git(["tag", "--list", "build-*"]);
  return listed ? listed.split("\n") : [];
}

/** The newest release tag that is not HEAD, fetching it shallowly when the clone lacks tags. */
async function previousTag(): Promise<string> {
  if (process.env.LILAC_E2E_PREVIOUS_TAG) return process.env.LILAC_E2E_PREVIOUS_TAG;
  const head = await git(["rev-parse", "HEAD"]);
  let tags = (await localTags()).toSorted((left, right) => runId(right) - runId(left));
  if (!tags.length) {
    const remote = await git(["ls-remote", "--tags", "--refs", "origin", "build-*"]);
    tags = remote
      .split("\n")
      .map((line) => line.split("refs/tags/")[1] ?? "")
      .filter(Boolean)
      .toSorted((left, right) => runId(right) - runId(left));
  }
  for (const tag of tags) {
    if (!(await localTags()).includes(tag))
      await git(["fetch", "--depth=1", "--no-tags", "origin", `refs/tags/${tag}:refs/tags/${tag}`]);
    if ((await git(["rev-list", "-n1", tag])) !== head) return tag;
  }
  throw new Error("No previous release tag (build-*) is available");
}

async function run(command: string[], cwd: string): Promise<void> {
  const child = Bun.spawn(command, { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`${command.join(" ")} failed:\n${stdout}\n${stderr}`);
}

export type PreviousRelease = { tag: string; root: string };

/** A ready checkout of the previous release, cached under node_modules/.cache by tag. */
export async function previousRelease(): Promise<PreviousRelease> {
  const tag = await previousTag();
  const root = path.join(REPO_ROOT, "node_modules/.cache/lilac-e2e-previous", tag);
  const marker = path.join(root, ".lilac-e2e-ready");
  if (existsSync(marker) && (await readFile(marker, "utf8")) === tag) return { tag, root };
  await rm(root, { recursive: true, force: true });
  await mkdir(root, { recursive: true });
  // `git archive` needs no worktree registration and works in shallow clones.
  const archive = Bun.spawn(["git", "archive", "--format=tar", tag], {
    cwd: REPO_ROOT,
    stdout: "pipe",
  });
  const extract = Bun.spawn(["tar", "-x", "-C", root], { stdin: archive.stdout });
  if ((await archive.exited) !== 0 || (await extract.exited) !== 0)
    throw new Error(`Could not extract ${tag}`);
  await run([process.execPath, "install", "--frozen-lockfile"], root);
  await writeFile(marker, tag);
  return { tag, root };
}
