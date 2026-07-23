# Mini Lilac

The installable Mini Lilac command. It bundles the terminal client and server behind one extensible
entry point:

```sh
mini-lilac                         # terminal client
mini-lilac tui --session <id>      # explicit terminal client
mini-lilac server                  # server
mini-lilac server auth codex       # server administration
```

Install it with Bun or npm. Bun remains the runtime because the server uses Bun APIs:

```sh
bun add --global @stanley2058/mini-lilac
# or
npm install --global @stanley2058/mini-lilac
```

## First Run

Create the default server configuration, authenticate with Codex, and start the server:

```sh
mini-lilac server init
mini-lilac server auth codex
mini-lilac server
```

In another terminal, start the client from the workspace you want Mini Lilac to use:

```sh
cd /path/to/your/project
mini-lilac
```

`server init` writes `config.yaml`, `providers.yaml`, and `auth.json` under
`$XDG_STATE_HOME/mini-lilac` (or `~/.local/state/mini-lilac`). Existing files are skipped; use
`mini-lilac server init --force` to replace them.

Build and exercise the publication-ready package from this directory:

```sh
bun run build
./dist/main.js --help
./dist/main.js server --help
npm pack ./dist
```

`bun run pack:npm` creates the npm tarball. `bun run publish:npm` publishes the staged `dist/`
package, leaving workspace-only source, scripts, and dependencies out of the registry metadata.

The client, server, and their internal workspace dependencies are bundled into `dist/main.js`.
`@opentui/core` remains a package dependency so the package manager installs the correct native
binary for the target platform. No other Mini Lilac workspace package is required after publishing.
