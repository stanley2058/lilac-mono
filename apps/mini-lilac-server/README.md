# Mini Lilac Server

An Elysia HTTP server for `@stanley2058/mini-lilac-runtime`. Its API is mounted at
`/api/mini-lilac`, matching the default `MiniLilacTransport` base URL.

## Configure

Mini Lilac centralizes persistent server state under `$XDG_STATE_HOME/mini-lilac` (falling back to
`~/.local/state/mini-lilac`). Copy the example files there and restrict the auth file before
starting. The three-file configuration remains strict even when OAuth supplies OpenAI
authentication, so `auth.json` must exist and may contain `{}`:

```sh
state_dir="${XDG_STATE_HOME:-$HOME/.local/state}/mini-lilac"
mkdir -p "$state_dir"
cp config.example.yaml "$state_dir/config.yaml"
cp providers.example.yaml "$state_dir/providers.yaml"
cp auth.example.json "$state_dir/auth.json"
chmod 600 "$state_dir/auth.json"
```

The server caches the validated models.dev registry at `models-dev.json` in this state directory.
Startup uses the cache immediately and refreshes it in the background; a cold cache never prevents
the HTTP server from listening.

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
mini-lilac-server auth codex
mini-lilac-server auth codex --status
```

The command prints the authorize URL and stores owner-private Lilac tokens at
`$XDG_STATE_HOME/mini-lilac/codex.json` (the exact path is printed). A direct `type: openai`
provider without a custom `baseUrl` then uses the hardened ChatGPT Codex backend while models retain the
`openai/<model>` namespace. Its catalog must be `models-dev` because `/v1/models` requires OpenAI
API-key authentication. For OAuth-superseded providers, the catalog includes GPT-5 minor generation
3 or newer models only when models.dev marks them as reasoning- and tool-capable, with text input
and text-only output. This keeps conversational Codex models while excluding embeddings, image,
audio, realtime, and older model families. Remove the tokens with
`mini-lilac-server auth codex --logout`.

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

`workspaceWrites: false` also disables Bash because Bash is trusted, unrestricted process
execution and can write outside filesystem-tool guardrails. This runtime does not provide a
sandbox. Filesystem tools deny the configured provider/auth files and common credential paths;
Bash receives an environment with the HTTP auth-token variable removed.

## Run

```sh
bun run src/main.ts
```

The server defaults to `$XDG_STATE_HOME/mini-lilac/config.yaml`; `--config` can still select another
file. SQLite defaults to `$XDG_STATE_HOME/mini-lilac/mini-lilac.sqlite`. Override either path when
needed:

```sh
bun run src/main.ts --config ./config.yaml --database ./data/mini-lilac.sqlite
```

This port starts a new persistence lineage. Databases created by the experimental
`expr/lilac-coding-agent` branch are not migrated; select a fresh database path before starting.

Build the executable entrypoint with `bun run build`, then run `./dist/index.js`. Run
`mini-lilac-server --help` for serve and auth usage.

`agent.titleModel` optionally selects a `provider/model` for generated session titles. If omitted,
the title is the normalized first 50 characters of the first prompt. Automatic and manual context
compaction use `agent.compaction.model` (`inherit` or a `provider/model`) and
`agent.compaction.earlyCompactionPoint` (default `0.8`, range `0.05`-`0.95`).

Provider model metadata can override discovered models.dev or `/v1/models` values under
`providers.<provider>.models.<model>`. Configured fields win while omitted fields keep their
catalog values. Supported patches include `name`, `family`, `attachment`, `reasoning`, `toolCall`,
`modalities`, and partial `limit.context` / `limit.output` values. These resolved limits are shared
by the model list, token-usage display, and automatic and manual compaction.

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
- `POST /api/mini-lilac/sessions/:sessionId/compact`
- `GET /api/mini-lilac/models`
- `POST /api/mini-lilac/models/refresh`
- `GET /api/mini-lilac/profiles`
- `GET /api/mini-lilac/skills?cwd=<directory>&profile=<profile>`

Chat and reconnect endpoints return the AI SDK UI message SSE protocol. A network disconnect only
removes that stream subscriber; use the cancel endpoint to cancel a run explicitly. Reconnect with
`?runId=<run>&after=<sequence>` to resume that exact run after the latest received
`data-streamCursor` sequence. The resume endpoint returns a chronological message prefix and its
matching run cursor atomically for active sessions. Completed
runs return `204`; their canonical model and UI transcripts are stored on the session and finalized
run chunks are removed. Active SSE responses emit comment keepalives while quiet so long-running
deferred subagents do not lose their parent connection to intermediary idle timeouts.

Subagents are ordinary sessions. `subagent_delegate` returns a stable `sessionName`; reusing it from
the same parent session continues that child session with its canonical model transcript. Child
transcripts use the normal session message and active-stream endpoints.

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

Undo is a quiescent-session command with body
`{ "sessionId": "...", "clientCommandId": "..." }`. Idle and error sessions are eligible only when
they have no active actor or run. Undo atomically restores the exact durable model and UI transcript
prefixes from before the latest user message. The strict result is either
`{ "status": "undone", "clientCommandId": "...", "message": { ... } }` or, when no user message
exists, `{ "status": "empty", "clientCommandId": "..." }` with HTTP 200 and no transcript change.
Both results are persisted atomically; retry the same command ID to receive the same result. Legacy
checkpoints without an exact UI prefix still fail safely when a latest user message exists.
