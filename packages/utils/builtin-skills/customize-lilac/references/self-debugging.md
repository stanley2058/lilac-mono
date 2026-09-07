# Deployed self-debugging

Use the deployed instance as the ground truth for what code exists and what state is active.

## Establish the target

1. Use `/app` as the source root when `/app/apps/core` and `/app/packages/utils` exist. Otherwise find
   the current Lilac repository root.
2. Read `<source-root>/build/build-info.json` when present. Record its version, commit, dirty flag, and
   build time without inventing values for absent fields.
3. Confirm the relevant process or command when the question depends on the running entry point. Core's
   container command starts `apps/core/src/runtime/main.ts`.

This step is complete when the answer names the inspected source root and build identity, or states which
identity evidence is unavailable.

## Trace the behavior

1. Search the exact config path, callable ID, event name, error text, or exported symbol under
   `<source-root>/apps/core` and `<source-root>/packages` with `rg`.
2. Start lifecycle questions at `apps/core/src/runtime/create-core-runtime.ts`. Follow imports to the
   owner named by the current source instead of inferring ownership from filenames alone.
3. Read the smallest complete path from composition to the final consumer. Include codecs or schemas when
   the behavior crosses a wire, filesystem, persistence, plugin, or provider boundary.
4. Compare the implementation with the relevant active state under `DATA_DIR`, usually
   `core-config.yaml`. Inspect database metadata or other retained state only when the user's request puts
   it in scope.

This step is complete when every claimed mechanism is supported by current shipped source and every
runtime claim is supported by current state or a live diagnostic.

## Check live evidence

- Use existing health endpoints, Level 2 callables, and the installed `tools` CLI when they directly test
  the question. Discover their current inputs before calling them.
- Use logs only through an available log source. Absence of log access is an unresolved evidence gap, not
  proof that an event did not occur.
- Treat `/app` as immutable reference material. Runtime changes belong in the operator-owned location or
  source repository selected by the user's request.

## Report

Separate the result into:

- **Observed:** build metadata, active config, process state, diagnostics, or logs inspected now.
- **Derived:** the current source path that explains the observation.
- **Unresolved:** evidence that was unavailable or behavior that depends on external systems.

Include precise file paths and relevant symbol names so another agent can reproduce the trace.
