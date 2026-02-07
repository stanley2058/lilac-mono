# Bus Agent Runner (cmd.request.message -> out.req.*) Plan (v1)

This plan defines the "agent-runner" service that consumes bus requests and runs an AI SDK agent with streaming output.

It is the authoritative owner of:
- request execution
- per-session active request registry
- mapping bus queueing semantics to `AiSdkPiAgent` (steer/followUp/interrupt)

## Goals

- Consume `cmd.request.message` from topic `cmd.request` in work/consumer-group mode.
- For each request, run an agent and emit:
  - `evt.request.lifecycle.changed`
  - `evt.request.reply` (to start adapter streaming)
  - output events on `out.req.${request_id}`:
    - `evt.agent.output.delta.text`
    - `evt.agent.output.toolcall`
    - `evt.agent.output.response.text`
    - `evt.agent.output.response.binary` (attachments)
- Implement queue behaviors:
  - `prompt`: start a new run (or re-enter) for the request
  - `steer`: call `agent.steer(...)`
  - `followUp`: call `agent.followUp(...)`
  - `interrupt`: call `agent.interrupt(...)` (not default)
- Be the source of truth for "session has a running agent" via `evt.request.lifecycle.changed` headers.

## Non-goals

- Adapter ingestion and request trigger detection (router owns it).
- Durable long-term memory (can be added later).
- Workflow orchestration (separate service).

## Inputs / Outputs

### Input: cmd.request.message

- topic: `cmd.request`
- headers:
  - `request_id` (required)
  - `session_id` (required)
  - `request_client` (required)
- data:
  - `queue: "prompt" | "steer" | "followUp" | "interrupt"`
  - `messages: ModelMessage[]`
  - `raw?: unknown`

### Outputs

#### Request lifecycle

- `evt.request.lifecycle.changed`
  - headers: same request envelope
  - data: `{ state: "queued" | "running" | "streaming" | "done" | "failed" | "cancelled"; detail?; ts? }`

#### Reply trigger

- `evt.request.reply`
  - headers: same request envelope
  - data: `{}`

#### Output stream

- topic: `out.req.${request_id}` (derived from headers)
- types:
  - `evt.agent.output.delta.text` data: `{ delta, seq? }`
  - `evt.agent.output.toolcall` data: `{ toolCallId, status, display, ok?, error? }`
  - `evt.agent.output.response.text` data: `{ text }`
  - `evt.agent.output.response.binary` data: `{ mimeType, dataBase64, filename? }`

## Internal model

### Session registry

Agent-runner maintains:
- `activeBySession: Map<session_id, request_id>`
- `requestState: Map<request_id, { agent, lastActivityTs, client, sessionId, ... }>`

The router can be stateless-ish by consuming lifecycle events, but agent-runner is authoritative.

### Concurrency

- Ensure per-request ordering:
  - messages for the same `request_id` must be applied in the order they are committed from the bus.
- Ensure per-session constraints:
  - you likely want only 1 running request per session at a time.
  - if a new request arrives for the same session while one is running:
    - either queue it (stage 2+), or reject it with a failure lifecycle

This interacts with router rules (other-user mention -> new request). The simplest v1 behavior:
- accept multiple request_ids per session, but only one streams at a time (queue in-memory FIFO).

## Mapping cmd.queue -> AiSdkPiAgent

- `prompt`:
  - if request is not active: create agent instance, `agent.prompt(messages)`
  - if request is active but idle: `agent.prompt(messages)`
  - if request is active and streaming: treat as follow-up or reject (router should not do this)

- `steer`:
  - if request is active and streaming: `agent.steer(mergedUserMessage)`
  - if request is idle: treat as `prompt`

- `followUp`:
  - if request is active and streaming: `agent.followUp(mergedUserMessage)`
  - if idle: treat as `prompt`

Notes:
- `AiSdkPiAgent` delivers steering at safe boundaries.
  - after each tool call, and
  - at the end of a turn that finished without tool calls.
- Steering drains any buffered follow-ups and injects them together (bundled).

- `interrupt`:
  - if streaming: `await agent.interrupt(mergedUserMessage)`
  - else: treat as `prompt`

Message adaptation:
- router provides `ModelMessage[]` already.
- for `steer/followUp/interrupt`, agent-runner can merge the batch into one `ModelMessage` (role=user) or append them as-is.

## Output event mapping

Use `packages/agent/ai-sdk-pi-agent.ts` events:
- `message_update` with `text_delta` => publish `evt.agent.output.delta.text`
- `tool_execution_start/end` => publish `evt.agent.output.toolcall`:
  - `status: "start" | "end"`
  - `display`: preformatted label (tool name + short args)

Finalization:
- on agent idle and last assistant message is complete => publish `evt.agent.output.response.text`.
- always publish lifecycle change to `done` (or `failed`).

## Tool execution integration (tool-bridge)

Agent-runner will typically execute tools out-of-process (tool-bridge CLI/server) or in-process (core tools).

For attachment continuity, agent-runner must propagate request/session context into tool execution:
- set env vars on tool executions:
  - `LILAC_REQUEST_ID=<headers.request_id>`
  - `LILAC_SESSION_ID=<headers.session_id>`
  - `LILAC_REQUEST_CLIENT=<headers.request_client>`

This enables tools like `attachment.add_files` to default to "current session" without requiring the model to pass ids.

## Reliability

- Use `evt.request.lifecycle.changed` as the durable signal for request activity.
- Publish `evt.request.reply` early (after moving to running/streaming) so the adapter can start streaming.
- If the runner crashes mid-stream:
  - router may re-send messages; idempotency is handled by:
    - lifecycle transitions and output stream being append-only
    - optional dedupe by bus message id (future)

## Acceptance Criteria

- A `cmd.request.message(queue:"prompt")` produces a streamed response back to the adapter.
- While streaming, a `cmd.request.message(queue:"steer")` injects additional context mid-run without losing output stream.
- While streaming, a `cmd.request.message(queue:"followUp")` is buffered and delivered at a safe boundary (end of a non-tool turn).
- Runner publishes lifecycle state changes with headers so router can rebuild session state.
