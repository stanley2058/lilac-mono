# @stanley2058/lilac-remote-fs-runner

Remote filesystem helper used by Lilac SSH tools.

The CLI starts or reuses a short-lived local daemon on the remote machine, then serves JSON filesystem requests over a Unix socket. It uses `@ff-labs/fff-node` for warm indexed search when available and falls back through Lilac's shared filesystem backend behavior.

This package is intended to be launched by Lilac via `npx`/`bunx`, not called directly by users.
