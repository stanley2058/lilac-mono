# Lilac Telemetry Proxy (Cloudflare Worker)

Thin Cloudflare Worker that receives opt-in Lilac telemetry batches on your own Cloudflare zone hostname (e.g. `t.lilac.stw.tw`) and forwards them to PostHog without exposing a CNAME chain to `posthog.com` or forwarding client IPs.

## What it enforces

- Only accepts `POST /batch` or `POST /batch/` (plus `GET /health`)
- Streams request bodies with a hard 256 KiB cap (without buffering oversize payloads) and 50 events per batch
- Drops any event outside the allowlist (`lilac_error`, `lilac_agent_run`), validates `distinct_id` and `timestamp`, and projects event properties through a closed per-event schema
- Injects `POSTHOG_API_KEY` server-side so Lilac clients do not need a PostHog key
- Forces `$ip: null` and strips all inbound headers (`CF-Connecting-IP`, `X-Forwarded-For`, etc.) before forwarding to PostHog

## Deploy

1. `wrangler.toml` binds `t.lilac.stw.tw` as the Worker's custom domain. For your own deployment, set `pattern` to a hostname in your Cloudflare zone. Set `POSTHOG_HOST` to `https://eu.i.posthog.com` if your PostHog project is in the EU region.
2. Store your PostHog project API key as a Worker secret:
   ```sh
   npx wrangler secret put POSTHOG_API_KEY
   ```
3. Deploy:
   ```sh
   npx wrangler deploy
   ```
