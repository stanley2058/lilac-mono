# Lilac Monorepo (Fork)

This repository is a fork of the upstream project.

| Upstream | https://github.com/stanley2058/lilac-mono |
| --- | --- |
| Upstream README | https://github.com/stanley2058/lilac-mono/blob/main/README.md |

This README focuses on what differs in this fork and how to configure it.

## Fork features

| Area | What this fork adds/changes | Where |
| --- | --- | --- |
| CI | Scheduled upstream sync (auto-merge `upstream/main` into `main`) and triggers image build on updates | `.github/workflows/sync-upstream.yml` |
| CI | Build & push Docker image to GHCR on `main` pushes | `.github/workflows/build-image.yml` |
| Docker | Container default user/uid and workspace env var name differ from upstream | `Dockerfile` |
| Tools | `tools search` backend is configurable: Tavily (default) or Exa (via `exa-js`, supports Exa-compatible proxies like exa-pool) | `apps/core/src/tool-server/tools/web.ts`, `apps/core/src/tool-server/tools/web-search.ts` |

## Quick start (fork)

1. Copy `.env.example` to `.env` and set required values.
2. Configure `data/core-config.yaml` (auto-seeded on first run; see `packages/utils/core-config.ts`).
3. Run one of these:

- Docker dev (includes Redis): `docker compose up --build`
- Tool server only (dev): `bun apps/tool-bridge/index.ts`

## Configuration

There are two config surfaces:

- `core-config.yaml`: runtime behavior (non-secret). Default path is `data/core-config.yaml` (controlled by `DATA_DIR`).
- Environment variables: secrets (API keys) and endpoint overrides.

## Web search provider

This fork keeps the upstream `tools search` input/output contract but allows swapping the search backend.

### Configure provider (env)

```bash
# Optional. Default: tavily.
# Supported: tavily | exa
# Any other value falls back to tavily.
WEB_SEARCH_PROVIDER=tavily
```

### Configure credentials + endpoints (env)

```bash
# Required when provider=tavily
TAVILY_API_KEY=...

# Required when provider=exa
EXA_API_KEY=...

# Optional: Exa base URL override.
# If omitted, exa-js defaults to https://api.exa.ai.
# You can set this to an Exa-compatible proxy such as exa-pool.
EXA_API_BASE_URL=https://api.exa.ai
```

### Provider selection policy

- Default provider is Tavily.
- Only `WEB_SEARCH_PROVIDER=exa` switches to Exa.
- Missing/unknown provider values fall back to Tavily and log an info line.
- No automatic failover between providers.

### Output compatibility

`tools search` returns a list of `{ url, title, content, score }`.

- Tavily provider uses Tavily search `content` directly.
- Exa provider normalizes `content` as a snippet (not full-page text) by preferring:
  `highlights`, then `summary`, then truncated `text`.

### Tool server modes

- Core runtime and tool-bridge both use the same env-driven provider selection.
