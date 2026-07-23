# mini-lilac-tui

A restrained OpenTUI client for **mini-lilac**. It talks to a
mini-lilac server through [`@stanley2058/mini-lilac-client`](../../packages/mini-lilac-client)
and renders the AI SDK UI message stream with `@opentui/core`, `@opentui/solid`,
and Solid.

The controller remains independent of the terminal renderer. A small, pure input
state machine defines prompt, steer, interrupt, cancel, and exit semantics while
OpenTUI owns terminal input, focus, paste handling, layout, and renderer cleanup.

## Install / run

```sh
# from the repo root
bun install

# develop the TUI directly
cd apps/mini-lilac-tui
bun run start -- --server http://127.0.0.1:8090/api/mini-lilac --token "$TOKEN"

# build the installable unified command
cd ../mini-lilac
bun run build
./dist/main.js --help
./dist/main.js tui --help
```

## CLI options

| Option        | Default                                    | Notes                                             |
| ------------- | ------------------------------------------ | ------------------------------------------------- |
| `--server`    | `http://127.0.0.1:8090/api/mini-lilac`     | Mini-lilac API base URL.                          |
| `--token`     | `MINI_LILAC_TOKEN` / `TOKEN` env           | Bearer token.                                     |
| `--model`     | last server choice / initial preflight     | Model id in `provider/model` form.                |
| `--profile`   | last server choice / server default        | Agent profile id.                                 |
| `--session`   | new random UUID                            | Resume/continue an existing session id.           |
| `--reasoning` | provider default                           | One of the client reasoning levels.               |
| `-h, --help`  |                                            | Show help.                                        |

`cwd` is always `process.cwd()` canonicalized with `realpath` and sent by the
transport with every request. The program requires TTY stdin and stdout; piped
input/output is rejected.

On startup the client fetches the live model and profile catalogs. Profiles
marked `subagentOnly` are filtered out. The last model/profile/reasoning used
with each server are stored under `$XDG_STATE_HOME/mini-lilac` (or
`~/.local/state/mini-lilac`) and reused by fresh sessions. Explicit CLI options
take precedence. Only a first-ever missing model opens numbered preflight;
an omitted profile and reasoning use server defaults and are recorded once the
session reports its resolved bindings.

With `--session`, the session snapshot and canonical messages are loaded before
selection. Its stored cwd must match the current canonical cwd. Stored
model/profile/reasoning bindings (including unbound `null` values) are
authoritative even when no longer present in the live catalogs, preventing a
resumed session from acquiring fresh bindings.
Streaming or cancelling sessions reconnect immediately.

## Keyboard model

The interactive behavior is defined by a pure reducer in
[`src/input-state.ts`](./src/input-state.ts):

| Context                                        | Key      | Behavior                                                                 |
| ---------------------------------------------- | -------- | ------------------------------------------------------------------------ |
| Idle, dirty editor                             | `Enter`  | Send a prompt via `sendMessages`.                                        |
| Submitting                                     | `Enter`  | No-op; the in-flight prompt owns admission.                              |
| Active, dirty editor                           | `Enter`  | Queue a steer via `steer` (multiple submits serialize onto the queue).   |
| Active, empty editor, steering queued/pending  | `Enter`  | After admissions complete, call `interruptQueuedSteering`.               |
| Active                                         | `Esc`    | Explicit `cancel` (not merely an abort); clear editor + queued display, keep the process alive. |
| Disconnected                                   | `Esc`    | Explicit server `cancel`; disconnected state never behaves as idle.     |
| Read-only subagent transcript                  | `Esc`    | Return to the parent transcript.                                        |
| Read-only subagent transcript                  | `PageUp` / `PageDown` | Scroll the child transcript.                              |
| Idle                                           | `Esc`    | No-op.                                                                    |
| Any                                            | `Ctrl-C` | Clear the draft; press again with an empty editor to exit.                 |

`Shift+Enter` inserts a newline in terminals that report modified Enter keys.
OpenTUI is configured with Kitty keyboard support where available. The composer
is a fixed multiline textarea and remains focused while output streams.

## Rendering

[`src/render.ts`](./src/render.ts) maps standard AI SDK chunks to a plain semantic
transcript model: text, reasoning (a collapsed indicator), tools/results, errors, plus
mini-lilac data parts (`session`, `control`, `transcriptReset`, `subagentStatus`),
which are validated with the client's Zod schema at the boundary.

Fenced code blocks use Tree-sitter syntax highlighting. JavaScript, TypeScript,
Markdown, and Zig use OpenTUI's bundled parsers; Python, Bash, JSON, YAML, Rust,
and Go parsers are downloaded and cached by OpenTUI on first use. Unknown or
untagged languages render with the neutral code style.

Startup `initialMessages` are mapped into that model before reconnecting, so a
resumed session displays its canonical transcript immediately. Stream deltas
update the same model without ANSI strings or direct terminal writes.

A transcript reset removes the live tail, displays a rewind marker, and replaces
the model with canonical messages after completion reconciliation.

On completion the client fetches the canonical messages (and reconciles transcript
resets), preserving the session id for continued prompts. Transport disconnects
retry `reconnectToStream` with capped exponential backoff for the lifetime of the
active run; a disconnect alone never cancels the run or returns the editor to idle.

`/new` starts an empty session in the current working directory while preserving
the active profile, model, and reasoning effort.
`/todo` opens a read-only view of the session's complete durable todo list.

Each `subagent_delegate` call renders as one self-updating task block rather than separate call and
result rows. The block tracks its stable `sessionName`, running activity, tool-call count, and
terminal state. Reusing the name continues the same ordinary child session. Clicking a block opens
that session's canonical transcript and active stream in the normal transcript renderer with the
composer removed; `Esc` returns to the parent session.

The one-line header shows the live session title and, when both values are
available, compact input-token and context-usage figures. `/compact` is available
from the command palette or as an attachment-free idle command. Successful manual
and automatic compactions add durable transcript dividers; no-op compactions stay quiet.
`/session` opens a searchable list of previous sessions from the current working directory.
`/skills` opens a searchable server-backed catalog for the current cwd and profile. Selecting a
skill inserts a durable `@skills:<name>` token into the composer without submitting it; the agent is
instructed to load that exact skill through its native `skill` tool before acting.

## Modules

- `src/input-state.ts` — pure keyboard state reducer (fully unit-tested).
- `src/startup.ts` — fresh/resumed session binding and transcript resolution.
- `src/preflight.ts` — model/profile catalog selection.
- `src/render.ts` — canonical-message and stream-chunk transcript mapping.
- `src/controller.ts` — transport/session lifecycle behind a typed UI sink.
- `src/app.tsx` — responsive OpenTUI transcript and multiline composer.
- `src/main.tsx` — CLI and renderer lifecycle entry point.

## Tests

```sh
cd apps/mini-lilac-tui
bun test
bunx tsc -p tsconfig.json --noEmit
```
