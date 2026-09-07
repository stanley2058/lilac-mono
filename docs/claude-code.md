# Claude Code Provider

This reference describes the Claude Code provider used by Core.

## Authentication Ownership

The `claude-code` provider uses the official Claude runtime. Lilac does not perform Claude login and
does not read, store, refresh, or revoke Claude credentials. The operator must provide authentication
through an existing authenticated Claude configuration, `claude auth login`,
`CLAUDE_CODE_OAUTH_TOKEN`, or platform secure storage supported by Claude.

Core passes Claude authentication directly to the runtime rather than loading it through Lilac's
normal provider-key configuration.

## Core Model Selection

Authentication alone does not select the `claude-code` provider. In Core's
`${DATA_DIR}/core-config.yaml`, select a `claude-code/<model>` reference in a model slot, alias, or
profile. For example:

```yaml
configVersion: 2
models:
  main:
    model: claude-code/claude-sonnet-4-6
```

Then provide Claude authentication using one of the methods above. See the self-documenting
[`core-config.example.yaml`](../packages/utils/config-templates/core-config.example.yaml) for the
complete current configuration.

## Executable Resolution

Core prefers an official `claude` executable found on `PATH`. When none is found, it leaves
resolution to the Claude Agent SDK so its own fallback and diagnostics remain intact.

The deployment artifact determines whether that SDK fallback can succeed:

- Core's Docker image includes the SDK dependency tree and can resolve the SDK-bundled executable.
- Source-based local runs may use either an external executable or an SDK-bundled executable that is
  present in that installation.

## Native Continuation

Every continuation-capable Claude agent attempt uses a persisted native candidate, but native
continuation is admitted only from exact Lilac-owned proof.

- A fresh attempt sends Lilac's complete canonical history to a new persisted Claude session.
- An exact continuation resumes the last clean native session as a fork and sends only the canonical
  suffix. The source session is retained and never advanced in place.
- The fork receives a distinct candidate session ID. Native session IDs are internal operational data,
  not part of Core's user-facing protocol.
- Missing, changed, compacted, incompatible, or unverifiable native state does not receive a best-effort
  resume. It starts fresh from canonical history instead.

The cwd, execution scope, Claude storage namespace, and continuation metadata must remain compatible.
A failed attempt is not a clean continuation head.

### Eligibility

- Core named subagents are eligible when delegation supplied a stable continuation identity and the
  marked request-client/session transcript has the exact canonical message count and hash.
- Core primary sessions are eligible only on Discord. The binding must identify a retained terminal
  request with an exact clean transcript and lineage manifest, and the current lineage must be an exact
  complete-segment extension of that ordered prefix.

Core primary requests on other surfaces are not eligible for native continuation. A failed eligibility
check changes only the start mode to fresh; it does not discard Lilac's canonical conversation history.

## Cross-Family Model Changes

An explicit model selection may cross between `claude-code` and the AI SDK provider family only at a
new-turn boundary.

Cross-family history is replayed as deliberately lossy text. It preserves visible conversation text and
bounded, labeled historical tool facts. It does not preserve hidden reasoning, provider metadata, binary
history, or historical executable tool protocol. A history containing cross-family turns is not exact
native-continuation proof.

Automatic fallback never performs this conversion. Core automatic fallback stays within the AI SDK
provider family: it skips `claude-code` fallback candidates, and a run whose head model is
`claude-code` has automatic fallback disabled.

## Storage, Retention, And Security

Claude stores authentication/configuration and native transcripts under `CLAUDE_CONFIG_DIR`, or
`~/.claude` when the variable is unset. An explicit `CLAUDE_CONFIG_DIR` must be a non-empty absolute
writable path. Persistently mount it when continuation must survive container replacement.

Native transcripts contain conversation data outside Core's transcript database. Exact continuations
retain their source and create forks, so fork-heavy native history can grow roughly quadratically with
conversation length. Lilac bounds its attempt metadata but
does not delete Claude's native transcript files. Core primary and named owners keep one current binding.

Retention and deletion of native files are operator responsibilities and otherwise follow Claude's own
policy. A dedicated directory provides storage organization and independent retention, not an
access-control or privacy boundary. Claude credentials and transcripts remain accessible to processes
with the same service-user authority; use a separate UID, container, or OS boundary when agent-executed
code must not access them.

For deployment-specific setup, see [Docker Deployment](docker-deployment.md).
