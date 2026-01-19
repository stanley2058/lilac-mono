# Bus Workflows (Async Tasks -> Resume Requests) Plan (v2)

This plan supersedes **Part B: Workflows** in `BUS_ATTACHMENTS_WORKFLOWS_PLAN.md`.

It defines a workflow system for async/long-running operations that can block an agent run and later resume work by issuing a **new** request into agent-runner.

It composes with:
- `BUS_REQUEST_ROUTER_PLAN.md` (normal surface -> request triggering)
- `BUS_AGENT_RUNNER_PLAN.md` (request execution + per-session FIFO scheduling)
- `BUS_ADAPTER_BRIDGE_PLAN.md` (bus -> adapter output relay)

## Goals

- Allow an agent to create a workflow consisting of one or more async tasks.
- Persist workflow + task state (Redis or SQLite) so workflows can outlive process restarts.
- Resume work by publishing a **new** `cmd.request.message` to agent-runner when tasks resolve.
- Keep workflow resumes independent from router behavior (router can ignore workflow-driven requests).
- Keep resume context compact and deterministic:
  - workflow carries a `summary` snapshot at creation time
  - each task carries a human-readable `description`

## Non-goals (v2)

- Durable long-term memory beyond the workflow `summary`.
- Perfect UX for "force a reply" (future: Discord components/modals).
- Cross-request output threading (resume posts back to a channel, not necessarily as a Discord reply).

## Key Design Decisions

### D1) Workflow resumes are new requests

When a workflow resolves, the workflow service publishes a **new** `cmd.request.message`.

Rationale:
- Reusing the original `request_id` risks replay/duplication with output relays that subscribe from `begin`.
- The resume run should be able to execute even if the original request/agent instance no longer exists.

### D2) FIFO scheduling is owned by agent-runner, not by queue modes

Workflow resumes should use `data.queue: "prompt"`.

Per-session FIFO (one active run per `session_id`) is an agent-runner concern:
- if the session is idle, the resume runs immediately
- if the session is busy with another request, the resume waits in the session queue

This avoids semantic confusion where `followUp` could be interpreted as "append to an existing request context".

### D3) Resume request_id must not trigger Discord reply threading

`apps/core/src/surface/bridge/subscribe-from-bus.ts` derives Discord `replyTo` from `request_id` only when:
- `request_id` matches `discord:<session_id>:<message_id>`

Resume requests should not use a `discord:` request id format.

Recommended format:
- `wf:<workflow_id>:<resume_seq>`

## Data Model

### Workflow

Workflow service stores:
- `workflowId: string`
- `state: "queued" | "running" | "blocked" | "resolved" | "failed" | "cancelled"`
- `createdAt: number`
- `updatedAt: number`

Workflow definition (stored in `CmdWorkflowCreateData.definition`):

```ts
export type WorkflowDefinitionV2 = {
  version: 2;

  // Link back to the originating request for auditing/troubleshooting.
  origin: {
    request_id: string;
    session_id: string;
    request_client: string;
    user_id?: string;
  };

  // Where the agent should post when the workflow resolves.
  // For the "DM B, then update channel X" scenario, resumeTarget.session_id = channel X.
  resumeTarget: {
    session_id: string;
    request_client: string; // e.g. "discord"

    // Optional but recommended: who to notify on resume.
    // On Discord this is the user id to mention.
    mention_user_id?: string;
  };

  // Summary snapshot captured at workflow creation time.
  // Produced by agent-runner (recommended) or caller-provided.
  summary: string;

  // Completion policy across tasks.
  // v2 supports multiple tasks, with a simple completion rule.
  completion: "all" | "any";
};
```

Notes:
- `summary` should be stable and compact ("what we were doing" and "what we are waiting for").
- Do not rely on the original chat history being available during resume.

### Task

Workflow service stores per task:
- `taskId: string`
- `workflowId: string`
- `state: "queued" | "running" | "blocked" | "resolved" | "failed" | "cancelled"`
- `kind: string`
- `description: string` (required)
- `input: unknown`
- `result?: unknown`
- `createdAt/updatedAt/resolvedAt`

The `description` is intentionally human-readable and is included in resume context.

## Bus Contracts

This plan uses the existing workflow contracts in `packages/event-bus/lilac-spec.ts`:
- `cmd.workflow.create` (`CmdWorkflowCreateData`)
- `cmd.workflow.task.create` (`CmdWorkflowTaskCreateData`)
- `evt.workflow.task.lifecycle.changed` (`EvtWorkflowTaskLifecycleChangedData`)
- `evt.workflow.task.resolved` (`EvtWorkflowTaskResolvedData`)
- `evt.workflow.lifecycle.changed` (`EvtWorkflowLifecycleChangedData`)
- `evt.workflow.resolved` (`EvtWorkflowResolvedData`)
- `cmd.workflow.cancel` (`CmdWorkflowCancelData`)

### Envelope headers

Workflow events SHOULD include envelope headers when the workflow is tied to a surface:

```ts
{
  request_id: string;      // origin request
  session_id: string;      // origin session
  request_client: string;  // origin client
}
```

The workflow service may also include resume target info in data (not headers) since the resume run is a new request.

