# Lilac Monorepo (Fork)

This repository tracks upstream:

| Item | Value |
| --- | --- |
| Upstream repo | https://github.com/stanley2058/lilac-mono |
| Upstream README | https://github.com/stanley2058/lilac-mono/blob/main/README.md |

## Fork Policy

- `main` is kept as close to `upstream/main` as possible.
- Fork-only behavior should be explicitly documented and, when possible, guarded by feature flags (default off).
- Upstream-accepted work is listed separately and marked **PR ACCEPTED**.

## Current Fork-Only Differences

These are the intentional differences between this fork `main` and `upstream/main`.

| Area | Files | Difference | Why |
| --- | --- | --- | --- |
| CI (fork ops) | `.github/workflows/sync-upstream.yml` | Adds scheduled/manual upstream sync workflow for this fork. | Keep fork branch current with upstream automatically. |
| CI (image publish) | `.github/workflows/build-image.yml` | Adds Docker image build/push workflow for this fork registry flow. | Keep fork-specific container image pipeline. |
| Container image variants | `Dockerfile`, `.github/workflows/build-image.yml` | CI workflow directly defines variant build args for runtime identity and publishes tags (`catalinna`, `claudia`). | Keep upstream defaults while producing fork-specific image variants. |
| Empty-reply guardrail (default off) | `packages/utils/env.ts`, `.env.example`, `apps/core/src/surface/bridge/bus-agent-runner.ts` | Adds feature flag `LILAC_SKIP_EMPTY_REASONING_REPLY`; when enabled, reasoning-only + empty final reply is skipped with diagnostics instead of posting empty placeholder text. | Keep upstream default behavior by default, but allow operational mitigation when needed. |
| Fork documentation | `README.md` | Documents only fork-specific deltas and upstream acceptance status. | Make review/audit of fork changes explicit. |

### Feature Flag: `LILAC_SKIP_EMPTY_REASONING_REPLY`

- Default: **disabled** (upstream behavior preserved).
- Enable with:

```bash
LILAC_SKIP_EMPTY_REASONING_REPLY=true
```

- Intended effect when enabled:
  - If a run ends with empty final text and reasoning-only assistant output, the bridge skips emitting a user-facing empty reply.
  - Adds structured warning logs to support debugging/review.

## Upstream-Accepted Contributions From This Fork (PR ACCEPTED)

These changes were first developed from this fork and are now merged into upstream.

| Status | PR | Title | Merged At |
| --- | --- | --- | --- |
| PR ACCEPTED | https://github.com/stanley2058/lilac-mono/pull/1 | `feat(core): add Exa web search provider` | 2026-02-19 |
| PR ACCEPTED | https://github.com/stanley2058/lilac-mono/pull/4 | `add support for custom Tavily API endpoint.` | 2026-02-20 |
| PR ACCEPTED | https://github.com/stanley2058/lilac-mono/pull/5 | `Cleaning up for #4` | 2026-02-21 |

## Quick Validation Commands

Use these commands to verify divergence and branch state:

```bash
git diff --name-status upstream/main..main
git log --oneline --decorate main..upstream/main
git log --oneline --decorate upstream/main..main
```
