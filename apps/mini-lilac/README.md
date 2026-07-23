# Mini Lilac

The installable Mini Lilac command. It bundles the terminal client and server behind one extensible
entry point:

```sh
mini-lilac                         # terminal client
mini-lilac tui --session <id>      # explicit terminal client
mini-lilac server                  # server
mini-lilac server auth codex       # server administration
```

Build and exercise the package from this directory:

```sh
bun run build
./dist/main.js --help
./dist/main.js server --help
```

The client and server remain separate workspace apps. This package owns command routing and the
distribution artifact so future clients can be added as subcommands without coupling their code to
the TUI or server.