## Task Types (v2)

### v2 minimum: discord.wait_for_reply (strict)

- `kind`: `"discord.wait_for_reply"`
- `input`:

```ts
export type DiscordWaitForReplyInput = {
  channelId: string;
  messageId: string;

  // Optional narrowing (recommended): only resolve if the reply author matches.
  fromUserId?: string;

  // Optional timeout to avoid workflows that never resolve.
  timeoutMs?: number;
};
```

Resolution rule (strict reply only):
- Subscribe to `evt.adapter.message.created`.
- Resolve when:
  - `evt.data.platform === "discord"`
  - `evt.data.channelId === input.channelId`
  - and `evt.data.raw.discord.replyToMessageId === input.messageId`
  - and if `fromUserId` is set: `evt.data.userId === fromUserId`

Result payload:

```ts
export type DiscordWaitForReplyResult = {
  channelId: string;
  replyMessageId: string;
  replyUserId: string;
  replyUserName?: string;
  text: string;
  ts: number;
  raw?: unknown;
};
```

### Future task families (not required in v2)

This plan intentionally leaves room for the earlier "external task" taxonomy:
- `notify` (completion: none/ack)
- `prompt` (completion: ack/response via modal)
- `wait` (completion: until/delay)

These can be expressed as additional `kind` values with standardized `input` fields.

## Services and Responsibilities

### Workflow service

Responsibilities:
- Consume `cmd.workflow.create` and persist workflows.
- Consume `cmd.workflow.task.create` and persist tasks.
- Emit lifecycle change events as tasks move through states.
- Subscribe to adapter events needed to resolve tasks:
  - v2: `evt.adapter.message.created`
- When tasks resolve, evaluate workflow completion policy (`all`/`any`).
- On workflow resolution, publish a new `cmd.request.message` to agent-runner.

Reliability:
- Treat adapter events as at-least-once; tasks must resolve idempotently.
  - Store a "resolvedBy" marker (e.g. replyMessageId) to prevent duplicate resumes.
- If a task has `timeoutMs`, resolve to a typed timeout result (or fail) and still allow resume.

### Agent-runner

Responsibilities:
- Provide workflow tools to the model by publishing workflow commands.
- Maintain per-session FIFO scheduling for all `cmd.request.message`.
- (Recommended) Produce the workflow `summary` snapshot at workflow creation time.
  - The runner has full access to the current prompt/messages and can produce a compact summary.

## Agent Tooling (Recommended)

Expose tools in agent-runner:
- `workflow.create({ definition: WorkflowDefinitionV2 }) -> { workflowId }`
- `workflow.task.create({ workflowId, kind, description, input }) -> { taskId }`
- `workflow.wait_for_reply({ workflowId?, description, channelId, messageId, fromUserId? })`

Notes:
- The tools should default envelope headers from env (`LILAC_REQUEST_ID`, `LILAC_SESSION_ID`, `LILAC_REQUEST_CLIENT`).
- Tool APIs should keep ids explicit in the return values so agents can refer to them.

## Resume Semantics

When the workflow resolves, the workflow service publishes:
- `cmd.request.message` to topic `cmd.request`
- headers:
  - `request_id`: new id, recommended `wf:<workflowId>:<resumeSeq>`
  - `session_id`: `definition.resumeTarget.session_id` (e.g. channel X)
  - `request_client`: `definition.resumeTarget.request_client` (e.g. "discord")
- data:
  - `queue: "prompt"`
  - `messages: ModelMessage[]`
  - `raw`: include workflow context

### Resume message construction

Recommended `messages` shape:

1) `system` message embedding workflow context:
- workflow summary
- task list with description + resolved results
- explicit instruction: respond in the resume target session and mention `mention_user_id` if provided

2) `user` message containing the triggering data:
- for `discord.wait_for_reply`: include the reply text + author info

This keeps the resume run deterministic without depending on original chat history.

## Example Flow: DM B, Then Update Channel X

1) User A asks in channel X.
2) Agent sends DM to B (outside this plan).
3) Agent creates a workflow:
   - `resumeTarget.session_id = channel X`
   - `summary` captured at creation time
4) Agent creates task T1:
   - `kind: discord.wait_for_reply`
   - `description: "Wait for B to reply to the DM about <topic>"`
   - `input: { channelId: <dmChannelId>, messageId: <dmMessageId>, fromUserId: <B> }`
5) Agent replies immediately in channel X: "I DM'd B; I'll update you when they reply." (normal agent output)
6) Later, B replies as a strict Discord reply.
7) Workflow service resolves T1 and publishes resume `cmd.request.message` to channel X.
8) Agent-runner executes resume request (FIFO) and posts an update in channel X mentioning A.

## Acceptance Criteria

- Agent can create a workflow with a `summary` and multiple described tasks.
- Workflow service resolves `discord.wait_for_reply` only on strict replies.
- If no agent is running for the resume target session, resume still runs (new request).
- If another request is running in the resume target session, resume is queued FIFO and runs after.
- Resume uses a new non-`discord:` `request_id` and does not attempt Discord reply threading.
- Resume prompt includes workflow `summary` and task `description` so the agent reliably continues the intended work.
