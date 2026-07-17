---
name: workflow-authoring
description: Author and inspect reusable Lilac JavaScript workflows when a task needs durable fan-out, pipelines, iterative repair, verification, waits, or repeated orchestration.
---

# Workflow Authoring

Use a workflow when orchestration should be readable, reusable, or durable beyond the current request. Keep a one-off linear task in the current agent request.

A workflow is a deterministic, replayable program that orchestrates ordinary agent requests. Workflows orchestrate; profiles authorize. The workflow runtime owns durable operation identity, dispatch epochs, single-owner claims, terminal receipts, waits, triggers, replay, and progress delivery. It adds no path, network, tool, prompt, cwd, or invocation security policy. Every capability an agent has comes entirely from the selected deployed profile.

## Authoring Loop

1. Choose a lowercase kebab-case name of at most 64 characters.
2. Write the module contract below. Keep metadata static JSON literals; orchestration may be factored into pure same-file helpers.
3. Save with `workflow.definition.save`, or edit a project file directly.
4. Run `workflow.definition.validate` with representative concrete arguments. Validation is complete only when source, schema, resource, and argument checks pass.
5. Trigger with `workflow.run.trigger`. Record the returned run and revision IDs.
6. Inspect with `workflow.run.get`; use `--include-result-artifact=true` when a large terminal result was persisted out of line. Cancel unwanted waiting or queued runs with `workflow.run.cancel`.

## Locations

- Project: `<selected-project-root>/.lilac/workflows/<name>.js`
- Personal: `${DATA_DIR}/workflows/<name>.js`
- `scope: "auto"` resolves project first, then personal.
- Project, data, and user skills can override this bundled skill because `lilac-builtin` has lowest precedence.

Run every Level-2 workflow command from the intended project directory. The Level-1 `bash` cwd selects
that invocation's project root; `LILAC_WORKSPACE_DIR` remains only the main agent's default cwd and does
not constrain project selection.

Definitions are flat `.js` files. Nested names, traversal, symlinks, non-regular files, other extensions, and names outside strict lowercase kebab-case are rejected.

## Module Contract

