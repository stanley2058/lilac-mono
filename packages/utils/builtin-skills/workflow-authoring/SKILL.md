---
name: workflow-authoring
description: Author and inspect reusable Lilac JavaScript workflows when a task needs durable fan-out, pipelines, iterative repair, verification, waits, or repeated orchestration.
---

# Workflow Authoring

Use a workflow when orchestration should be readable, reusable, independently reviewable, or durable beyond the current request. Keep a one-off linear task in the current agent request.

## Authoring Loop

1. Choose a lowercase kebab-case name of at most 64 characters.
2. Write the module contract below. Keep metadata static JSON literals; orchestration may be factored into pure same-file helpers.
3. Save with `workflow.definition.save`, or edit a project file directly.
4. Run `workflow.definition.validate` with representative concrete arguments. Validation is complete only when source, schema, capability, and argument checks pass.
5. Trigger with `workflow.run.trigger`. Record the returned run and revision IDs.
6. Inspect with `workflow.run.get`; use `--include-result-artifact=true` when a large terminal result was persisted out of line. Cancel unwanted waiting or queued runs with `workflow.run.cancel`.

## Locations

- Project: `<selected-project-root>/.lilac/workflows/<name>.js`
- Personal: `${DATA_DIR}/workflows/<name>.js`
- `scope: "auto"` resolves project first, then personal.
- Project, data, and user skills can override this bundled skill because `lilac-builtin` has lowest precedence.

Run every Level-2 workflow command from the intended project directory. The authenticated Level-1
`bash` cwd selects and canonicalizes that invocation's project root; `LILAC_WORKSPACE_DIR` remains only
the main agent's default cwd and does not constrain project selection.

Definitions are flat `.js` files. Nested names, traversal, symlinks, non-regular files, other extensions, and names outside strict lowercase kebab-case are rejected.

## Module Contract

```js
import { defineWorkflow } from "@lilac/workflow";

const VERIFY_PHASE = "verify";

async function verifyFindings(pipeline, agent, findings) {
  return pipeline(findings, (finding) => agent(`Verify this finding:\n${finding}`));
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
  capabilities: {
    agents: {
      profiles: ["explore", "general"],
      models: ["deep", "inherit"],
      reasoning: ["high", "provider-default"],
      allowedRoots: ["project"],
      tools: ["apply_patch", "bash", "batch", "glob", "grep", "read_file"],
      executables: "trusted-container",
      maxConcurrent: 8,
      maxTotal: 40,
      editing: ["shared", "worktree"],
      delegation: false,
    },
    level2: { callables: ["search"] },
    surfaces: { origin: [] },
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

Mark credentials, tokens, private identifiers, and confidential prompts with `sensitive: true`. Sensitive paths are metadata for review and progress redaction. Do not place secrets in the workflow source itself.

Arguments must be plain JSON, fit `maxInputBytes`, match the schema without coercion, contain no unknown object properties, and never use `__proto__`, `prototype`, or `constructor` keys.

## Capabilities

Capabilities are the reviewed maximum envelope. Every `agent()` call resolves to a concrete subset before it is journaled or dispatched. Declare only authority that at least one operation needs:

- `agents.profiles`: allowed child-agent profiles.
- `agents.models`: allowed model aliases or `inherit`.
- `agents.reasoning`: allowed values from `provider-default`, `none`, `minimal`, `low`, `medium`, `high`, and `xhigh`.
- `agents.allowedRoots`: `project` and/or canonical absolute directory roots. An operation cwd may be one of these roots or a canonical symlink-free descendant.
- `agents.tools`: concrete Level-1 tool IDs. Runtime exposure must equal the operation's selected subset and profile constraints.
- `agents.executables`: `none` or `trusted-container`. Trusted container execution is explicit review authority; restricted origins never gain it.
- `agents.maxConcurrent`: maximum simultaneous agents.
- `agents.maxTotal`: maximum agents in the run.
- `agents.editing`: allowed editing modes, any of `shared` and `worktree`. An empty array is read-only. Shared editing operations serialize by approved authority root across runs and workers, while read-only operations may overlap one shared editor and worktree editors may run in parallel.
- `agents.delegation`: maximum operation-level delegation authority. Dynamic child bounds are not part of this authoring wave; leave false unless the runtime path explicitly supports it.
- `level2.callables`: concrete callable IDs available through the `tools` CLI. IDs are hashed exactly; plugin reloads cannot add authority, and a granted ID that disappears is unavailable.
- `surfaces.origin`: concrete `surface.*` operations granted against the authenticated origin destination. Each must also appear in `level2.callables`.
- `waits`: any of `reply` and `sleep`.
- `maxNestingDepth`, `maxWallTimeMs`, and `operationIdleTimeoutMs`: optional bounded budgets.
- `safety.escalation`: optional `none` or `trusted_with_review`.

The exact normalized capability profile and limits are hashed into review identity. Increasing authority or changing limits creates a new revision that needs review.

## Orchestration API

- `agent(prompt, options?)`: dispatch one governed child-agent operation. Options may select `profile`, `model`, `reasoning`, canonical absolute `cwd`, `editing`, `isolation`, concrete `tools`, `executables`, `level2Callables`, `surfaceOriginOperations`, `delegation`, and `label`. Any value outside the reviewed envelope is rejected before dispatch. Editing and delegation default to false; executable, Level-2, and origin-surface authority default to none. `isolation` is valid only when editing is true and must be explicit when the envelope approves multiple editing modes. Each origin-surface selection must also be selected in `level2Callables`.
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
let report = await agent(`Run the focused checks for ${args.area}.`, {
  profile: "explore",
  tools: ["glob", "grep", "read_file"],
});
for (let attempt = 1; attempt <= 3 && report.includes("FAIL"); attempt++) {
  await phase(`repair-${attempt}`, () =>
    agent(`Repair these failures:\n${report}`, {
      profile: "general",
      model: "deep",
      reasoning: "high",
      editing: true,
       isolation: "shared",
       tools: ["apply_patch", "bash", "read_file"],
       executables: "trusted-container",
    }),
  );
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
