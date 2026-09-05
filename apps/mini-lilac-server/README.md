# Mini Lilac Server

An Elysia HTTP server for `@stanley2058/mini-lilac-runtime`. Its API is mounted at
`/api/mini-lilac`, matching the default `MiniLilacTransport` base URL.

## Configure

Mini Lilac centralizes persistent server state under `$XDG_STATE_HOME/mini-lilac` (falling back to
`~/.local/state/mini-lilac`). Initialize the three required configuration files before starting:

```sh
mini-lilac server init
```

Existing files are preserved unless `--force` is supplied. The three-file configuration remains
strict even when OAuth supplies OpenAI authentication, so `auth.json` must exist and may contain
`{}`.

The server caches the validated models.dev registry at `models-dev.json` in this state directory.
Startup reuses a fresh, complete cache; otherwise it waits for a catalog refresh before listening.
Catalog fetch failures emit warnings and use stale entries when available. Without cached entries,
the affected providers can have no models in the catalog even though the HTTP server starts.

Serving also holds a non-blocking `flock` lock beside the selected SQLite file. A second Mini Lilac
server targeting the same database exits before opening it; the `flock` executable is therefore a
runtime prerequisite.

The example config points to the copied `providers.yaml` and `auth.json`. Loopback listeners do not
require HTTP authentication. For a non-loopback listener, set `server.authTokenEnv` and export that
exact environment variable; every API endpoint except `/api/mini-lilac/healthz` then requires
`Authorization: Bearer <token>`.

The example is OAuth-first. Authenticate before starting the server; this does not require a server
config and does not read or modify `~/.codex/auth.json`:

```sh
mini-lilac server auth codex
mini-lilac server auth codex --status
```

The command prints the authorize URL and stores owner-private Lilac tokens at
`$XDG_STATE_HOME/mini-lilac/codex.json` (the exact path is printed). A direct `type: openai`
provider without a custom `baseUrl` then uses the hardened ChatGPT Codex backend while models retain the
`openai/<model>` namespace. Its catalog must be `models-dev` because `/v1/models` requires OpenAI
API-key authentication. For OAuth-superseded providers, the catalog includes GPT-5 minor generation
3 or newer models only when models.dev marks them as reasoning- and tool-capable, with text input
and text-only output. This keeps conversational Codex models while excluding embeddings, image,
audio, realtime, and older model families. Remove the tokens with
`mini-lilac server auth codex --logout`.

For API-key fallback, leave the same `providers.yaml` in place and put this in the owner-only
`auth.json` instead:

```json
{
  "openai": {
    "type": "api-key",
    "key": "sk-replace-with-a-real-key"
  }
}
```

OAuth supersedes this API key when both exist. A custom-`baseUrl` OpenAI provider is never
superseded and always requires its configured key. Do not put real credentials in tracked files.
Each provider in `providers.yaml` uses `type` as its provider discriminator; API-key entries use the
exact shape `{ "type": "api-key", "key": "..." }`.

### Local Claude Subscription

See the [shared Claude Code provider reference](../../docs/claude-code.md) for authentication,
executable resolution, exact fresh/fork continuation, cross-family replay, retention, and security.

Add the commented `claude-code` provider from `providers.example.yaml`. It must use
`catalog: models-dev`, must not set `baseUrl`, and must not have an `auth.json` entry. The published
single-file `mini-lilac` command requires an external official `claude` executable on `PATH`. A custom
Mini container must install or mount that executable and provide Claude authentication explicitly.

Mini enables Claude's `ToolSearch` over its deferred MCP tool catalog. Profiles that request
`websearch` additionally receive Claude's built-in `WebSearch`. Main-session history navigation keeps
bindings on exact retained history states; named subagents continue only when callers reuse the stable
`sessionName` supplied to or returned by `subagent_delegate`.

`workspaceWrites: false` also disables Bash because allowed commands have unrestricted process
authority and can write outside filesystem-tool guardrails. Bash safety blocks known destructive
operations, expansion-sensitive recursive deletion, and protected paths by default, but it is not
a sandbox. Filesystem and patch tools similarly deny credential and state paths by default. For a
profile that exposes the relevant tool, `dangerouslyAllow: true` is an explicit per-call escape
hatch that bypasses its guardrails, including protected-path checks. Hidden paths such as `.bun` do
not require this flag unless a tool first reports an access denial. Bash receives an environment
with the HTTP auth-token variable removed.

