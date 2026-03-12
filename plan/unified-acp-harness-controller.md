# Unified ACP Harness Controller

## Summary
- Repurpose [apps/acp-controller](/home/stanley/Sandbox/lilac-mcp/lilac-mono/apps/acp-controller) into a harness-agnostic ACP controller and make ACP the only transport.
- Ship a single CLI surface: `lilac-acp`.
- Core goal: one controller surface for OpenCode first, with built-in discovery for other ACP harnesses such as Codex/Cursor/Claude wrappers as their launch contracts are verified from the ACP Registry.
- Preserve the current detached async contract by spawning a per-run background worker, not by polling a vendor SDK server.

## Product Behavior
- `sessions list --search <term>` searches all discovered harnesses by default and returns merged results with `harnessId`, `sessionId`, `title`, `cwd`, `updatedAt`, `capabilities`.
- `--session-id` becomes a canonical controller session ref: `<harnessId>::<remoteSessionId>`.
- `prompt submit --title <title>` behavior:
  - with `--harness`: search only that harness; continue exact match or create new there.
  - without `--harness`: continue only if there is exactly one exact match across all harnesses; if multiple or none, return an ambiguity/error payload with candidates.
- `--latest` requires `--harness` to avoid silently choosing the wrong harness.
- `sessions snapshot` becomes best-effort and generic:
  - canonical field: `plan`;
  - optional legacy `todo` only when a harness exposes OpenCode-style data.
- All run/status/result payloads add `harnessId` and `sessionRef`.

## Built-In Harness Registry
- No user config file in v1.
- Ship a built-in harness registry derived from ACP Registry metadata and hardcoded discovery rules:
  - `opencode`: `opencode acp`
  - `codex-acp`: prefer `codex-acp`, fallback `npx @zed-industries/codex-acp`
  - `claude-acp`: `npx @zed-industries/claude-agent-acp`
  - `cursor`: `cursor-agent acp` when present
- Discovery order:
  1. explicit `--harness`
  2. PATH / known command probe
  3. built-in `npx` fallback when defined
- If a harness is known but not launchable, return install/launch hints from built-in registry metadata; do not auto-install in v1.

## Architecture
- Keep the workspace folder initially, but replace the OpenCode SDK-specific internals with:
  - `HarnessDescriptor`: launch command, args, env passthrough policy, search support expectations.
  - `AcpHarnessClient`: wraps `ClientSideConnection`, initialize/load/list/prompt/cancel/stream updates.
  - `RunStore`: file-backed state under `~/.local/state/lilac-acp-controller/runs`.
  - `SessionIndex`: cached merged search results under `~/.local/state/lilac-acp-controller/sessions`.
  - `PermissionPolicy`: auto-approve/auto-reject rules applied uniformly to ACP permission requests.
  - hidden worker entrypoint: `lilac-acp _worker run --run-id <id>`.
- `prompt submit` flow:
  1. resolve harness + session target
  2. create run file
  3. spawn detached worker
  4. worker opens ACP connection, creates/loads session, streams updates, persists state, exits on completion
- `status/result/wait` read the run file; `wait` polls file changes.
- Add `prompt cancel --run-id <id>`; it signals the worker, which sends ACP cancellation before exiting.

## Public Interface Changes
- New command: `harnesses list`
- New flag: `--harness <id|any>`
- New flag: `--output <json|human>`
- New canonical IDs:
  - `sessionRef = <harnessId>::<remoteSessionId>`
  - `run` records include `workerPid`
- Output changes:
  - JSON remains the default for automation
  - human-readable output is available with `--output human`
  - all session/search/run outputs include `harnessId`
  - `snapshot.plan` is the generic field

## Tests And Scenarios
- Cross-harness search merges OpenCode/Codex/Cursor/Claude results and preserves source harness metadata.
- `prompt submit --title` without `--harness` errors on ambiguous exact matches and succeeds on unique exact matches.
- Detached worker lifecycle: submit -> running -> completed/failed/cancelled persists correctly across caller exit.
- Permission auto-replies and question rejection behave the same for every ACP harness.
- `status/result/wait` work from persisted run files without a vendor server.
- `sessions snapshot` returns generic plan/history when available and a capability error when not.

## Assumptions And Defaults
- OpenCode-specific SDK polling and server bootstrapping are removed.
- Search is cross-harness by default; mutation is conservative by default.
- v1 is built-in-registry only; no user-managed harness config file.
- OpenCode is the first fully verified harness; Codex/Cursor/Claude launch paths use ACP Registry-backed built-ins and are enabled only where the descriptor is validated on the current OS.

## Sources
- Current controller: [apps/acp-controller/client.ts](/home/stanley/Sandbox/lilac-mcp/lilac-mono/apps/acp-controller/client.ts), [apps/acp-controller/README.md](/home/stanley/Sandbox/lilac-mcp/lilac-mono/apps/acp-controller/README.md)
- ACP SDK/docs: https://agentclientprotocol.com/libraries/typescript , https://agentclientprotocol.github.io/typescript-sdk/classes/ClientSideConnection.html
- ACP protocol: https://agentclientprotocol.com/protocol/session-setup , https://agentclientprotocol.com/protocol/prompt-turn , https://agentclientprotocol.com/protocol/tool-calls
- ACP Registry: https://agentclientprotocol.com/get-started/registry , https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json
- Ecosystem update: https://zed.dev/blog/acp-registry
- OpenCode ACP support: [ref/opencode/packages/web/src/content/docs/acp.mdx](/home/stanley/Sandbox/lilac-mcp/lilac-mono/ref/opencode/packages/web/src/content/docs/acp.mdx), [ref/opencode/packages/opencode/src/acp/agent.ts](/home/stanley/Sandbox/lilac-mcp/lilac-mono/ref/opencode/packages/opencode/src/acp/agent.ts)
