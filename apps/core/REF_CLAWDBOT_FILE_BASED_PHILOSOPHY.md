# Clawdbot: File-Based Everything (Philosophy + Lessons)

This document is a research note on `ref/clawdbot/` and the design philosophy that falls out of it.

Focus: the "simplicity of file-based everything" approach: using ordinary files/folders as the primary persistence layer, extension mechanism, and debugging surface.

## The Core Philosophy (as observed)

Clawdbot is built around a single long-running Gateway process, but it deliberately keeps most durable state in the filesystem, in human-auditable formats.

Key ideas:

- Prefer files and folders over bespoke services for local state.
- Keep state legible and directly editable (when safe).
- Use a small number of well-known paths as the product interface.
- Make overrides and customization composable via directory precedence.
- Treat the Gateway as the authority for *how* state is interpreted, but not as the only way to *inspect* it.

## "File-Based Everything" in Concrete Terms

### 1) One state root directory

The design is anchored around a single state directory:

- Default: `~/.clawdbot`
- Override: `CLAWDBOT_STATE_DIR`

This gives a simple mental model:

- Code is installed somewhere (npm/app).
- All mutable state lives under one directory.
- Backups/migration are primarily about that directory.

Evidence:

- `ref/clawdbot/src/config/paths.ts` defines `resolveStateDir()` and uses it as the base for config and other stores.

### 2) One primary config file

Configuration resolves to a single file path:

- Default: `~/.clawdbot/clawdbot.json` (JSON5)
- Override: `CLAWDBOT_CONFIG_PATH`

This avoids "configuration sprawl" (no many-dotfile maze) while still allowing advanced users to relocate config.

Evidence:

- `ref/clawdbot/src/config/paths.ts` defines `resolveConfigPath()`.
- `ref/clawdbot/README.md` consistently references `~/.clawdbot/clawdbot.json` as the main config surface.

### 3) Sessions are plain files (JSON + JSONL)

Clawdbot persists conversational state using two file types:

- `sessions.json`: a small mutable key/value store (session metadata)
- `<sessionId>.jsonl`: append-only transcripts (conversation + tool calls + compaction summaries)

This is a big philosophical choice:

- You can inspect history with `less`, `rg`, `jq`, etc.
- Appends are safer than in-place edits for long histories.
- Metadata stays small and rewritable without rewriting the transcript.

Evidence:

- `ref/clawdbot/docs/reference/session-management-compaction.md` explains:
  - Store: `~/.clawdbot/agents/<agentId>/sessions/sessions.json`
  - Transcripts: `~/.clawdbot/agents/<agentId>/sessions/<sessionId>.jsonl`

### 4) Skills are folders with `SKILL.md`

Instead of storing skill definitions in a DB or requiring registration, skills are discovered from directories.

Three-tier load order (high signal for extensibility and override mechanics):

1. `<workspace>/skills` (highest precedence)
2. `~/.clawdbot/skills` (shared/local overrides)
3. bundled skills (lowest precedence)

This creates a simple customization story:

- Want to patch a skill? Copy it into a higher-precedence folder.
- Want shared skills across agents? Put them under `~/.clawdbot/skills`.
- Want per-agent skills? Put them under that agent's workspace.

Evidence:

- `ref/clawdbot/docs/tools/skills.md` details locations, precedence, and gating.

### 5) Hooks are folders with `HOOK.md` + code

Hooks are also file-discovered:

- Bundled hooks ship with the project.
- Users can add custom hooks without modifying Clawdbot core.

Two-tier hook placement:

- `<workspace>/hooks/` (highest precedence)
- `~/.clawdbot/hooks/` (shared across workspaces)

Hooks follow a minimal folder contract:

- `HOOK.md` (frontmatter + docs)
- `handler.ts` (implementation)

Evidence:

- `ref/clawdbot/src/hooks/bundled/README.md` describes structure and custom hook locations.

### 6) Extensions/plugins install as files under the state dir

Plugins/extensions are installed by copying a package directory into the state tree:

- `~/.clawdbot/extensions/<pluginId>`

Notably:

- The install logic avoids "global plugin registries".
- Dependencies are installed inside the plugin directory.

This keeps the system understandable:

- Uninstall is largely "delete the folder".
- A plugin is a folder you can inspect.

Evidence:

- `ref/clawdbot/src/plugins/install.ts` resolves the install dir under `CONFIG_DIR/extensions` (where `CONFIG_DIR` is the state dir root).

### 7) Global env fallback is a file

Clawdbot supports a `.env` fallback file located in the state dir:

- `~/.clawdbot/.env`

This is pragmatic for daemon/service installs where "shell env" is not reliable.

Evidence:

- `ref/clawdbot/src/infra/dotenv.ts` loads dotenv from CWD first, then from `resolveConfigDir(...)/.env` without overriding existing vars.

### 8) Security approvals are a file (policy-as-data)

Exec approval policy is stored in a local JSON file:

- `~/.clawdbot/exec-approvals.json`

This includes allowlists and prompting policy.

