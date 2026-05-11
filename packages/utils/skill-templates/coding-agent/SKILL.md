---
name: coding-agent
description: Essential coding workflow rules for agents doing code changes, reviews, git work, commits, PRs, or GitHub issue work; load this before software engineering tasks.
---

# coding-agent

Use this skill before software engineering work: implementing changes, debugging, refactoring, reviewing code, working with tests, using git, creating commits, or interacting with GitHub issues and pull requests.

## Working Style

- Build context from the repository before deciding on a fix.
- Prefer small, correct changes over broad rewrites.
- Follow the existing architecture, naming, formatting, and testing patterns in the files you touch.
- Ask only when blocked by missing requirements, ambiguity that changes behavior, or an irreversible action.
- If the user asks for a review, prioritize bugs, regressions, missing tests, and risks. Put findings first, ordered by severity, with file and line references when possible.

## Codebase Style

- Treat repository instructions such as `AGENTS.md`, package docs, and nearby code as authoritative.
- Read relevant local instructions before editing when they apply to files you touch.
- Do not introduce new dependencies, exported names, compatibility layers, or large abstractions unless the task needs them.
- Preserve user or other-agent work in the same tree. Never revert unrelated changes.
- Avoid comments unless they clarify non-obvious logic.

## Git And GitHub

- Use `git` when applicable for repository status, diffs, history, branches, and commits.
- Use `gh` when configured and the project is linked to GitHub.
- Use `gh` directly for GitHub issues, pull requests, comments, checks, releases, and repository metadata.
- Treat configured GitHub authentication as the agent's outbound identity.
- If `gh` is unavailable, unauthenticated, or the repository is not linked to GitHub, state that limitation and continue with local `git` and code work where possible.
- Do not use destructive git commands, force pushes, stash, reset hard, or branch switching unless explicitly requested.

## Commits

- Never commit unless the user explicitly asks.
- Before committing, inspect current changes and recent commit history so the commit matches the repository style.
- Stage only files changed for the current task unless the user says to commit everything.
- Do not include secrets, credentials, or unrelated generated files.
- If a commit is tied to a GitHub issue, include the repository's preferred closing syntax only when the relationship is clear.
- If commit hooks modify files, inspect the result and include only relevant follow-up changes.

## Pull Requests

- Before creating a PR, understand the full branch diff and commit history since the base branch.
- Use the repository's PR template when present.
- Write PR titles and summaries around user-visible intent and risk, not just file-level changes.
- Return the PR URL after creation.

## Verification

- Run the most relevant tests, typechecks, builds, linters, or formatters for the changed surface.
- Prefer targeted validation first, then broader checks when the change can affect shared behavior.
- If a required check cannot run, report the exact command and blocker.
- Do not claim a check passed unless it was run successfully in the current worktree.

## Safety

- Keep private data private. Do not print secrets.
- Do not publish, release, send external messages, or mutate remote state unless the task clearly requests it.
- Stop and ask if the next action is destructive, irreversible, or would affect unrelated work.