```js
import { defineWorkflow } from "@lilac/workflow";

const VERIFY_PHASE = "verify";

async function verifyFindings(pipeline, agent, findings) {
  return pipeline(findings, (finding) =>
    agent(`Verify this finding:\n${finding}`, { profile: "explore" }),
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
  limits: {
    maxWallTimeMs: 3600000,
    maxInputBytes: 262144,
  },
  async run({ args, agent, parallel, pipeline, phase, waitForReply, sleep }) {
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

The file must begin with exactly one named import of `defineWorkflow` from `@lilac/workflow` and end with exactly one default `defineWorkflow({...})` export. Between them, it may contain named function declarations and `const` declarations initialized with static JSON literals or function expressions. Top-level calls, mutable declarations, additional imports/exports, and destructured declarations are forbidden. Pass host APIs such as `agent` and `pipeline` to helpers under their original names so call-site instrumentation remains deterministic. Host APIs cannot be aliased, reassigned, stored in objects, or called through computed/member access. A host-calling top-level helper may have one static invocation site; use `pipeline` for deterministic repeated helper invocation. Metadata must use finite literal JSON values without spreads, computed keys, or shorthand. Dynamic import, `require`, `eval`, the `Function` constructor, source-map indirection, ambient dependencies, and direct filesystem, process, network, time, randomness, or logging effects remain forbidden.

Validation is static. Lilac does not import or execute a definition while saving, validating, listing, or triggering it.

## Input Schema

The root must be `{ type: "object" }`. Supported nested types are `object`, `array`, `string`, `number`, `integer`, `boolean`, and `null`.

Supported constraints:

- Objects: `properties`, `required`, and `additionalProperties: false`. Omitted `additionalProperties` normalizes to `false`.
- Arrays: `items`, `minItems`, and `maxItems`.
- Strings: `minLength` and `maxLength`. User-defined regex patterns are not supported.
- Numbers: `minimum` and `maximum`.
- Scalar schemas: `enum` and `const`.
- All schemas: `description` and `sensitive`.

Mark credentials, tokens, private identifiers, and confidential prompts with `sensitive: true`. Sensitive paths are metadata for progress redaction. Do not place secrets in the workflow source itself.

Arguments must be plain JSON, fit `maxInputBytes`, match the schema without coercion, contain no unknown object properties, and never use `__proto__`, `prototype`, or `constructor` keys.

## Resources

Workflows orchestrate agents; deployed profiles own Level-1 tools/plugins, Level-2 callables/plugins, execution, and delegation. `network` and `workspaceWrites` describe profile behavior and tool-surface exposure; they are not trusted-Bash security boundaries. If a profile enables execution, ordinary trusted Bash runs with the service user's host access. The `resources` object contains only engine resource and durability controls:

- `agents.maxConcurrent`: maximum simultaneous agents.
- `agents.maxTotal`: maximum agents in the run.
- `waits`: any of `reply` and `sleep`.
- `maxNestingDepth`, `maxWallTimeMs`, and `operationIdleTimeoutMs`: optional bounded budgets.

The normalized resource profile and limits remain part of revision identity. Profiles are server-owned and are not reconstructed or narrowed by workflow source.

## Orchestration API

- `agent(prompt, options)`: dispatch one profile-native child-agent operation. `profile` is required and accepts `explore`, `general`, or `self`. Optional fields are `cwd`, `model`, `reasoning`, and `label`. Omit model or reasoning to preserve that profile's normal deployed defaults. Tools, plugins, Level-2 callables, execution, and delegation are exactly the selected deployed profile's native behavior; a workflow launch uses the same profile assembly and profile-bound request capability as a direct launch. `network` and `workspaceWrites` guide behavior and tool exposure rather than confining trusted Bash. The workflow runtime adds no second policy or prompt overlay.
- `parallel(promises, options?)`: await bounded parallel operations.
- `pipeline(items, callback, options?)`: map items with bounded concurrency and stable item ordering.
- `phase(name, callback)`: group operations for progress.
- `waitForReply(options)`: create a durable reply wait; declare `waits: ["reply"]`. Options are `prompt?`, `platform?`, `channelId?`, `messageId?`, `fromUserId?`, and `timeoutMs?`. Platform, channel, and user default to the persisted run origin. When `messageId` is present, only a direct reply to that anchor matches.
- `sleep(durationOrTimestamp)`: create a durable timer wait; declare `waits: ["sleep"]`. A number below `100000000000` is a duration in milliseconds; larger numbers are epoch milliseconds. ISO timestamp strings are also accepted.

Agent execution is intentionally concurrent: multiple `general` or `self` operations may edit the same cwd at once. Serialize dependent work in the workflow or choose distinct directories.

`cwd` is free-form. It may be an absolute service-UID-accessible local directory or a path relative to the invocation project, and it is not required to remain inside the invocation project. The selected cwd is the normal shared filesystem authority root, identical to what the same profile would use on a direct launch.

Ordinary JavaScript conditionals, loops, arrays, and object manipulation are allowed inside `run`. Workflow scripts themselves receive no filesystem, shell, network, environment, event-bus, MCP, or plugin access. Side effects occur only through journaled host operations; the child agents those operations dispatch have whatever their profile grants.

## Patterns

Fan-out and verification:

```js
const drafts = await pipeline(args.targets, (target) =>
  agent(`Inspect ${target}. Return evidence only.`, { profile: "explore", label: target }),
);
return phase("verify", () =>
  parallel(drafts.map((draft) => agent(`Independently verify:\n${draft}`, { profile: "explore" }))),
);
```

Iterative repair:

```js
let report = await agent(`Run the focused checks for ${args.area}.`, {
  profile: "explore",
});
for (let attempt = 1; attempt <= 3 && report.includes("FAIL"); attempt++) {
  await phase(`repair-${attempt}`, () =>
    agent(`Repair these failures:\n${report}`, {
      profile: "general",
      model: "deep",
      reasoning: "high",
    }),
  );
  report = await agent(`Re-run the focused checks for ${args.area}.`, { profile: "explore" });
}
return report;
```

Reply wait:

```js
const reply = await waitForReply({ prompt: "Choose deploy or stop", timeoutMs: 86400000 });
if (reply.text === "deploy") return agent("Perform the approved deployment checks.", { profile: "general" });
return "Stopped by user";
```

Scheduled delay inside a run:

```js
await sleep(args.runAt);
return agent("Run the scheduled audit now.", { profile: "explore" });
```

Timestamp and cron schedules use `workflow.trigger.create`. Creation pins the immutable revision and persisted origin snapshot. Every fire creates a distinct queued run without a later human recheck. Cron expressions have five fields and default to UTC.

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
tools workflow.run.list --state=queued
tools workflow.run.pause <run-id>
tools workflow.run.resume <run-id>
tools workflow.run.cancel <run-id> --reason="No longer needed"
tools workflow.trigger.create --input=@workflow-trigger.json
tools workflow.trigger.get <trigger-id>
tools workflow.trigger.list --state=active
tools workflow.trigger.cancel <trigger-id>
```

An existing definition can be replaced only with its current `expectedSha256`. This is optimistic concurrency, not a force flag.

## Revisions And Replay

Triggering creates an immutable content-addressed source snapshot and stores source, input-schema, normalized resource-policy, and argument hashes. Valid invocations enter `queued` when the principal-blind global workflow capacity allows admission. The workflow subsystem adds no caller, principal, safety-mode, or origin gate.

Concrete arguments are schema-validated and persisted. Each `agent()` operation has a deterministic request ID stable for a run, operation, and attempt; a dispatch has one active owner and one terminal receipt per dispatch epoch, and stale owners or epochs cannot publish terminal outcomes. The resolved model request is pinned in the durable dispatch and reused during replay. Waits, triggers, completion deliveries, and restart recovery are durable, and terminal journal history stays readable across schema migration.

The deterministic program child runs directly under Bun with its determinism lockdown and NDJSON protocol intact. The host enforces wall-time, cancellation, output-size, and protocol limits, and forcibly terminates the child on timeout or cancellation. There is no runtime memory-limit contract.

Progress cards expose state-appropriate pause, resume, and cancel controls. `workflow.*` access follows the selected profile's Level-2 callable/plugin configuration and the tool server's generic request capability; there is no workflow-specific invocation gate. The broader Level-2 server remains an internal service and must not be exposed as a public unauthenticated API.
