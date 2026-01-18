# Attachments (Bus <> Agent <> Discord) Plan (v2)

This plan is **attachments-only** (no workflows).

Goals covered:
- outbound attachments from agent/tool output -> visible in Discord
- **multiple attachments** (e.g. send 2 images)
- inbound attachments -> **agent can download into the sandbox** via a tool call that does not require the model to name URLs/blobs

Non-goals (v2):
- a durable attachment index / long-term database of all attachments
- cross-session attachment routing via a dedicated cmd service (can be added later)

---

## Part A: Outbound Attachments (Agent/Tools -> Bus -> Discord)

### A0) Existing wiring (already present)

- Bus event type exists: `evt.agent.output.response.binary`
  - Spec: `packages/event-bus/lilac-spec.ts` (`EvtAgentOutputResponseBinary`)
  - Payload: `{ mimeType, dataBase64, filename? }`

- Bus -> Discord surface bridge exists:
  - `apps/core/src/surface/bridge/subscribe-from-bus.ts` maps `evt.agent.output.response.binary` to `SurfaceOutputPart { type: "attachment.add" }`.

### A1) Multi-attachment model

Multi-attachment is represented as **N** `evt.agent.output.response.binary` messages in-order.

This avoids changing event contracts and works naturally with streaming.

### A2) Add an agent tool: `attachment.add`

Implement a new tool available to the agent-runner toolset (same tier as `bash` and `fs`).

- Tool name: `attachment.add`
- Inputs:
  - `path?: string`
  - `paths?: string[]` (preferred)
  - `filename?: string`
  - `filenames?: string[]`
  - `mimeType?: string`
  - `mimeTypes?: string[]`

Resolution rules:
- If `paths` is present, ignore `path`.
- Pairwise overrides are optional:
  - `filenames[i]` overrides the inferred filename for `paths[i]`.
  - `mimeTypes[i]` overrides the inferred mime type for `paths[i]`.

Execution:
- Resolve/validate files, read bytes, base64 encode.
- Publish **one** `evt.agent.output.response.binary` event per attachment, preserving order.
- Tool output (for model visibility only; never echo base64):
  - `{ ok: true, attachments: [{ filename, mimeType, bytes }] }`

Context:
- Tool uses `ToolExecutionOptions.experimental_context` (same as `bash`) to identify the current request/session if needed.
  - In v2 we rely on publishing to the current request output stream (the same way `bus-agent-runner` publishes text deltas).

Guardrails:
- Enforce max attachment size and max total bytes per call (configurable; default conservative).
- Infer mime type from filename if missing.

### A3) Discord output stream: make attachments real (and safe)

Current behavior in `apps/core/src/surface/discord/output/discord-output-stream.ts`:
- A placeholder base message is created and may be deleted after embed replies are created.
- If attachments are sent on the placeholder message and it is deleted, attachments disappear.

Changes required:
- **Never attach files to a message that might be deleted.**
- Best-effort bundling (as agreed):
  - If attachments arrive before the first visible message send, attach them to that first visible message.
  - If attachments arrive after the first visible send, buffer them and send follow-up messages with files at `finish()`.

Follow-up semantics:
- Chunk follow-up attachments by Discord limit (<= 10 attachments per message).
- Follow-ups should reply in-thread to the last visible agent output message.

---

## Part B: Inbound Attachments (Discord -> Agent -> Sandbox)

We do **not** require the model to choose URLs/blobs. The tool extracts attachments from the tool execution context (`ToolExecutionOptions.messages`).

### B1) Capture Discord attachment metadata

Update `apps/core/src/surface/discord/discord-adapter.ts` to include Discord attachment metadata on `SurfaceMessage.raw`.

On `adapter.message.created`, include:
- `raw.discord.attachments: Array<{ url: string; filename?: string; mimeType?: string; size?: number }>`

Persistence:
- This lives inside `discord_messages.raw_json` (already persisted by `DiscordSurfaceStore.upsertMessage`).

