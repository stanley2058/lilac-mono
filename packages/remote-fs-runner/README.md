# @stanley2058/lilac-remote-fs-runner

Remote filesystem helper used by Lilac SSH tools.

The CLI reads one JSON request from stdin, starts or reuses a local daemon on the remote machine, forwards the request over a Unix socket, and writes the JSON response to stdout. The daemon exits after five idle minutes by default. It uses `@ff-labs/fff-node` for warm indexed search when available. Fuzzy file search falls back to an on-demand filesystem walk ranked by `fzf` when an FFF index is unavailable or unsafe for the requested path.

This package is intended to be launched by Lilac via `npx`/`bunx`, not called directly by users.
