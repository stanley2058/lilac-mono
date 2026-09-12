import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { Result } from "better-result";
import { checkMachine } from "./system";
import { installerVersion, installerCommit, clearStaging } from "./deployment";
import { runInstallerHost, withInstallerCleanup } from "./failure";

async function runStagedWizard(
  stagingDir: string,
  originalDataDir: string | undefined,
): Promise<number> {
  const { runWizard } = await import("./wizard");
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
  const compiled = !["bun", "bun.exe"].includes(path.basename(process.execPath));
  const result = await runWizard(stagingDir, compiled);
  const outcome = result.match({
    ok: () => ({ code: 0, message: "" }),
    err: (error) => ({ code: error.cancelled ? 130 : 1, message: error.message }),
  });
  if (outcome.message) process.stderr.write(`${outcome.message}\n`);
  return outcome.code;
}

async function cleanStaging(stagingDir: string): Promise<void> {
  const cleaned = await clearStaging(stagingDir);
  const message = cleaned.match({ ok: () => undefined, err: (error) => error.message });
  if (message) process.stderr.write(`${message}\n`);
}

async function main(): Promise<number> {
  if (process.argv.includes("--version")) {
    process.stdout.write(`Lilac ${installerVersion} (${installerCommit})\n`);
    return 0;
  }
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    process.stdout.write(
      "Lilac setup\n\nRun lilac in a terminal to install or update Lilac.\n\nOptions:\n  --help       Show this help\n  --version    Show installer version\n\nImage overrides:\n  LILAC_IMAGE\n  LILAC_COMPUTER_GATEWAY_IMAGE\n  LILAC_COMPUTER_RUNNER_IMAGE\n\nSetup defaults to the current directory and preserves existing installation data.\n",
    );
    return 0;
  }
  if (process.argv.slice(2).length) {
    process.stderr.write("Unknown option. Run lilac --help.\n");
    return 2;
  }
  process.stdout.write(`\nLilac setup · ${installerVersion}\n\nChecking this machine…\n`);
  const machine = (await checkMachine()).match({
    ok: () => ({ ready: true, message: "" }),
    err: (error) => ({ ready: false, message: error.message }),
  });
  if (!machine.ready) {
    process.stderr.write(`${machine.message}\n`);
    return 1;
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    process.stderr.write(
      "Interactive setup requires a terminal. Run lilac directly, or attach the installer to /dev/tty.\n",
    );
    return 1;
  }
  process.stdout.write("Docker and Compose are ready.\n");
  const staged = await Result.tryPromise({
    try: () => mkdtemp(path.join(tmpdir(), "lilac-setup-")),
    catch: () => "Cannot create a temporary setup directory.",
  });
  const staging = staged.match({
    ok: (directory) => ({ directory, message: "" }),
    err: (message) => ({ directory: "", message }),
  });
  if (!staging.directory) {
    process.stderr.write(`${staging.message}\n`);
    return 1;
  }
  const originalDataDir = process.env.DATA_DIR;
  process.env.DATA_DIR = staging.directory;
  return withInstallerCleanup(
    () => runStagedWizard(staging.directory, originalDataDir),
    () => cleanStaging(staging.directory),
  );
}

process.exitCode = await runInstallerHost(main, (message) => process.stderr.write(`${message}\n`));
