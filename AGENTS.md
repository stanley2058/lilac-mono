# AGENTS.md

This file helps AI coding agents to work on this repo without making repeating mistakes.

## Quick Repo Facts

- Use `bun`
- Monorepo: **Bun workspaces** (`apps/*`, `packages/*`).
- Project mental model / terminology: search `PROJECT.md`.
- `ref/` contains vendored/reference projects. Treat as read-only references.
- Treat project as greenfield, breaking changes are ok.

## Finding Type Definitions (Bun + symlinks)

This repo uses Bun's install layout. Many packages in `apps/*/node_modules` are symlinks into Bun's cache under `node_modules/.bun/...`. If you can't find a type definition by searching the workspace `node_modules`, follow the symlink and then follow `package.json` `exports`/`types`. Always use `ls -al` because the `grep`, `glob` don't work on ignored files and dot-dirs.

## Build / Test / Typecheck

### Build

- `apps/core`: `cd apps/core && bun run build:remote-runner` (test suite need this for parity test on remote runner)
- `apps/tool-bridge`: `cd apps/tool-bridge && bun run build`
- `apps/opencode-controller`: `cd apps/opencode-controller && bun run build`

### Testing (Bun)

Tests use Bun’s built-in runner + `bun:test`.

- Run all tests in a package:
  - `cd apps/core && bun test`
  - `cd packages/utils && bun test`
  - `cd packages/event-bus && bun test`

- Run the monorepo test harness from repo root:
  - `bun test`

- Run a single test file:
  - `cd apps/core && bun test tests/tools/bash.test.ts`
  - `cd packages/event-bus && bun test tests/redis-streams-bus.test.ts`

- Run a single test by name (regex):
  - `cd apps/core && bun test --test-name-pattern "<pattern>"`

### Typechecking

- Treat running `tsc` as essential (same tier as running tests).
- Run typecheck in the package you changed (root level `typecheck` also exist):
  - `cd <package> && bunx tsc -p tsconfig.json --noEmit`

### Lint / Format

This repo uses Oxc tooling at the root:

- Lint: `bun run lint` (`oxlint`)
- Lint fix: `bun run lint:fix` (`oxlint --fix`)
- Format check: `bun run fmt:check` (`oxfmt --check`)
- Format write: `bun run fmt` (`oxfmt --write`)

Before wrapping up any task that changes code/config/docs, run lint + format checks from repo root at least once as the final validation step:

- `bun run lint:fix`
- `bun run fmt`

## Code Style Guidelines (TypeScript)

### Types (important)

- **No `any`** and **no `as any`**.
  - If you must bridge unknown data, use `unknown` + narrowing.
  - Prefer using `zod` schemas to parse/validate `unknown` at boundaries (tool inputs, JSON/YAML, external APIs) when possible.
  - Prefer user-defined type guards:
    - `function isFoo(x: unknown): x is Foo { ... }`
- Prefer type narrowing over casting (`as Foo`) when possible.
- Prefer unions and discriminated unions for error/results.
- Avoid erasing discriminated unions by narrowing to generic shapes (e.g. `isRecord(x): x is Record<string, unknown>`) on values that are already strongly typed; prefer checking the discriminant (`part.type === "tool-result"`) or use a type guard that returns the precise union member.
- Avoid `as unknown as SomeType` casts that effectively act like `as any` (they hide concrete types and break narrowing). Prefer proper narrowing, precise type guards, or compiler-assisted inspection (e.g. typehint) to find the real type.
- Prefer `Record<string, T>` to `{ [k: string]: T }`.
- Prefer `readonly T[]` when you don’t mutate.
- Use `satisfies` when validating object shapes without widening.

### Imports

- Group imports with blank lines:
  - External imports
  - Internal relative imports
- Prefer named exports over default exports.

### Naming conventions

- Files: `kebab-case.ts`.
- Functions/variables: `camelCase`.
- Types/interfaces/classes: `PascalCase`.
- Constants: `UPPER_SNAKE_CASE`.

### Error handling

- Convert unknown caught values safely:
  - `const msg = e instanceof Error ? e.message : String(e)`
- Avoid swallowing errors silently.
- For library-like code:
  - Throw for programmer/configuration errors.
  - For runtime/IO failures, either throw with context or return a typed error object.
- Avoid leaking secrets in logs; redact tokens/keys when printing command/env data.

### JSON / parsing

- Use `zod` to create reusable schemas.
- Never assume JSON is valid.

### Testing conventions

- Use `bun:test`
- Keep tests deterministic and fast.
- Prefer narrow unit tests over integration tests.

## Monorepo / references

- `ref/` is for reference material and vendored upstreams.
  - `ref/*` are git submodules and may not be checked out on a fresh clone.
  - Don’t copy rules from `ref/*` blindly; this repo’s active workspace is `apps/*` + `packages/*`.
- When reading external/library code:
  - Prefer `ref/` first (it often contains the upstream repo).

## When Unsure

- Prefer minimal, surgical changes.
- Ask for clarification before:
  - Renaming exported symbols
  - Introducing new dependencies
