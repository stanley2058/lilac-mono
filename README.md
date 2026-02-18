# Lilac Monorepo (Fork)

This repository is a fork of the upstream project.

| Upstream | https://github.com/stanley2058/lilac-mono |
| --- | --- |
| Upstream README | https://github.com/stanley2058/lilac-mono/blob/main/README.md |

This README intentionally documents only what differs in this fork. For full documentation and usage, follow the upstream README link above.

## Fork-only changes (vs upstream)

| Area | What changed in this fork | Where |
| --- | --- | --- |
| CI | Scheduled upstream sync (auto-merge `upstream/main` into `main`) and triggers image build on updates | `.github/workflows/sync-upstream.yml` |
| CI | Build & push Docker image to GHCR on `main` pushes | `.github/workflows/build-image.yml` |
| Docker | Container default user/uid and workspace env var name differ from upstream | `Dockerfile` |
| Tools | `tools search` supports Exa backend (via `exa-js`) while preserving Tavily-default behavior | `apps/core/src/tool-server/tools/web.ts`, `apps/core/src/tool-server/tools/web-search.ts` |

## Web Search Provider (Notes / Workarounds)

This fork keeps the upstream `tools search` contract but makes the backend configurable.

### Configuration

Runtime behavior lives in `core-config.yaml` (default path: `data/core-config.yaml`). Secrets stay in environment variables.

`core-config.yaml`:

```yaml
tools:
  web:
    search:
      provider: tavily # or "exa"; any other value falls back to tavily
    exa:
      # Optional. If omitted, exa-js uses its default (https://api.exa.ai).
      # You can set this to an Exa-compatible proxy such as exa-pool.
      baseUrl: "https://api.exa.ai"
```

Environment variables:

```bash
# Required when provider=tavily
TAVILY_API_KEY=...

# Required when provider=exa
EXA_API_KEY=...
```

### Provider Selection Policy

The selection rule is intentionally conservative to preserve original lilac-mono behavior:

- Default provider is Tavily.
- Only `provider: exa` switches to Exa.
- Missing/unknown provider values fall back to Tavily and log an info line.
- No automatic failover between providers (avoids silently sending queries to a different vendor).

### Result Shape Compatibility

`tools search` still returns a list of `{ url, title, content, score }`.

- Tavily provider uses Tavily's search `content` as-is.
- Exa provider normalizes `content` as a snippet (not full-page text): `highlights` -> `summary` -> `text`.
  This keeps `content` closer to Tavily's “snippet” semantics.

### Tool Server Modes

- Core runtime loads `core-config.yaml` and applies the provider policy.
- `apps/tool-bridge/index.ts` also loads `core-config.yaml` so local `tools` calls behave the same as core runtime.
