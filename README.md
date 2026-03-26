# Lilac Monorepo — DF Fork

<p align="center">
  <strong>An event-driven agent runtime monorepo for Discord, GitHub, layered tools, and long-lived workflows — maintained as a fast-moving fork that stays intentionally close to upstream.</strong>
</p>

<p align="center">
  <a href="https://github.com/DF-wu/lilac-mono">Fork</a>
  ·
  <a href="https://github.com/stanley2058/lilac-mono">Upstream</a>
  ·
  <a href="./PROJECT.md">Architecture</a>
  ·
  <a href="./AGENTS.md">Agent Guide</a>
</p>

---

## What this repository is

This repository is the **DF fork of `lilac-mono`**, a Bun-workspace monorepo for running an AI agent system across multiple surfaces and tool layers. At its core, Lilac combines a typed Redis Streams event bus, Discord and GitHub ingress, an AI SDK-based agent runner, a tool server and CLI bridge, skill loading, and durable workflow resumption.

This fork exists to support **deployment, operations, experimentation, and upstream contribution** without drifting far from the main project line. The goal is simple: keep `main` easy to sync with `upstream/main`, keep fork-only changes explicit, and upstream useful improvements whenever possible.

## Status at a glance

| Item | Value |
| --- | --- |
| Fork repository | `DF-wu/lilac-mono` |
| Upstream repository | `stanley2058/lilac-mono` |
| Monorepo toolchain | Bun workspaces |
| Primary runtime shape | Event-driven agent runtime |
| Main surfaces | Discord, optional GitHub ingress |
| Fork strategy | Stay close to upstream, isolate fork-only behavior |
| Reference architecture doc | [`PROJECT.md`](./PROJECT.md) |

## What Lilac does

Lilac is built around a request-scoped agent loop:

1. surface events enter through Discord or GitHub,
2. the router turns them into request messages,
3. the agent runner executes with local tools,
4. output is streamed back through relays,
5. workflows can pause and resume work later.

That runtime is backed by three progressively richer capability layers:

- **Level 1:** direct agent-local tools such as `bash`, file access, patching, and batching.
- **Level 2:** an HTTP tool server exposed through the `tools` CLI.
- **Level 3:** on-disk skill bundles loaded on demand.

The result is a repo that is part runtime, part tooling platform, and part operator workspace for agent-centric workflows.

## How this fork differs from upstream

This README is about the **state of this repository**, not just the upstream project. The current fork-specific deltas are intentionally narrow and operationally focused.

| Area | Files | Fork-specific behavior | Why it exists |
| --- | --- | --- | --- |
| Upstream sync automation | `.github/workflows/sync-upstream.yml` | Adds scheduled and manual sync workflow support for this fork. | Keep `main` close to `upstream/main` with less manual maintenance. |
| Container publishing | `.github/workflows/build-image.yml` | Adds fork-owned image build and publish automation. | Preserve a deployment pipeline owned by this fork. |
| Runtime image variants | `Dockerfile`, `.github/workflows/build-image.yml` | Publishes fork-specific image variants such as `catalinna` and `claudia`, with `latest` aligned to `catalinna`. | Support DF-specific runtime identities without changing the upstream baseline. |
| ACP controller behavior | `apps/acp-controller/controller.ts` | Includes fork-side controller changes present in the current branch diff versus upstream. | Support local automation and harness-management needs in this fork. |

### Fork policy

This fork follows three rules:

- keep `main` syncable with upstream,
- prefer config flags over permanent divergence,
- upstream reusable improvements instead of carrying them forever downstream.

## Upstream contribution status

This fork is not only a downstream deployment branch. It is also used as a staging ground for changes that later land upstream.

### Merged upstream pull requests

| Upstream PR | Title | Merged |
| --- | --- | --- |
| [#1](https://github.com/stanley2058/lilac-mono/pull/1) | `feat(core): add Exa web search provider` | 2026-02-19 |
| [#4](https://github.com/stanley2058/lilac-mono/pull/4) | `add support for custom Tavily API endpoint.` | 2026-02-20 |
| [#5](https://github.com/stanley2058/lilac-mono/pull/5) | `Cleaning up for #4` | 2026-02-21 |

No open pull requests from `DF-wu/lilac-mono` to `stanley2058/lilac-mono` were found at the time of review.

### Current branch relationship

Based on the current local fork state:

- `origin` points to `DF-wu/lilac-mono`
- `upstream` points to `stanley2058/lilac-mono`
- `main` is actively merged with `upstream/main`
- the current diff versus upstream is small and concentrated in fork operations, image publishing, README state, and ACP-controller behavior

Useful commands:

```bash
git diff --name-status upstream/main..main
git diff --stat upstream/main..main
git log --oneline --decorate upstream/main..main
git log --oneline --decorate main..upstream/main
```

## Monorepo map

### Apps

| Path | Purpose |
| --- | --- |
| `apps/core` | Core runtime: surfaces, router, agent runner, workflow service, tool server, recovery services. |
| `apps/tool-bridge` | Builds and serves the `tools` CLI bridge used to call Lilac's tool server. |
| `apps/acp-controller` | `lilac-acp` CLI for ACP harness control in local and automation workflows. |

### Packages

| Path | Purpose |
| --- | --- |
| `packages/event-bus` | Typed event contract and Redis Streams bus implementation. |
| `packages/agent` | AI SDK-based agent execution and queueing behavior. |
| `packages/utils` | Shared config, prompt, provider, env, and skill-loading utilities. |
| `packages/plugin-runtime` | Shared plugin contract/runtime for tool exposure. |

### Supporting directories

| Path | Purpose |
| --- | --- |
| `data` | Local runtime state, prompts, databases, and seeded config. |
| `ref` | Vendored/reference repositories, treated as read-only. |
| `__tests__` | Workspace-level test harness. |

## Working with this repo

Use Bun throughout the monorepo.

```bash
bun test
bun run lint
bun run typecheck
bun run fmt:check
```

Package-level commands used most often:

```bash
cd apps/core && bun run build:remote-runner
cd apps/tool-bridge && bun run build
cd apps/acp-controller && bun run build
```

For architecture, terminology, and system wiring, start with [`PROJECT.md`](./PROJECT.md). For repository-specific agent workflow and validation rules, see [`AGENTS.md`](./AGENTS.md).

## License

This repository is licensed under MIT. See [`LICENSE`](./LICENSE) for details.

The `ref/` directory contains vendored or reference material that retains its own upstream license terms.
