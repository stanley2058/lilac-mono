---
name: workflow-authoring
description: Author and inspect reusable Lilac JavaScript workflows when a task needs durable fan-out, pipelines, iterative repair, verification, waits, or repeated orchestration.
---

# Workflow Authoring

Use a workflow when orchestration should be readable, reusable, independently reviewable, or durable beyond the current request. Keep a one-off linear task in the current agent request.

## Authoring Loop

1. Choose a lowercase kebab-case name of at most 64 characters.
2. Write the exact module contract below. Keep metadata static JSON literals; only `run` contains executable JavaScript.
3. Save with `workflow.definition.save`, or edit a project file directly.
4. Run `workflow.definition.validate` with representative concrete arguments. Validation is complete only when source, schema, capability, and argument checks pass.
5. Trigger with `workflow.run.trigger`. Record the returned run and revision IDs.
6. Inspect with `workflow.run.get`; use `--include-result-artifact=true` when a large terminal result was persisted out of line. Cancel unwanted waiting or queued runs with `workflow.run.cancel`.

## Locations

- Project: `<canonical-workspace-root>/.lilac/workflows/<name>.js`
- Personal: `${DATA_DIR}/workflows/<name>.js`
- `scope: "auto"` resolves project first, then personal.
- Project, data, and user skills can override this bundled skill because `lilac-builtin` has lowest precedence.

Definitions are flat `.js` files. Nested names, traversal, symlinks, non-regular files, other extensions, and names outside strict lowercase kebab-case are rejected.

## Module Contract

```js
import { defineWorkflow } from "@lilac/workflow";

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
  capabilities: {
    agents: {
      profiles: ["explore"],
      models: ["inherit"],
      maxConcurrent: 8,
      maxTotal: 40,
      editing: false,
      isolation: "shared",
    },
    waits: [],
  },
  limits: {
    maxWallTimeMs: 3600000,
    maxInputBytes: 262144,
  },
  async run({ args, agent, parallel, pipeline, phase, waitForReply, sleep }) {
    const filesJson = await agent(
      `List route files under ${args.directory}. Return only a JSON array of path strings.`,
    );
    const files = JSON.parse(filesJson);
    const findings = await pipeline(
      files,
      (file) => agent(`Audit ${file} for missing authorization.`, { label: file }),
      { concurrency: 8 },
    );
    return phase("verify", () =>
      pipeline(findings, (finding) => agent(`Verify this finding:\n${finding}`)),
    );
  },
});
```

The file must have exactly one named import of `defineWorkflow` from `@lilac/workflow`, followed by exactly one default `defineWorkflow({...})` export. No other top-level statements are allowed. Metadata must use literal JSON values without spreads, computed keys, or shorthand. Dynamic import, `require`, `eval`, the `Function` constructor, and source-map indirection are forbidden.

Validation is static. Lilac does not import or execute a definition while saving, validating, listing, or triggering it.

## Input Schema

The root must be `{ type: "object" }`. Supported nested types are `object`, `array`, `string`, `number`, `integer`, `boolean`, and `null`.

Supported constraints:

- Objects: `properties`, `required`, and `additionalProperties: false`. Omitted `additionalProperties` normalizes to `false`.
- Arrays: `items`, `minItems`, and `maxItems`.
- Strings: `minLength`, `maxLength`, and `pattern`.
- Numbers: `minimum` and `maximum`.
- Scalar schemas: `enum` and `const`.
- All schemas: `description` and `sensitive`.

Mark credentials, tokens, private identifiers, and confidential prompts with `sensitive: true`. Sensitive paths are metadata for review and progress redaction. Do not place secrets in the workflow source itself.

Arguments must be plain JSON, fit `maxInputBytes`, match the schema without coercion, contain no unknown object properties, and never use `__proto__`, `prototype`, or `constructor` keys.

## Capabilities

Declare the least authority the workflow needs:

- `agents.profiles`: allowed child-agent profiles.
- `agents.models`: allowed model aliases or `inherit`.
- `agents.maxConcurrent`: maximum simultaneous agents.
- `agents.maxTotal`: maximum agents in the run.
- `agents.editing`: whether child agents may edit.
- `agents.isolation`: `shared` or `worktree`. Parallel edit-capable agents require `worktree`; a single edit-capable agent may use `shared`.
- `waits`: any of `reply` and `sleep`.
- `maxNestingDepth`, `maxWallTimeMs`, and `operationIdleTimeoutMs`: optional bounded budgets.
- `surfaceSends` and `externalTools`: optional booleans, default false.
- `safety.escalation`: optional `none` or `trusted_with_review`.

The exact normalized capability profile and limits are hashed into review identity. Increasing authority or changing limits creates a new revision that needs review.

## Orchestration API

