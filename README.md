# Lilac Monorepo (Fork)

This repository is a fork of the upstream project.

| Upstream        | https://github.com/stanley2058/lilac-mono                     |
| --------------- | ------------------------------------------------------------- |
| Upstream README | https://github.com/stanley2058/lilac-mono/blob/main/README.md |

This README focuses on what differs in this fork and how to configure it.

## Fork features

| Area   | What changed in this fork                                                                                                     | Where                                                                                     |
| ------ | ----------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| CI     | Scheduled upstream sync (auto-merge `upstream/main` into `main`) and triggers image build on updates                          | `.github/workflows/sync-upstream.yml`                                                     |
| CI     | Build & push Docker image to GHCR on `main` pushes                                                                            | `.github/workflows/build-image.yml`                                                       |
| Docker | Container default user/uid and workspace env var name differ from upstream                                                    | `Dockerfile`                                                                              |
| Tools  | `tools search` backend is configurable: Tavily (default) or Exa (via `exa-js`, supports Exa-compatible proxies like exa-pool) | `apps/core/src/tool-server/tools/web.ts`, `apps/core/src/tool-server/tools/web-search.ts` |

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

### Configure provider (core-config.yaml)

Add this to `data/core-config.yaml`:

```yaml
tools:
  web:
    search:
      # tavily (default) or exa
      # any other value falls back to tavily
      provider: tavily
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
- Only `tools.web.search.provider: exa` switches to Exa.
- Missing/unknown provider values fall back to Tavily and log an info line.
- No automatic failover between providers.

### Output compatibility

`tools search` returns a list of `{ url, title, content, score }`.

- Tavily provider uses Tavily search `content` directly.
- Exa provider normalizes `content` as a snippet (not full-page text) by preferring:
  `highlights`, then `summary`, then truncated `text`.

### Tool server modes

- Core runtime and tool-bridge both read `data/core-config.yaml` (via `DATA_DIR`) and apply the same provider selection.

## Author Murmur

The patch is most from AIGC. Use at your own risk.
I read all the patches even I don't understand Typescript. I check as rational as possible. I tried, all day, I am still confused at the whole system cause I am really not smart enough. I want to use web search but there is no extra money I can waste to purchase API credit. Fork and modify it is the only way to effectily manage the poor resources I have.
Except God-damn AI-agent, scraper and data stealler, I don't think there is any Homo sapiens want to see this rubbish so go to hell. Why the hack I should be endure as everything cursing me.

