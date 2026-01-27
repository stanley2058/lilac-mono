# AGENTS.md

This file gives AI coding agents (OpenCode/Cursor/Copilot/etc.) practical repo context: how to build/test, and the expected code style.

## Quick Repo Facts

- Runtime + package manager: **Bun** (`bun`), ESM-first.
- Monorepo: **Bun workspaces** (`apps/*`, `packages/*`).
- **Important**: run `bun install` **inside the package folder** you are working on (not at repo root).
- `ref/` contains vendored/reference projects. Treat as read-only unless a task explicitly says otherwise.
- Cursor rules: none found (`.cursor/rules/`, `.cursorrules` not present).
- Copilot rules: none found (`.github/copilot-instructions.md` not present).

## Layout

- `apps/core/`: core runtime/tools (Bash + filesystem tooling) with Bun tests.
- `apps/tool-bridge/`: CLI/tool bridge, builds to `dist/`.
- `packages/utils/`: shared utilities (env/provider config).
- `packages/agent/`: agent logic.
- `packages/event-bus/`: Redis Streams event bus + tests.
- `ref/`: upstream/reference repos (do not edit by default).

## Install (per package)

From the package you’re touching:

- `cd apps/core && bun install`
- `cd apps/tool-bridge && bun install`
- `cd packages/event-bus && bun install`
- `cd packages/utils && bun install`
- `cd packages/agent && bun install`

Notes:
- Keep `bun.lock` consistent; avoid mixing package managers.
- Workspace deps use `"workspace:*"`.

## Build / Test / Typecheck

### apps/tool-bridge

- Build: `cd apps/tool-bridge && bun run build`
  - Runs `build.ts` and makes `dist/index.js` executable.

### Testing (Bun)

Tests use Bun’s built-in runner + `bun:test`.

- Run all tests in a package:
  - `cd apps/core && bun test`
  - `cd packages/event-bus && bun test`

- Run the monorepo test harness from repo root:
  - `bun test`
  - This intentionally ignores `ref/` (vendored upstreams) and runs workspace tests via `__tests__/workspaces.test.ts`.

- Run a single test file:
  - `cd apps/core && bun test tests/tools/bash.test.ts`
  - `cd packages/event-bus && bun test tests/redis-streams-bus.test.ts`

- Run a single test by name (regex):
  - `cd apps/core && bun test --test-name-pattern "blocks rm -rf"`

Tips:
- Prefer targeting a file or `--test-name-pattern` to keep feedback fast.

### Typechecking

Treat running `tsc` as essential (same tier as running tests). OpenCode’s TypeScript LSP can be unreliable in this monorepo, so `tsc` is the source of truth.

There is no repo-wide `typecheck` script currently.

Notes:
- OpenCode's TypeScript LSP needs `typescript` installed in the repo (we keep it as a root devDependency). Run `bun install` at repo root once if you want TS LSP features.

- Run typecheck in the package you changed:
  - `cd <package> && bunx tsc -p tsconfig.json --noEmit`

If `bunx` needs to install `typescript`, that may require network access.

### Lint / Format

There is no active lint/formatter configuration in `apps/*` or `packages/*` (no ESLint/Prettier/Biome config found outside `ref/`).

- Keep changes consistent with existing code style.
- Do not reformat unrelated code.

## Code Style Guidelines (TypeScript)

### Language + module system

- Use **TypeScript** with **ESM** (`"type": "module"` in packages).
- TS is configured as **strict** (`"strict": true`) and uses bundler-style resolution.
- Prefer `export` / `import` syntax everywhere; avoid CommonJS.

### Formatting (match existing files)

- Indentation: 2 spaces.
- Quotes: double quotes.
- Semicolons: yes.
- Trailing commas: yes where idiomatic (multiline objects/arrays/params).
- Keep lines readable; wrap long ternaries/conditions.

### Imports

- Prefer top-level static imports.
- Use `import type { ... }` for type-only imports.
- Group imports with blank lines:
  - External imports
  - Internal relative imports
- Prefer named exports over default exports.

### Types (important)

- **No `any`** and **no `as any`**.
  - If you must bridge unknown data, use `unknown` + narrowing.
  - Prefer user-defined type guards:
    - `function isFoo(x: unknown): x is Foo { ... }`
- Prefer unions and discriminated unions for error/results.
- Prefer `Record<string, T>` to `{ [k: string]: T }`.
- Prefer `readonly T[]` when you don’t mutate.
- Use `satisfies` when validating object shapes without widening.

### Naming conventions

- Files: `kebab-case.ts` (matches existing: `bash-impl.ts`, `redis-streams-bus.ts`).
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

- Never assume JSON is valid.
- Prefer “safe parse” helpers that return `unknown | undefined` (pattern exists in `packages/event-bus/*`).

### Testing conventions

- Use `bun:test`:
  - `import { describe, expect, it } from "bun:test";`
- Keep tests deterministic and fast.
- Prefer narrow unit tests over integration tests.
- Test files live in `tests/` and are named `*.test.ts`.

## Monorepo / references

- `ref/` is for reference material and vendored upstreams.
  - Don’t change `ref/*` unless explicitly asked.
  - Don’t copy rules from `ref/*` blindly; this repo’s active workspace is `apps/*` + `packages/*`.

- When reading external/library code:
  - Prefer `ref/` first (it often contains the upstream repo).
  - If you need `node_modules`, run `ls -la node_modules` (and `ls -la node_modules/<pkg>`) before calling Read, to avoid path mistakes.

- `ref/` currently includes:
  - `ref/ai`
  - `ref/claude-code-safety-net`
  - `ref/js-llmcord`
  - `ref/opencode`
  - `ref/pi-mono`

## When Unsure

- Prefer minimal, surgical changes.
- Ask for clarification before:
  - Changing public APIs
  - Renaming exported symbols
  - Introducing new dependencies
  - Editing anything under `ref/`