Model-facing tool results are limited to 40 KiB. For `read`, that limit applies only to the
returned textual payload, measured as UTF-8 bytes; metadata, paths, JSON encoding, and loaded
`AGENTS.md` instructions are outside the limit. Direct and batched reads return `nextStart` rather
than creating duplicate overflow artifacts, and batched reads do not share an aggregate inline
budget. When another non-Bash tool completes with a larger materialized result, Mini Lilac stores
the complete sanitized result under the transient, session-scoped `tool-result://` artifact
referenced by the replacement tool error. Use `read` with that URI and its returned `nextStart`
to page the result, or use `grep` with the URI as `path` to search it without creating another
artifact. Bash keeps a bounded head-and-tail
preview and includes the artifact URI in its structured truncation metadata. Encrypted artifact
files live under `$XDG_STATE_HOME/mini-lilac/tool-results`, are invalidated when the server restarts,
and never include results omitted by native query limits such as `maxResults` or `maxCharacters`.

## Run

From the repository root, run `bun run apps/mini-lilac/src/main.ts server`. The installable command
exposes the same entry point as `mini-lilac server`.

The server defaults to `$XDG_STATE_HOME/mini-lilac/config.yaml`; `--config` can still select another
file. SQLite defaults to `$XDG_STATE_HOME/mini-lilac/mini-lilac.sqlite`. Override either path when
needed:

```sh
mini-lilac server --config ./config.yaml --database ./data/mini-lilac.sqlite
```

Mini Lilac transactionally migrates supported schema-v2 through schema-v7 databases to schema v8 at
startup. Fresh databases are created at the current schema. Unsupported versions and unrelated
experimental lineages are rejected.

## History Recovery

Mini Lilac automatically retries retained history navigation and pending run finalization recovery
when the server starts. A normal server restart is the retry mechanism; there is no separate recovery
retry command.

Inspect blocked recovery while the HTTP server is stopped:

```sh
mini-lilac history-recovery status
mini-lilac history-recovery status --workspace /path/to/workspace
mini-lilac history-recovery status --database ./data/mini-lilac.sqlite
mini-lilac history-recovery status --database ./data/mini-lilac.sqlite --workspace /path/to/workspace
```

Use `--database` whenever the server uses a nondefault SQLite path. `--workspace` filters by the exact
canonical workspace path stored in that database; the filter also works when that directory no longer
exists.

If automatic recovery cannot safely complete, inspect and copy the potentially partial worktree before
abandoning its retained navigation operation. Abandonment is an explicit last resort:

```sh
mini-lilac history-recovery abandon \
  --database ./data/mini-lilac.sqlite \
  --workspace /path/to/workspace \
  --acknowledge-partial-worktree
```

Abandonment records a replayable command error, leaves the history cursor and transcript at the
operation's source state, and deletes the retained navigation journal. It does not restore, verify, or
synchronize workspace files. The acknowledgement flag confirms that the operator accepts this partial
worktree risk. Pending run finalizations cannot be abandoned through this command.

Build the unified executable from `apps/mini-lilac`. Run `mini-lilac server --help` for serve and
auth usage.

`agent.titleModel` optionally selects a `provider/model` for generated session titles. The title
request includes attachments from the first prompt, so use a model that accepts the attachment
modalities your users submit. If generation is omitted or fails, Mini Lilac derives a title from
the first prompt's text, filename, or attachment type. Automatic and manual context compaction use
`agent.compaction.model` (`inherit` or a `provider/model`) and
`agent.compaction.earlyCompactionPoint` (default `0.8`, range `0.05`-`0.95`).

Each root and subagent run preloads workspace `AGENTS.md` files from its cwd upward through the Git
root. Local `read` calls also load previously unseen `AGENTS.md` files between the target and
the read cwd, so nested package rules enter context when the agent first reads inside that package.
Instruction blocks identify their absolute source path and are not re-added after appearing in the
system prompt or an earlier `read` result.

