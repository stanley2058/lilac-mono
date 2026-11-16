import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  REMOTE_RUNNER_BINARY_NAME as BINARY_NAME,
  REMOTE_RUNNER_DIST_DIR as DIST_DIR,
  REMOTE_RUNNER_TARGETS as ALL_TARGETS,
  type RemoteRunnerTarget as Target,
} from "../apps/remote-runner/index";

const RUNNER_DIR = path.resolve(import.meta.dir, "../apps/remote-runner");

function usage(): never {
  throw new Error("Usage: bun scripts/build-remote-runner.ts [--all | --target <triple>...]");
}

function isTarget(value: string): value is Target {
  return (ALL_TARGETS as readonly string[]).includes(value);
}

function hostTarget(): Target {
  const arch = process.arch === "arm64" ? "aarch64" : process.arch === "x64" ? "x86_64" : null;
  if (!arch) throw new Error(`No remote runner target matches this machine (${process.arch})`);
  if (process.platform === "linux") return `${arch}-unknown-linux-musl`;
  if (process.platform === "darwin") return `${arch}-apple-darwin`;
  throw new Error(`No remote runner target matches this machine (${process.platform})`);
}

function parseTargets(args: readonly string[]): Target[] {
  if (args.length === 0) return [hostTarget()];
  if (args.length === 1 && args[0] === "--all") return [...ALL_TARGETS];
  const targets: Target[] = [];
  for (let index = 0; index < args.length; index += 2) {
    const value = args[index + 1];
    if (args[index] !== "--target" || !value || !isTarget(value)) usage();
    targets.push(value);
  }
  return targets;
}

function run(command: string, args: readonly string[], env: Record<string, string> = {}) {
  const result = spawnSync(command, args, {
    cwd: RUNNER_DIR,
    stdio: "inherit",
    env: { ...process.env, ...env },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} exited with ${result.status ?? "a signal"}`);
  }
}

function hasCommand(command: string, versionArgs: readonly string[] = ["--version"]): boolean {
  return spawnSync(command, versionArgs, { stdio: "ignore" }).status === 0;
}

function cargoEnvKey(target: Target, name: string): string {
  return `CARGO_TARGET_${target.toUpperCase().replaceAll("-", "_")}_${name}`;
}

// Rust's minimum for aarch64-apple-darwin, used for both macOS targets. zig ignores rustc's
// `-mmacosx-version-min` and applies its own default (macOS 15) unless the target names a version.
const MACOS_MIN_VERSION = "11.0";

// Linking macOS binaries off a Mac uses zig as the linker. Rust's standard library links libiconv,
// which zig does not ship, so a text stub stands in for the system library at link time.
function zigMacosLinkerEnv(target: Target): Record<string, string> {
  if (!hasCommand("zig", ["version"])) {
    throw new Error(`Building ${target} on this machine needs zig on PATH`);
  }
  const workDir = mkdtempSync(path.join(tmpdir(), "lilac-remote-zig-"));
  const zigArch = target.startsWith("aarch64") ? "aarch64" : "x86_64";
  const linker = path.join(workDir, "cc");
  writeFileSync(
    linker,
    [
      "#!/bin/sh",
      "for arg do",
      "  shift",
      '  case "$arg" in --target=*|-arch|arm64|x86_64) continue ;; esac',
      '  set -- "$@" "$arg"',
      "done",
      `exec zig cc -target ${zigArch}-macos.${MACOS_MIN_VERSION} "$@"`,
      "",
    ].join("\n"),
  );
  chmodSync(linker, 0o755);
  writeFileSync(
    path.join(workDir, "libiconv.tbd"),
    [
      "--- !tapi-tbd",
      "tbd-version: 4",
      "targets: [ x86_64-macos, arm64-macos ]",
      "install-name: '/usr/lib/libiconv.2.dylib'",
      "current-version: 7",
      "compatibility-version: 7",
      "exports:",
      "  - targets: [ x86_64-macos, arm64-macos ]",
      "    symbols: [ _iconv, _iconv_open, _iconv_close ]",
      "...",
      "",
    ].join("\n"),
  );
  return {
    [cargoEnvKey(target, "LINKER")]: linker,
    [cargoEnvKey(target, "RUSTFLAGS")]: `-L native=${workDir}`,
  };
}

function linkerEnv(target: Target): Record<string, string> {
  if (target.endsWith("-linux-musl")) return { [cargoEnvKey(target, "LINKER")]: "rust-lld" };
  if (process.platform === "darwin") return {};
  return zigMacosLinkerEnv(target);
}

function build(target: Target) {
  if (hasCommand("rustup")) run("rustup", ["target", "add", target]);
  run(
    "cargo",
    ["build", "--release", "--locked", "--target", target, "--bin", BINARY_NAME],
    linkerEnv(target),
  );
  const outputDir = path.join(DIST_DIR, target);
  mkdirSync(outputDir, { recursive: true });
  const output = path.join(outputDir, BINARY_NAME);
  copyFileSync(path.join(RUNNER_DIR, "target", target, "release", BINARY_NAME), output);
  chmodSync(output, 0o755);
  console.log(`built ${path.relative(process.cwd(), output)}`);
}

for (const target of parseTargets(process.argv.slice(2))) build(target);
