---
name: workflow-authoring
description: Author durable Lilac JavaScript workflows for fan-out, iterative repair, verification, Discord reply waits, delayed work, and recurring schedules.
---

# Workflow Authoring

Use a workflow when orchestration should be reusable or survive the current request. Keep a one-off linear task in the current agent request.

## Authoring Loop

1. Choose a lowercase kebab-case name of at most 64 characters and a project or personal scope.
2. Write the module contract below. The file is complete when it has one workflow import, static metadata, declared resources, and all side effects expressed through awaited host APIs.
3. Save with `workflow.definition.save`, or edit the project file directly. Replacing a definition requires its current `expectedSha256`.
4. Run `workflow.definition.validate` with representative concrete arguments. Fix and save again until validation reports no errors; do not trigger before this gate is clean. Validation never imports or executes the module, so dynamic values and unvisited paths remain runtime-validated.
5. Trigger with `workflow.run.trigger` and record both run and revision IDs. For timestamp or cron execution, create a trigger using [REFERENCE.md](REFERENCE.md#scheduled-triggers) instead.
6. Inspect with `workflow.run.get` until the run reaches a terminal state. Use `--include-result-artifact=true` for an out-of-line result, and cancel a run that should not continue.

## Module Contract

```js
import { defineWorkflow } from "@lilac/workflow";

const VERIFY_PHASE = "verify";

async function verifyFindings(pipeline, agent, findings) {
  return pipeline(
    findings,
    (finding) => agent(`Verify this finding:\n${finding}`, { profile: "explore" }),
    { concurrency: 8 },
  );
}

export default defineWorkflow({
  name: "audit-routes",
  description: "Audit route authorization and verify findings",
  input: {
    type: "object",
    additionalProperties: false,
    required: ["directory"],
    properties: {
      directory: { type: "string", minLength: 1 },
      apiToken: { type: "string", sensitive: true },
    },
  },
  resources: {
    agents: {
      maxConcurrent: 8,
      maxTotal: 40,
    },
    waits: [],
  },
  async run({ args, agent, pipeline, phase }) {
    const filesJson = await agent(
      `List route files under ${args.directory}. Return only a JSON array of path strings.`,
      { profile: "explore" },
    );
    const files = JSON.parse(filesJson);
    const findings = await pipeline(
      files,
      (file) => agent(`Audit ${file} for missing authorization.`, { profile: "explore", label: file }),
      { concurrency: 8 },
    );
    return phase(VERIFY_PHASE, () => verifyFindings(pipeline, agent, findings));
  },
});
```

Required definition fields are `name`, `description`, `input`, `resources`, and async `run`; `limits` is optional.

- The first statement must be exactly `import { defineWorkflow } from "@lilac/workflow"` and the last must be one default `defineWorkflow({...})` export.
- Between them, use only named function declarations and `const` declarations initialized with static JSON or functions. Top-level calls, mutable declarations, destructuring, and additional imports or exports are rejected.
- Metadata is finite literal JSON: no spreads, computed keys, or shorthand. Orchestration inside `run` may use normal JavaScript.
- Call host APIs directly. Do not alias, reassign, store, or invoke them through members. Pass a host API to a helper under the same parameter name.
- A top-level helper containing host calls may have one static invocation site.
- Workflow code has no direct filesystem, shell, network, environment, clock, randomness, logging, MCP, event-bus, or plugin access. Side effects occur through host APIs and the child agents they dispatch.

## Inputs And Resources

The input root must be `{ type: "object" }`. Nested schemas support `object`, `array`, `string`, `number`, `integer`, `boolean`, and `null`; unknown object properties are rejected without coercion. Mark confidential inputs with `sensitive: true`: arguments and progress are redacted, but terminal results and details are unrestricted.

`resources.agents` is required. `maxConcurrent` bounds simultaneous agents and `maxTotal` bounds all agents in a run. Declare each durable wait used by the source in `waits`, for example `waits: ["reply", "sleep"]`. Workflows have no overall wall-time limit; `operationIdleTimeoutMs` only bounds an individual agent operation that stops producing events.

Workflow source cannot grant child authority. The selected deployed profile plus server policy determines tools, plugins, execution, delegation, filesystem behavior, and guardrails. `network` and `workspaceWrites` are behavioral/tool-surface settings, not trusted-Bash confinement.

Read [REFERENCE.md](REFERENCE.md) only when you need exact schema keywords, bounds, scope/discovery behavior, or schedule payloads.

## Host APIs

- `agent(prompt, options) -> Promise<string>` dispatches one child and returns its final text. `profile` is required: `explore`, `general`, or `self`. Optional fields are `cwd`, `model`, `reasoning`, and `label`. Omit model and reasoning to preserve profile defaults. Relative cwd resolves from the invocation project; absolute cwd is allowed and existence is checked only when used.
- `pipeline(items, callback, options?)` maps in stable item order. Concurrency defaults to `1`; set `{ concurrency }` for bounded fan-out.
- `parallel(promises)` journals and joins already-created promises. It has no options.
- `phase(name, callback)` groups operations for progress and deterministic scoping.
- `waitForReply(options)` creates a durable authenticated-origin Discord wait and requires `waits: ["reply"]`. `prompt` labels progress but sends no message. The resolved object contains `platform`, `channelId`, `messageId`, `userId`, optional `userName`, `text`, and `ts`.
- `sleep(value)` creates a durable timer and requires `waits: ["sleep"]`. Values below `100000000000` are duration milliseconds; values at or above it are epoch milliseconds. ISO timestamps are accepted.

Agent operations can run concurrently against the same cwd. Serialize dependent edits or use distinct directories.

## Determinism Gates

- Await every host operation before returning. A run fails if host operations remain active.
- Do not invoke one host call site concurrently through `map` or another ordinary callback. Use `pipeline`, whose item context gives each invocation a stable identity.
- Host inputs and the final result must be bounded JSON. Functions, symbols, cycles, and other non-JSON values fail; a final `undefined` becomes `null`.

## Commands

```bash
tools workflow.definition.save --input=@save-workflow.json
tools workflow.definition.validate --scope=auto --name=audit-routes --args:json='{"directory":"src"}'
tools workflow.definition.get --scope=auto --name=audit-routes --include-source=true
tools workflow.definition.list --scope=auto
tools workflow.run.trigger --scope=auto --name=audit-routes --args:json='{"directory":"src"}'
tools workflow.run.get <run-id>
tools workflow.run.get <run-id> --include-result-artifact=true
tools workflow.run.list --state=queued
tools workflow.run.pause <run-id>
tools workflow.run.resume <run-id>
tools workflow.run.cancel <run-id> --reason="No longer needed"
tools workflow.trigger.create --input=@workflow-trigger.json
tools workflow.trigger.get <trigger-id>
tools workflow.trigger.list --state=active
tools workflow.trigger.cancel <trigger-id>
```

Read [RUNTIME.md](RUNTIME.md) only when diagnosing capacity, pause/recovery, replay, dispatch ownership, progress delivery, or migration behavior.