Provider model metadata can override discovered models.dev or `/v1/models` values under
`providers.<provider>.models.<model>`. Configured fields win while omitted fields keep their
catalog values. Supported patches include `name`, `family`, `attachment`, `reasoning`, `toolCall`,
`modalities`, partial `limit.context` / `limit.output` values, and `openaiServerCompaction`.
`openaiServerCompaction: true` is accepted only for `type: openai`; omitting it or setting `false`
disables it. These resolved limits are shared by the model list, token-usage display, and automatic
and manual compaction.

Profiles can expose the native `skill` tool explicitly or through `tools: ["*"]`. Mini Lilac only
discovers compatible `SKILL.md` bundles from workspace `.agents/skills`, user `~/.agents/skills`, and
`$XDG_STATE_HOME/mini-lilac/skills`. Enabled agents receive a bounded catalog of skill names and
descriptions. Calling `skill` with an exact name returns structural JSON containing the complete
bounded instructions, base directory, and a sampled relative resource listing; scripts are never
executed automatically. Skill loads are also available through `batch`; sibling action calls wait
for a later model turn so the loaded instructions are processed first. `@skills:<name>` in a user
prompt is an explicit instruction to load that skill before acting.

Profiles can also expose `webfetch` and `websearch`. `webfetch` retrieves bounded UTF-8 textual
content from public HTTP or HTTPS destinations, validates every redirect, and pins requests to a
validated public address while preserving HTTP Host and TLS server-name verification. It blocks
local, private, link-local, reserved, and metadata destinations; production deployments should
still deny private-network egress as defense in depth. `websearch`
uses the active OpenAI, Anthropic, or Codex model's native search capability and existing provider
credentials, returning a bounded answer and URL citations. Provider usage charges may apply. Both
tools can be used through `batch`, and all returned web content must be treated as untrusted data.
To preserve destination pinning, `webfetch` refuses to run when inherited `HTTP_PROXY`,
`HTTPS_PROXY`, or `ALL_PROXY` variables (including lowercase variants) are configured.

## API

- `GET /api/mini-lilac/healthz`
- `POST /api/mini-lilac/chat`
- `GET /api/mini-lilac/chat/:sessionId/stream`
- `GET /api/mini-lilac/sessions/:sessionId`
- `GET /api/mini-lilac/sessions/:sessionId/resume`
- `GET /api/mini-lilac/sessions?cwd=<directory>`
- `GET /api/mini-lilac/sessions/:sessionId/messages`
- `GET /api/mini-lilac/sessions/:sessionId/todos`
- `POST /api/mini-lilac/sessions/:sessionId/bindings`
- `POST /api/mini-lilac/sessions/:sessionId/steer`
- `POST /api/mini-lilac/sessions/:sessionId/interrupt-queued-steering`
- `POST /api/mini-lilac/sessions/:sessionId/cancel`
- `POST /api/mini-lilac/sessions/:sessionId/undo`
- `POST /api/mini-lilac/sessions/:sessionId/redo`
- `POST /api/mini-lilac/sessions/:sessionId/compact`
- `POST /api/mini-lilac/sessions/:sessionId/compact/cancel`
- `GET /api/mini-lilac/models`
- `POST /api/mini-lilac/models/refresh`
- `GET /api/mini-lilac/profiles`
- `GET /api/mini-lilac/skills?cwd=<directory>&profile=<profile>`

Chat and reconnect endpoints return the AI SDK UI message SSE protocol. A network disconnect only
removes that stream subscriber; use the cancel endpoint to cancel a run explicitly. Reconnect with
`?runId=<run>&after=<sequence>` to resume that exact run after the latest received
`data-streamCursor` sequence. The resume endpoint returns a chronological message prefix and its
matching run cursor atomically for active sessions. Active chunks and cursors exist only in the
owning session actor; they are replayable after a network disconnect while that process and run are
active, but are not retained after durable finalization or a process crash. If both finalization
attempts fail, the actor can retain terminal replay in memory while durable state awaits recovery.
A crash marks active runs as errors. Completed runs return `204`; canonical model and UI transcripts are stored as shared,
immutable SQLite chains at durable boundaries. Active SSE responses emit comment keepalives while
quiet so long-running deferred subagents do not lose their parent connection to intermediary idle
timeouts.

