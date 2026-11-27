# Lilac Agent Guide

These rules apply to all tasks. Use the linked documents for detailed rules and commands.

## Scope

- Implement only the behavior that the user requests or an approved plan defines. Use the smallest
  solution that meets the requirements.
- Preserve the approved scope and acceptance criteria. Update completion status and evidence as work progresses.
- Do not add cleanup, future features, protection for possible problems, or unrelated fixes. Record
  such work as residual work, but do not implement it.
- Follow product decisions and non-goals. Do not follow conflicting reviewer suggestions.
- Fix review findings that the current change causes. Also fix a finding if it proves that the change
  violates an acceptance criterion or fails a required check.
- Ask the user before you add a new filesystem tool contract, plugin contract, dependency, configuration
  option, or subsystem. Also ask before you add a queue, a journal, a worker, or a recovery process.
- An explicit request or approved plan authorizes the changes it specifies. Ask only for decisions beyond
  that authorization.
- Stop and ask if a fix needs a new product decision or increases the approved scope.

## Compatibility And Safety

- You can change private APIs. You can add a wire contract or stored data contract, or change an
  existing one, but tell the user before you do, and report any such addition or change you already made.
- Get approval before you change an existing filesystem tool contract or plugin contract.
- Do not revert, overwrite, or include unrelated worktree changes.
- Use `ref/` only as a read-only upstream reference.
- Do not put credentials, tokens, private transcripts, or sensitive command data in outputs or files.

## Control Flow

- Keep workflows flat. Keep the happy path at the function's base indentation.
- Handle terminal branches immediately with `return`. Handle loop-only branches immediately with
  `continue` or `break`. A branch, callback, or handler must not contain the remainder of the workflow.
- Extract a named function when a branch needs multiple steps.
- Keep a single guard or two-way branch as an `if`. When an `if`/`else if` chain has at least three
  conditional arms and multiple arms group alternatives with `||`, use `switch (true)` with one decision
  per case. Name compound predicates when that keeps each case to one idea, and make each case terminal or
  delegate it.

## Repository Information

- Use `bun` in this Bun workspace. The workspace packages are in `apps/*` and `packages/*`.
- Read `PROJECT.md` for terms, architecture, code locations, and subsystem owners.
- Read `scripts/architecture/README.md` before you change a trust boundary, persistence code, exception
  code, or architecture registration.
- Read `MIGRATIONS.md` before you change versioned configuration or a stored data contract.
- Use the root `package.json` scripts for build, test, typecheck, lint, and format operations.
- If a type is not visible, follow the `node_modules` symlink into `node_modules/.bun`. Inspect the
  package `exports` or `types` entry to find its type declarations.
- Before you change anything under `apps/web/`, read `apps/web/AGENTS.md` and follow it, including
  its verification and handoff steps.

## Work And Verification

- Use focused tests and the typecheck for each changed workspace.
- Run architecture checks when the change is in code that these checks control.
- Run `bun run check` at least once against the final changes before every commit. Also run full
  repository checks for broad changes, the final plan check, or a user request.
- Do not use fixed waits to synchronize tests. Follow the `lilac/no-fixed-test-wait` rule.
- Commit or create a pull request only when the user requests it.
  - Read recent git history and follow the pattern when creating a commit.
