import { homedir } from "node:os";
import path from "node:path";

export const HELP_TEXT = `mini-lilac - local coding-agent clients and server

Usage:
  mini-lilac [tui-options]
  mini-lilac tui [tui-options]
  mini-lilac server [server-options]

Commands:
  tui      Start the terminal client (default)
  server   Start or administer the Mini Lilac server

Run 'mini-lilac tui --help' or 'mini-lilac server --help' for command options.
`;

export type MiniLilacCommandRunners = {
  readonly tui: (args: readonly string[]) => Promise<number>;
  readonly server: (args: readonly string[]) => Promise<void>;
};

export function ensureServerDataDir(
  env: Record<string, string | undefined>,
  homeDirectory = homedir(),
): void {
  if (env.DATA_DIR?.trim()) return;
  const stateHome = env.XDG_STATE_HOME?.trim() || path.join(homeDirectory, ".local", "state");
  env.DATA_DIR = path.join(stateHome, "mini-lilac");
}

const defaultRunners: MiniLilacCommandRunners = {
  async tui(args) {
    const { main } = await import("../../mini-lilac-tui/src/main");
    return main(args);
  },
  async server(args) {
    ensureServerDataDir(process.env);
    const { main } = await import("../../mini-lilac-server/src/main");
    await main(args);
  },
};

export async function runMiniLilac(
  args: readonly string[],
  runners: MiniLilacCommandRunners = defaultRunners,
  writeOutput: (text: string) => void = (text) => process.stdout.write(text),
): Promise<number> {
  const [command, ...commandArgs] = args;

  if (command === "--help" || command === "-h" || command === "help") {
    writeOutput(HELP_TEXT);
    return 0;
  }
  if (command === "server") {
    await runners.server(commandArgs);
    return 0;
  }
  if (command === "tui") return runners.tui(commandArgs);
  return runners.tui(args);
}

if (import.meta.main) {
  runMiniLilac(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`${message}\n`);
      process.exitCode = 1;
    });
}
