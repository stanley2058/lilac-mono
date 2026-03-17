# Lilac Monorepo（DF Fork）

這個 repository 是 `lilac-mono` 的 fork，主要用於 DF 的部署與實驗。原則上 `main` 會盡量貼近 `upstream/main`；任何 fork-only 的行為會被清楚標註，並儘量用 feature flag / config 來收斂影響面。

| Item | Value |
| --- | --- |
| Upstream repo | https://github.com/stanley2058/lilac-mono |
| Upstream README | https://github.com/stanley2058/lilac-mono/blob/main/README.md |

上游 README 會維護完整的「專案介紹 / 結構 / build/test」說明；本 README 只聚焦在 **這個 fork 的差異與運維習慣**，讓 review/sync 成本最低。

---

## Repo Layout（Quick glance）

- `apps/core/`: core runtime（Discord / GitHub surfaces、router、agent runner、workflow、tool server）
- `apps/tool-bridge/`: dev-mode tool server entry + `tools` CLI
- `apps/acp-controller/`: ACP harness controller CLI（`lilac-acp`）
- `packages/*`: utils / agent / event-bus / plugin runtime
- `ref/`: vendored/reference repos（預設視為 read-only）

---

## Fork Policy

第一，`main` 盡量保持可快速 sync 回 `upstream/main`。第二，fork-only 的需求優先走 **config/feature flag**，避免「每次 merge 都手工解衝突」。第三，已被 upstream 接受的工作，會集中記錄在下方的 **PR ACCEPTED** 區。

---

## Current Fork-Only Differences

| Area | Files | Difference | Why |
| --- | --- | --- | --- |
| CI (fork ops) | `.github/workflows/sync-upstream.yml` | Adds scheduled/manual upstream sync workflow for this fork. | Keep fork branch current with upstream automatically. |
| CI (image publish) | `.github/workflows/build-image.yml` | Adds Docker image build/push workflow for this fork registry flow. | Keep fork-specific container image pipeline. |
| Container image variants | `Dockerfile`, `.github/workflows/build-image.yml` | CI workflow directly defines variant build args for runtime identity and publishes tags (`catalinna`, `claudia`), with `latest` aligned to `catalinna`. | Keep upstream defaults while producing fork-specific image variants. |
| Empty-reply guardrail (default off) | `packages/utils/env.ts`, `.env.example`, `apps/core/src/surface/bridge/bus-agent-runner.ts` | Adds feature flag `LILAC_SKIP_EMPTY_REASONING_REPLY`; when enabled, reasoning-only + empty final reply is skipped with diagnostics instead of posting empty placeholder text. | Keep upstream default behavior by default, but allow operational mitigation when needed. |

---

## Feature Flag: `LILAC_SKIP_EMPTY_REASONING_REPLY`

預設：**disabled**（保留 upstream 行為）。

```bash
LILAC_SKIP_EMPTY_REASONING_REPLY=true
```

啟用後效果：如果一次 run 的 terminal output 只有 reasoning 而 final text 為空，bridge 會跳過送出「空白回覆」，並在 logs 留下可追查的 diagnostics。

---

## Upstream-Accepted Contributions From This Fork（PR ACCEPTED）

這些變更最初在本 fork 完成，且已合併回 upstream（以下連結都是 upstream repo）。

| Status | Upstream PR | Title | Merged At |
| --- | --- | --- | --- |
| PR ACCEPTED | https://github.com/stanley2058/lilac-mono/pull/1 | `feat(core): add Exa web search provider` | 2026-02-19 |
| PR ACCEPTED | https://github.com/stanley2058/lilac-mono/pull/4 | `add support for custom Tavily API endpoint.` | 2026-02-20 |
| PR ACCEPTED | https://github.com/stanley2058/lilac-mono/pull/5 | `Cleaning up for #4` | 2026-02-21 |

---

## Quick Validation Commands

```bash
git diff --name-status upstream/main..main
git log --oneline --decorate main..upstream/main
git log --oneline --decorate upstream/main..main
```

---

## License

This repository is licensed under MIT. See `LICENSE` for details.

The `ref/` directory is vendored upstream/reference code and keeps each upstream project's own license terms.
