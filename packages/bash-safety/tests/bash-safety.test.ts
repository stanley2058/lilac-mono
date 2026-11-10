import { afterAll, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { analyzeBashCommand } from "../src";
import { dangerousReasonInText } from "../src/analyze/dangerous-text";

const gitFixture = mkdtempSync(join(tmpdir(), "lilac-bash-safety-git-"));
const ordinaryRepo = join(gitFixture, "ordinary");
const ordinaryNested = join(ordinaryRepo, "src", "nested");
const submoduleRepo = join(ordinaryRepo, "modules", "submodule");
const linkedRepo = join(gitFixture, "linked");
const submoduleGitDir = join(ordinaryRepo, ".git", "modules", "submodule");
const linkedGitDir = join(gitFixture, "metadata", "worktrees", "linked");
const realMainRepo = join(gitFixture, "real-main");
const realLinkedRepo = join(gitFixture, "real-linked");
const realCommonGitDir = join(realMainRepo, ".git");
mkdirSync(join(ordinaryRepo, ".git", "objects"), { recursive: true });
mkdirSync(submoduleGitDir, { recursive: true });
mkdirSync(linkedGitDir, { recursive: true });
mkdirSync(ordinaryNested, { recursive: true });
mkdirSync(submoduleRepo, { recursive: true });
mkdirSync(linkedRepo, { recursive: true });
writeFileSync(join(submoduleRepo, ".git"), "gitdir: ../../.git/modules/submodule\n");
writeFileSync(join(linkedRepo, ".git"), "gitdir: ../metadata/worktrees/linked\n");
mkdirSync(realMainRepo, { recursive: true });
runGit(["init", "--quiet", realMainRepo]);
writeFileSync(join(realMainRepo, "tracked.txt"), "tracked\n");
runGit(["-C", realMainRepo, "add", "tracked.txt"]);
runGit([
  "-C",
  realMainRepo,
  "-c",
  "user.name=Lilac Test",
  "-c",
  "user.email=lilac@example.invalid",
  "commit",
  "--quiet",
  "-m",
  "initial",
]);
runGit(["-C", realMainRepo, "worktree", "add", "--quiet", "--detach", realLinkedRepo, "HEAD"]);

afterAll(() => rmSync(gitFixture, { recursive: true, force: true }));

function runGit(args: string[]): void {
  const result = spawnSync("git", args, { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(result.stderr || `git ${args.join(" ")} failed`);
  }
}

describe("analyzeBashCommand", () => {
  it("allows benign commands and workspace-contained cleanup", () => {
    const cwd = "/tmp/lilac-project";

    expect(analyzeBashCommand("git status", { cwd })).toBeNull();
    expect(analyzeBashCommand("rm -rf build", { cwd })).toBeNull();
    expect(analyzeBashCommand("rm -rf /tmp/lilac-cache", { cwd })).toBeNull();
  });

  it("blocks destructive commands and expansion-sensitive deletion", () => {
    const cwd = "/tmp/lilac-project";

    expect(analyzeBashCommand("git reset --hard", { cwd })).not.toBeNull();
    expect(analyzeBashCommand("rm -rf /", { cwd })).not.toBeNull();
    expect(analyzeBashCommand('rm -rf "$target"', { cwd })).toMatchObject({
      code: "dynamic_recursive_delete",
      reason: expect.stringContaining("dynamic target"),
      hint: expect.stringContaining("literal child paths"),
    });
    expect(analyzeBashCommand("cd .. && rm -rf build", { cwd })).not.toBeNull();
  });

  it("returns stable codes and safe hints without changing recursive-delete decisions", () => {
    const cwd = "/tmp/lilac-project";

    expect(analyzeBashCommand("rm -r ../outside", { cwd })).toMatchObject({
      code: "delete_outside_cwd",
      hint: expect.stringContaining("literal child path"),
    });
    expect(analyzeBashCommand("rm -rf /", { cwd })).toMatchObject({
      code: "delete_root_or_home",
      hint: expect.stringContaining("specific child path"),
    });
    expect(analyzeBashCommand("rm -rf build", { cwd })).toBeNull();
  });

  it("analyzes nested static commands", () => {
    expect(analyzeBashCommand("bash -c 'git reset --hard'")).not.toBeNull();
    expect(analyzeBashCommand("find . -exec rm -rf {} \\;")).not.toBeNull();
    expect(analyzeBashCommand("xargs -I{} rm -rf {}")).not.toBeNull();
  });

  it("falls back to text analysis when shell parsing fails", () => {
    expect(analyzeBashCommand("git reset --hard &&")).toMatchObject({
      code: "dangerous_git_operation",
      reason: expect.stringContaining("destroys all uncommitted changes"),
    });
    expect(analyzeBashCommand('rm -rf "$target" &&')).toMatchObject({
      code: "dynamic_recursive_delete",
      hint: expect.stringContaining("literal child paths"),
    });
    expect(analyzeBashCommand("echo ok &&")).toBeNull();
  });

  it("contains static recursive rm damage without requiring force", () => {
    const cwd = "/tmp/lilac-project";
    const blocked = [
      "rm -r /",
      "rm -R ~",
      "rm --recurs .",
      "rm --recursive ../outside",
      "rm -rv /var/lib/project",
    ];
    const allowed = ["rm -r build", "rm --recurs /tmp/lilac-cache", 'rm -r "$target"', "rm -r? /"];

    for (const command of blocked) {
      expect(analyzeBashCommand(command, { cwd }), command).not.toBeNull();
    }
    for (const command of allowed) {
      expect(analyzeBashCommand(command, { cwd }), command).toBeNull();
    }
    expect(analyzeBashCommand('rm -rf "$target"', { cwd })?.reason).toContain("dynamic target");
  });

  it("protects active directory and git-file metadata from destructive targets", () => {
    const blocked = [
      ["rm -r .git", ordinaryRepo],
      ["rm .git/config", ordinaryRepo],
      ["rmdir .git", ordinaryRepo],
      ["mv .git metadata-backup", ordinaryRepo],
      ["mv config .git/config", ordinaryRepo],
      ["printf corrupt > .git/config", ordinaryRepo],
      ["cp source .git/config", ordinaryRepo],
      ["cp -t .git source", ordinaryRepo],
      ["truncate -s 0 .git/config", ordinaryRepo],
      ["printf corrupt | tee .git/config", ordinaryRepo],
      ["install source .git/hooks/pre-commit", ordinaryRepo],
      ["install -t .git source", ordinaryRepo],
      ["install -d .git/hooks", ordinaryRepo],
      ["ln -s source .git/hooks/pre-commit", ordinaryRepo],
      ["ln -t .git source", ordinaryRepo],
      ["dd if=source of=.git/index", ordinaryRepo],
      ["rm -r ../../.git/objects", ordinaryNested],
      ["mv .git metadata-backup", submoduleRepo],
      [`cp source ${JSON.stringify(join(submoduleGitDir, "index"))}`, submoduleRepo],
      ["rm .git", linkedRepo],
      ["printf corrupt > .git", linkedRepo],
      [`truncate -s 0 ${JSON.stringify(join(linkedGitDir, "index"))}`, linkedRepo],
      [`printf corrupt > ${JSON.stringify(join(linkedGitDir, "index"))}`, linkedRepo],
      ["rm .git &&", linkedRepo],
      ["cp source .git/config &&", ordinaryRepo],
    ] as const;

    for (const [command, cwd] of blocked) {
      expect(analyzeBashCommand(command, { cwd }), command).not.toBeNull();
      if (command.endsWith("&&")) {
        expect(dangerousReasonInText(command, { cwd }), command).not.toBeNull();
      }
    }

    expect(analyzeBashCommand("cat .git/config", { cwd: ordinaryRepo })).toBeNull();
    expect(analyzeBashCommand("cp .git/config backup", { cwd: ordinaryRepo })).toBeNull();
    expect(analyzeBashCommand("truncate -s 0 output.txt", { cwd: ordinaryRepo })).toBeNull();
    expect(analyzeBashCommand("printf ok | tee output.txt", { cwd: ordinaryRepo })).toBeNull();
    expect(analyzeBashCommand("install source output", { cwd: ordinaryRepo })).toBeNull();
    expect(analyzeBashCommand("install .git/config output", { cwd: ordinaryRepo })).toBeNull();
    expect(analyzeBashCommand("ln -s source output", { cwd: ordinaryRepo })).toBeNull();
    expect(analyzeBashCommand("ln -s .git/config output", { cwd: ordinaryRepo })).toBeNull();
    expect(analyzeBashCommand("dd if=source of=output", { cwd: ordinaryRepo })).toBeNull();
    expect(analyzeBashCommand("cp source .github/config", { cwd: ordinaryRepo })).toBeNull();
    expect(analyzeBashCommand('cp source "$destination"', { cwd: ordinaryRepo })).toBeNull();
    expect(analyzeBashCommand('printf ok | tee "$destination"', { cwd: ordinaryRepo })).toBeNull();
    expect(analyzeBashCommand("mv .gitignore .gitignore.old", { cwd: ordinaryRepo })).toBeNull();
    expect(analyzeBashCommand("printf ok > .gitkeep", { cwd: ordinaryRepo })).toBeNull();
    expect(analyzeBashCommand('rm "$target"', { cwd: ordinaryRepo })).toBeNull();
  });

  it("protects real linked-worktree common metadata and containing trees", () => {
    const commands = [
      `truncate -s 0 ${JSON.stringify(join(realCommonGitDir, "index"))}`,
      `cp source ${JSON.stringify(join(realCommonGitDir, "config"))}`,
      `rm -r ${JSON.stringify(realCommonGitDir)}`,
      `rm -r ${JSON.stringify(realMainRepo)}`,
      `mv ${JSON.stringify(realMainRepo)} ${JSON.stringify(join(gitFixture, "moved-main"))}`,
    ];

    for (const command of commands) {
      expect(analyzeBashCommand(command, { cwd: realLinkedRepo })?.reason, command).toContain(
        "active .git metadata",
      );
    }

    expect(
      analyzeBashCommand(`cp source ${JSON.stringify(realMainRepo)}`, { cwd: realLinkedRepo }),
    ).toBeNull();
    expect(
      analyzeBashCommand(`mv source ${JSON.stringify(realMainRepo)}`, { cwd: realLinkedRepo }),
    ).toBeNull();
  });

  it("blocks static device destruction and targeted shred commands", () => {
    const blocked = [
      "dd if=/dev/zero of=/dev/sda",
      "mkfs /dev/nvme0n1",
      "mkfs.ext4 /dev/sda1",
      "mke2fs /dev/mapper/data",
      "shred important.bin",
      "timeout 2 dd if=/dev/zero of=/dev/sdb",
      "watch mkfs.xfs /dev/sdc1",
      "bash -c 'dd if=/dev/zero of=/dev/sdd'",
      "xargs mkfs.ext4 /dev/sde1",
      "find . -exec shred important.bin \\;",
    ];
    const allowed = [
      "dd if=/dev/zero of=disk.img",
      'dd if=/dev/zero of="$output"',
      "mkfs.ext4 disk.img",
      'mkfs.ext4 "$device"',
      "shred --help",
      "shred -n 3",
      'shred "$target"',
    ];

    for (const command of blocked) expect(analyzeBashCommand(command), command).not.toBeNull();
    for (const command of allowed) expect(analyzeBashCommand(command), command).toBeNull();
  });

  it("covers expanded destructive Git grammar and accepted abbreviations", () => {
    const blocked = [
      "git checkout -fq main",
      "git checkout --for main",
      "git checkout --pathspec-fr=list",
      "git switch -f main",
      "git switch --disc main",
      "git push --mirror origin",
      "git push --del origin old",
      "git push -d origin old",
      "git push origin :old",
      "git push origin +:refs/heads/old",
      "git push origin +main:main",
      "git push --force --force-with-lease origin main",
      "git branch -df old",
      "git branch --forc old",
      "git tag -d v1",
      "git tag --del v1",
      "git reflog delete HEAD@{0}",
      "git worktree remove -fv ../old-tree",
      "git worktree remove --for ../old-tree",
    ];
    const allowed = [
      "git checkout main",
      "git switch main",
      "git push origin main",
      "git push -n origin main",
      "git push origin main:main",
      "git push --force-with-lease origin main",
      'git push origin "$refspec"',
      'git push origin "+$refspec"',
      "git branch -d merged",
      "git tag --list",
      "git reflog show",
      "git worktree remove ../clean-tree",
    ];

    for (const command of blocked) expect(analyzeBashCommand(command), command).not.toBeNull();
    for (const command of allowed) expect(analyzeBashCommand(command), command).toBeNull();
  });

  it("analyzes watch children and shell -c scripts after an option delimiter", () => {
    const blocked = [
      "watch git reset --hard",
      "watch -n 2 'git push origin :old'",
      "watch --interval=1 -- rm -r /",
      "watch --inter 1 git reset --hard",
      "watch --inter=1 git reset --hard",
      "watch -q 3 git reset --hard",
      "watch -q3 git reset --hard",
      "watch --equexit 3 git reset --hard",
      "watch --equexit=3 git reset --hard",
      "watch --equ 3 git reset --hard",
      "watch --equ=3 git reset --hard",
      "watch -s /tmp git reset --hard",
      "watch -s/tmp git reset --hard",
      "watch -s=/tmp git reset --hard",
      "watch --shotsdir /tmp git reset --hard",
      "watch --shotsdir=/tmp git reset --hard",
      "watch --shot /tmp git reset --hard",
      "watch --shot=/tmp git reset --hard",
      "watch --no git reset --hard",
      "watch --mystery git reset --hard",
      "watch -tn 2 git reset --hard",
      "bash -c -- 'git reset --hard'",
      "sh -eu -c -- 'dd if=/dev/zero of=/dev/sda'",
    ];
    const allowed = [
      "watch git status",
      "watch -n 2 -- printf ok",
      "watch -q 3 git status",
      "watch --equexit=3 git status",
      "watch --inter 1 git status",
      "watch --equ=3 git status",
      "watch -s /tmp git status",
      "watch --shotsdir=/tmp git status",
      "watch --shot /tmp git status",
      "watch -d=permanent git status",
      "watch --help git reset --hard",
      "watch --e 3 git reset --hard",
      "watch --mystery value git reset --hard",
      "bash -c -- 'git status'",
      "sh -eu -c -- 'rm -r build'",
    ];

    for (const command of blocked) expect(analyzeBashCommand(command), command).not.toBeNull();
    for (const command of allowed) {
      expect(analyzeBashCommand(command, { cwd: "/tmp/project" }), command).toBeNull();
    }
  });

  it("retains static evidence in malformed-command fallback", () => {
    const cwd = "/tmp/lilac-project";
    const blocked = [
      "rm -r ../outside &&",
      'rm -r "$target" ../outside &&',
      "dd if=/dev/zero of=/dev/sda &&",
      "mkfs.xfs /dev/sda1 &&",
      "shred important.bin &&",
      "git checkout --for main &&",
      "git push --mir origin &&",
      "git push -d origin old &&",
      "git push origin +main:main &&",
      "git tag --del v1 &&",
    ];
    const allowed = [
      "rm -r build &&",
      'rm -r "$target" &&',
      "dd if=/dev/zero of=disk.img &&",
      'shred "$target" &&',
      "git push --force-with-lease origin main &&",
      "git push origin main:main &&",
      'git push origin "+$refspec" &&',
    ];

    for (const command of blocked) {
      expect(analyzeBashCommand(command, { cwd }), command).not.toBeNull();
      expect(dangerousReasonInText(command, { cwd }), command).not.toBeNull();
    }
    for (const command of allowed) {
      expect(analyzeBashCommand(command, { cwd }), command).toBeNull();
      expect(dangerousReasonInText(command, { cwd }), command).toBeNull();
    }
  });

  it("blocks static protected-path access but does not claim process isolation", () => {
    const options = {
      cwd: "/data/workspace",
      protectedPaths: ["/data/secret"],
    };

    expect(analyzeBashCommand("cat /data/secret/mcp-oauth/docs.json", options)).toMatchObject({
      code: "protected_path",
      reason: "access to a configured protected path",
      hint: expect.stringContaining("outside the protected location"),
    });
    expect(analyzeBashCommand("cat ../secret/mcp-oauth/docs.json", options)).not.toBeNull();
    expect(
      analyzeBashCommand("printf nope > /data/secret/mcp-oauth/docs.json", options),
    ).not.toBeNull();
    expect(
      analyzeBashCommand("tar -C/data/secret -cf /tmp/credentials.tar .", options),
    ).not.toBeNull();
    expect(
      analyzeBashCommand("tar -C=/data/secret -cf /tmp/credentials.tar .", options),
    ).not.toBeNull();
    expect(
      analyzeBashCommand("env -C/data/secret cat mcp-oauth/docs.json", options),
    ).not.toBeNull();
    expect(
      analyzeBashCommand("env -C/data/secret bash -c 'cat mcp-oauth/docs.json'", options),
    ).not.toBeNull();
    expect(analyzeBashCommand('cat "$credential_path"', options)).toBeNull();
  });

  it("derives the reason from the protected path that matched", () => {
    const result = analyzeBashCommand("cat /srv/lilac/credentials/token.json", {
      cwd: "/srv/lilac/workspace",
      protectedPaths: ["/srv/other/private", "/srv/lilac/credentials"],
    });

    expect(result?.reason).toBe("access to a configured protected path");
  });
});

describe("audit deletion guard regressions", () => {
  const cwd = "/workspace/project";
  for (const command of ["cd ~", "cd", "cd -", "pushd /elsewhere", 'cd "$TARGET"']) {
    it(`keeps recursive deletion guarded after ${command}`, () => {
      expect(analyzeBashCommand(`${command}; rm -r child`, { cwd })).not.toBeNull();
    });
  }
  it("resolves deletion of the original cwd after cd", () => {
    expect(analyzeBashCommand("cd child; rm -r ..", { cwd })).not.toBeNull();
  });
  for (const target of [
    ".",
    "./",
    "./src",
    "/workspace/project/file",
    ":(literal).",
    "../file",
    "src/*",
    "-- .",
    "HEAD -- src/file.ts",
  ]) {
    it(`blocks git checkout ${target}`, () => {
      expect(analyzeBashCommand(`git checkout ${target}`, { cwd })).not.toBeNull();
    });
  }
  for (const action of ["-exec", "-execdir", "-ok", "-okdir"]) {
    for (const ending of ["\\;", "+"]) {
      it(`guards find ${action} rm with ${ending}`, () => {
        expect(analyzeBashCommand(`find . ${action} rm {} ${ending}`, { cwd })).not.toBeNull();
      });
    }
  }
  it("keeps fail-open behavior for unrecognized commands", () => {
    expect(analyzeBashCommand("custom-cleanup --unknown", { cwd })).toBeNull();
    expect(analyzeBashCommand("git checkout feature", { cwd })).toBeNull();
    expect(analyzeBashCommand("git checkout feature/topic", { cwd })).toBeNull();
  });
});
