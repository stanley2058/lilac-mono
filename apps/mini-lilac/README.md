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