This is also consistent with the "file-first" theme:

- the security model is inspectable,
- and the state is portable (with appropriate secret handling).

Evidence:

- `ref/clawdbot/docs/tools/exec-approvals.md`.

## Patterns Behind the File-Based Approach

### A) Precedence-based customization (overrides without patching core)

The repeated pattern:

- provide a bundled default,
- allow a managed/shared override folder,
- allow a workspace-local override folder,
- define deterministic precedence.

This is the file-system equivalent of dependency injection.

Where it shows up:

- Skills precedence (`<workspace>/skills` beats `~/.clawdbot/skills` beats bundled)
- Hooks precedence (`<workspace>/hooks` beats `~/.clawdbot/hooks` beats bundled)

### B) Separate "small mutable index" from "append-only history"

Clawdbot uses:

- `sessions.json` for mutable pointers and counters,
- `*.jsonl` for durable event history.

This split avoids constantly rewriting large files while preserving a full audit trail.

### C) "Files are the UI"

Many important product surfaces are just paths:

- config: `~/.clawdbot/clawdbot.json`
- env: `~/.clawdbot/.env`
- transcripts: `~/.clawdbot/agents/<agentId>/sessions/*.jsonl`
- logs: `~/.clawdbot/logs/...`
- policy: `~/.clawdbot/exec-approvals.json`

This lowers the cost of debugging because you can reason about the system without running a special admin client.

### D) Keep the Gateway authoritative, but keep the storage simple

Even though files are the persistence layer, Clawdbot is explicit that:

- the Gateway is the source of truth for session state and token counts,
- but the on-disk representation is still meaningful for troubleshooting.

Evidence:

- `ref/clawdbot/docs/reference/session-management-compaction.md` calls out "Source of truth: the Gateway" while still documenting exact file locations.

## Tradeoffs (and how Clawdbot mitigates them)

File-based systems are not automatically simpler in operation. The benefits come with a few recurring risks:

- Concurrency/corruption risk if multiple writers touch the same files.
  - Mitigation: a single Gateway owns writes; append-only transcripts reduce rewrite risk.
- State drift from multiple state dirs or moved configs.
  - Mitigation: doctor checks detect split state directories.
- Secret leakage via backups or committing state to git.
  - Mitigation: explicit guidance to keep `~/.clawdbot` out of git.

Evidence:

- `ref/clawdbot/src/commands/doctor-state-integrity.ts` warns about multiple state dirs and recommends keeping `~/.clawdbot` out of git.

## What We Can Learn (for Lilac / our core plans)

If we want the same "feels local, easy to debug" ergonomics, Clawdbot suggests a few high-leverage moves.

### 1) Pick a single, obvious state dir

- Make "where state lives" a first-class decision.
- Keep all mutable runtime artifacts under it (cache, logs, transcripts, approvals).

This improves:

- supportability ("zip this folder" style debugging),
- backup/migration clarity,
- and operational predictability.

### 2) Use the filesystem as the extensibility surface

Instead of requiring "registering" plugins/skills/hook logic in code or a DB:

- define a minimal folder contract,
- discover by scanning well-known directories,
- and keep precedence rules deterministic.

This yields "drop-in" extensibility and makes it possible to ship defaults while still letting users override locally.

### 3) Prefer append-only logs for anything that looks like an event stream

If a thing is naturally an event stream (messages, tool calls, bus events, lifecycle), JSONL is a strong default:

- easy to write,
- easy to tail,
- easy to ingest later into a DB if needed.

Clawdbot's session model is a concrete example of combining:

- small mutable index (fast lookups),
- append-only history (auditability + replay potential).

### 4) Make "doctor" (integrity checks) part of the design

A file-based system needs guardrails:

- permissions checks,
- missing directory creation,
- detection of split state dirs,
- detection of missing transcripts referenced by the index.

Clawdbot treats this as a core feature, not an afterthought.

### 5) Keep the storage formats boring

Clawdbot mostly sticks to:

- JSON/JSON5 for mutable configs and policy
- JSONL for append-only transcripts/logs
- Markdown + frontmatter for human-facing "instruction" assets (skills/hooks)

The result: fewer bespoke parsers and fewer "special tools" needed for introspection.

## Evidence Map (files referenced)

- `ref/clawdbot/src/config/paths.ts` (state dir + config path)
- `ref/clawdbot/src/infra/dotenv.ts` (global `.env` fallback)
- `ref/clawdbot/src/plugins/install.ts` (extensions install under state dir)
- `ref/clawdbot/docs/reference/session-management-compaction.md` (sessions.json + jsonl transcripts)
- `ref/clawdbot/docs/tools/skills.md` (skill folders + precedence)
- `ref/clawdbot/src/hooks/bundled/README.md` (hook folder contract + precedence)
- `ref/clawdbot/docs/tools/exec-approvals.md` (policy-as-file)
- `ref/clawdbot/src/commands/doctor-state-integrity.ts` (integrity checks + "don't git ~/.clawdbot")