### B2) Ensure attachments reach `ToolExecutionOptions.messages`

Today `apps/core/src/surface/bridge/request-composition.ts` produces string-only `ModelMessage.content`, so tool execution context would not reliably include attachment metadata.

Update request composition so the resulting `ModelMessage[]` contains attachment references.

v2 recommendation (tool-friendly, model-agnostic):
- Keep the existing user text, but append a sentinel-wrapped JSON block that tools can parse:

```text
[[lilac.attachments]]{"items":[{"url":"...","filename":"...","mimeType":"..."}]}[[/lilac.attachments]]
```

Notes:
- This does not rely on the model understanding URLs.
- It is stable for tools: extraction is deterministic.
- If you already have multipart/vision message content in some configurations, you can keep it; the sentinel block is specifically to guarantee the tool can discover attachments.

### B3) Preserve attachments through steer/follow-up merging

`apps/core/src/surface/bridge/bus-agent-runner.ts` currently merges messages into a single user string while running (`mergeToSingleUserMessage`). This would drop any non-string content and can also drop attachment metadata if it were encoded outside the string.

Update merge behavior:
- If incoming messages contain the attachment sentinel block, either:
  - do not merge; forward the newest user message verbatim, or
  - merge carefully while preserving exactly one attachments block (prefer newest)

v2 recommended rule (simple and safe):
- If any incoming message includes `[[lilac.attachments]]`, do not merge; forward newest.

### B4) Add an agent tool: `attachment.download`

Tool name: `attachment.download`

Input:
- `{ downloadDir?: string }`
  - default: `~/Downloads`

Extraction:
- Tool reads `ToolExecutionOptions.messages`.
- Identify the most recent **user** message that contains `[[lilac.attachments]]...[[/lilac.attachments]]`.
- Parse JSON and enumerate attachments.
- Download **all** attachments (all file types).

Hashing + “write missing only”:
- Download the bytes first.
- Compute `sha256(bytes)` (hex) and use `sha10 = first 10 hex chars` for filename.
- Determine extension:
  - prefer from `Content-Type` response header
  - else from original filename
  - else from URL path
  - else no extension
- Target path: `${downloadDir}/${sha10}${ext}`
- If file exists at target path: do not write.
- If missing: write file.

Return shape:
- `{ ok: true, downloadDir, files: Array<{ path, sha10, bytes, sourceUrl, mimeType? }> }`

Security/robustness:
- Allowlist download hosts to Discord CDN (e.g. `cdn.discordapp.com`, `media.discordapp.net`).
- Enforce max size per file and max total bytes per call.
- Sanitize paths; only write under the resolved `downloadDir`.
- De-duplicate within a single tool call by `sha10`.

---

## Implementation Order (v2)

1) Outbound: `DiscordOutputStream` changes so attachments persist and multi-attach follow-ups work.
2) Outbound: implement `attachment.add` tool and wire it into the agent-runner toolset.
3) Inbound: capture Discord attachments in `discord-adapter.ts` raw payload.
4) Inbound: update request composition to include attachment metadata in `ModelMessage[]` (sentinel JSON block).
5) Inbound: update running merge logic to preserve attachment metadata while steering/follow-ups.
6) Inbound: implement `attachment.download` tool with blob-hash filenames and “write missing only”.

---

## Acceptance Criteria

Outbound:
- `attachment.add({ paths: ["a.png", "b.png"] })` results in both files visible in Discord.
- If attachments arrive early: bundled on the first visible message.
- If attachments arrive late: delivered as one or more follow-up attachment messages.

Inbound:
- User sends a message with one or more Discord attachments.
- Agent calls `attachment.download({})` with no URL/blob arguments.
- Tool downloads attachments, computes blob sha256, and writes only files missing from the target directory.
- Tool returns local filesystem paths suitable for subsequent `fs` tool operations.