- `agent(prompt, options?)`: dispatch one governed child-agent operation.
- `parallel(promises, options?)`: await bounded parallel operations.
- `pipeline(items, callback, options?)`: map items with bounded concurrency and stable item ordering.
- `phase(name, callback)`: group operations for review and progress.
- `waitForReply(options)`: create a durable reply wait; declare `waits: ["reply"]`. Options are `prompt?`, `platform?`, `channelId?`, `messageId?`, `fromUserId?`, and `timeoutMs?`. Platform, channel, and user default to the authenticated run origin. When `messageId` is present, only a direct reply to that anchor matches.
- `sleep(durationOrTimestamp)`: create a durable timer wait; declare `waits: ["sleep"]`. A number below `100000000000` is a duration in milliseconds; larger numbers are epoch milliseconds. ISO timestamp strings are also accepted.

Ordinary JavaScript conditionals, loops, arrays, and object manipulation are allowed inside `run`. Workflow scripts receive no filesystem, shell, network, environment, event-bus, MCP, or plugin access. Side effects occur only through approved host operations.

## Patterns

Fan-out and verification:

```js
const drafts = await pipeline(args.targets, (target) =>
  agent(`Inspect ${target}. Return evidence only.`, { label: target }),
);
return phase("verify", () =>
  parallel(drafts.map((draft) => agent(`Independently verify:\n${draft}`))),
);
```

Iterative repair:

```js
let report = await agent(`Run the focused checks for ${args.area}.`);
for (let attempt = 1; attempt <= 3 && report.includes("FAIL"); attempt++) {
  await phase(`repair-${attempt}`, () => agent(`Repair these failures:\n${report}`));
  report = await agent(`Re-run the focused checks for ${args.area}.`);
}
return report;
```

Reply wait:

```js
const reply = await waitForReply({ prompt: "Choose deploy or stop", timeoutMs: 86400000 });
if (reply.text === "deploy") return agent("Perform the approved deployment checks.");
return "Stopped by user";
```

Scheduled delay inside a run:

```js
await sleep(args.runAt);
return agent("Run the scheduled audit now.");
```

Timestamp and cron schedules use `workflow.trigger.create`. A schedule pins the current immutable revision. Every fire creates a distinct run, rechecks exact-revision approval, and records the actual run result. Cron expressions have five fields and default to UTC.

## Commands

Use JSON files or `--<field>:json` for source, schema arguments, and progress objects:

```bash
tools workflow.definition.save --input=@save-workflow.json
tools workflow.definition.validate --scope=auto --name=audit-routes --args:json='{"directory":"src"}'
tools workflow.definition.get --scope=auto --name=audit-routes --include-source=true
tools workflow.definition.list --scope=auto
tools workflow.run.trigger --scope=auto --name=audit-routes --args:json='{"directory":"src"}'
tools workflow.run.get <run-id>
tools workflow.run.get <run-id> --include-source=true
tools workflow.run.get <run-id> --include-result-artifact=true --include-sensitive-result=true
tools workflow.run.list --state=awaiting_review
tools workflow.run.pause <run-id>
tools workflow.run.resume <run-id>
tools workflow.run.cancel <run-id> --reason="No longer needed"
tools workflow.approval.revoke <approval-id> --reason="Capability grant is no longer valid"
tools workflow.trigger.create --input=@workflow-trigger.json
tools workflow.trigger.get <trigger-id>
tools workflow.trigger.list --state=active
tools workflow.trigger.cancel <trigger-id>
```

An existing definition can be replaced only with its current `expectedSha256`. This is optimistic concurrency, not a force flag.

## Revisions And Review

Triggering creates an immutable content-addressed source snapshot and stores the exact source, input-schema, capability, and argument hashes. Approval is bound to the canonical project, workspace, resolved scope and path, exact hashes, and runtime version. Any source, schema, capability, limits, path, project, or runtime change requires review again.

An existing approved grant for that exact identity makes an authenticated invocation `queued`; otherwise it is `awaiting_review`. Concrete argument values are schema-validated and persisted but do not create separate grants. Discord cards expose deterministic approve/reject and state-appropriate run controls. GitHub cards require the exact opaque reply command shown on the card. Only the authenticated originating user can decide a review, and each action token is card-bound, expiring, and one-use. `workflow.approval.revoke`, pause/resume, durable progress projection, sandboxed execution, waits, and schedules are available. Deployment requires Linux user namespaces, Bubblewrap, a user systemd manager, and delegated cgroup-v2 memory/PID controls; execution fails closed when that boundary is unavailable.

All `workflow.*` Level-2 calls require a trusted active agent request recognized by the core server's request cache. Supplying `x-lilac-*` headers to the HTTP endpoint is not sufficient. The broader Level-2 server is still an internal trusted-network service and must not be exposed as a public unauthenticated API.