Subagents are ordinary sessions. `subagent_delegate` returns a stable `sessionName`; reusing it from
the same parent session continues that child session with its canonical model transcript. Explicit
model and effort selections become that named session's new defaults. Distinct child sessions have
no sibling-count or concurrency cap; by default, depth permits `Primary -> Subagent` only. Child
transcripts use the normal session message and active-stream endpoints. For `claude-code`, native
continuation is enabled for both caller-supplied names and automatically generated names returned by
the first delegation.

This distinction also applies to AI SDK's generic `AbstractChat` state machine and framework hooks:
`stop()` or another generic client abort detaches the current response stream but does not
server-cancel the run. To terminate generation, call the explicit `MiniLilacTransport.cancel`
extension with the session's active run ID. This intentional disconnect-vs-cancel behavior allows a
detached client to consume the live tail later and reconcile from canonical messages after
completion. Regeneration is not part of the Mini
Lilac protocol and is intentionally unsupported.

Control request bodies include both `sessionId` and the snapshot's non-null `activeRunId` as
`runId`; stale controls are rejected rather than applied to a newer run.

The todos endpoint returns the session's durable todo state. Todo changes are model-owned through
the `todowrite` tool; the HTTP API intentionally has no todo write endpoint.

Session bindings can be changed while a session is quiescent with a strict request such as
`{ "sessionId": "...", "clientCommandId": "...", "model": "provider/model", "profile": "coding", "reasoning": "high" }`.
At least one of `model`, `profile`, or `reasoning` is required. The command is serialized with chat
admission, atomically persisted, and idempotent by `clientCommandId`; reusing an ID with a different
payload is rejected. Active sessions cannot be updated, profiles must exist and support top-level
sessions, and models must resolve through the configured provider registry. The response is the
updated session snapshot; cwd and session identity are unchanged.

Undo and redo are quiescent-session commands. Both accept the strict body
`{ "sessionId": "...", "clientCommandId": "..." }`; idle and error sessions are eligible only when
they have no active actor or run. Undo restores the exact durable model/UI transcript and managed
worktree state from before the latest applied user message. A successful strict response is:

```json
{
  "status": "undone",
  "clientCommandId": "undo-1",
  "message": {
    "id": "user-1",
    "role": "user",
    "parts": [{ "type": "text", "text": "change the greeting" }]
  },
  "historyStateId": "history-before-user-1",
  "filesystem": { "status": "restored" }
}
```

Redo restores the exact state saved by the corresponding undo, including managed edits observed
immediately before undo. It restores retained transcript and snapshot data; it never reruns the model,
tools, patches, or commands. A successful strict response is:

```json
{
  "status": "redone",
  "clientCommandId": "redo-1",
  "message": {
    "id": "user-1",
    "role": "user",
    "parts": [{ "type": "text", "text": "change the greeting" }]
  },
  "historyStateId": "history-after-user-1",
  "filesystem": { "status": "skipped", "reason": "snapshot-unavailable" }
}
```

`filesystem.status = "restored"` means the target managed worktree was restored and verified.
`filesystem.status = "skipped"` means transcript history moved but the worktree was left unchanged:

- `git-unavailable`: the Git executable needed by the private snapshot store was unavailable.
- `non-git-workspace`: filesystem history is disabled because the session directory is outside a Git
  worktree.
- `snapshot-unavailable`: the target has no usable snapshot, including legacy, failed, missing, or
  corrupt captures.
- `platform-unsupported`: native filesystem history is unavailable on the current platform.

Undo returns `{ "status": "empty", "clientCommandId": "..." }` when no applied user transition
exists above the undo floor. Redo returns the same empty shape when its navigation stack is empty.
Empty results do not move transcripts or capture a workspace state. Successful and empty outcomes are
persisted by `clientCommandId`; retrying the same request returns the original result without another
capture or restore. Both endpoints return HTTP 200 for these outcomes.
