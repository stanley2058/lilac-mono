---
name: workflow-authoring
description: Author and inspect reusable Lilac JavaScript workflows when a task needs durable fan-out, pipelines, iterative repair, verification, waits, or repeated orchestration.
---

# Workflow Authoring

Use a workflow when orchestration should be readable, reusable, or durable beyond the current request. Keep a one-off linear task in the current agent request.

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

Run every Level-2 workflow command from the intended project directory. The authenticated Level-1
`bash` cwd selects and canonicalizes that invocation's project root; `LILAC_WORKSPACE_DIR` remains only
the main agent's default cwd and does not constrain project selection.

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

Workflows orchestrate agents; deployed profiles own tool access, editing, executable access, and delegation. The `resources` object contains only engine resource and durability controls:

- `agents.maxConcurrent`: maximum simultaneous agents.
- `agents.maxTotal`: maximum agents in the run.
- `waits`: any of `reply` and `sleep`.
- `maxNestingDepth`, `maxWallTimeMs`, and `operationIdleTimeoutMs`: optional bounded budgets.
- `safety.escalation`: optional and currently only `none`.

The normalized resource profile and limits remain part of revision identity. Profiles are server-owned and are not reconstructed or narrowed by workflow source.

## Orchestration API

- `agent(prompt, options)`: dispatch one profile-native child-agent operation. `profile` is required and accepts `explore`, `general`, or `self`. Optional fields are `cwd`, `model`, `reasoning`, `label`, and `isolation`. Isolation accepts `shared` or `worktree` and defaults to `shared`, but worktree execution is the next implementation stage and currently fails before operation dispatch. Omit model or reasoning to preserve that profile's normal deployed defaults. Tools, plugins, editing mode, Level-2 callables, Bash, network, and delegation are exactly the selected deployed profile's native behavior; workflow runtime adds no second policy or prompt overlay.
- `parallel(promises, options?)`: await bounded parallel operations.
- `pipeline(items, callback, options?)`: map items with bounded concurrency and stable item ordering.
- `phase(name, callback)`: group operations for progress.
- `waitForReply(options)`: create a durable reply wait; declare `waits: ["reply"]`. Options are `prompt?`, `platform?`, `channelId?`, `messageId?`, `fromUserId?`, and `timeoutMs?`. Platform, channel, and user default to the authenticated run origin. When `messageId` is present, only a direct reply to that anchor matches.
- `sleep(durationOrTimestamp)`: create a durable timer wait; declare `waits: ["sleep"]`. A number below `100000000000` is a duration in milliseconds; larger numbers are epoch milliseconds. ISO timestamp strings are also accepted.

Shared execution is intentionally concurrent: multiple `general` or `self` operations may edit the same cwd at once. Serialize dependent work in the workflow or choose distinct directories. Do not request `isolation: "worktree"` until the temporary hardening gate is removed.

`cwd` may be an absolute service-UID-accessible local directory or a path relative to the invocation project. Lilac persists its canonical real target, including when the authored spelling is a symlink alias, and rejects only exact deployment-owned Core state, credential, service-control, or configured credential roots plus missing or inaccessible directories. Ordinary project `.env*`, Git metadata, broad project/home ancestors, and directories containing a protected descendant are not workflow blacklists. The selected cwd is the normal shared filesystem authority root; it is not required to remain inside the invocation project.

Every workflow family also has one durable shared scratch directory inherited by generated nested delegations. The default profiles receive `scratch_read` and `scratch_write`; these native tools accept flat filenames only, so use names such as `audit-result.md` rather than subdirectories. Trusted subagent Bash exposes the same pinned directory as `$LILAC_SCRATCH_DIR` at `/run/lilac/scratch` and can use directories inside the OS sandbox. Scratch is reused after restart and redispatch, contains no injected secrets, and is retained while a family is active, paused, or ambiguous.

Ordinary JavaScript conditionals, loops, arrays, and object manipulation are allowed inside `run`. Workflow scripts receive no filesystem, shell, network, environment, event-bus, MCP, or plugin access. Side effects occur only through journaled host operations.

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
      isolation: "shared",
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

Timestamp and cron schedules use `workflow.trigger.create`. Creation requires an authenticated trusted main-agent request and pins the immutable revision plus owner principal. Every fire creates a distinct queued run without a later human recheck. Cron expressions have five fields and default to UTC.

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

## Revisions And Trust

Triggering creates an immutable content-addressed source snapshot and stores source, input-schema, normalized resource-policy, and argument hashes. Authenticated trusted main-agent invocations enter `queued` immediately. Restricted, public, unauthenticated, synthetic, stale, and forged origins fail before run creation.

Concrete arguments are schema-validated and persisted. Progress cards expose state-appropriate pause, resume, and cancel controls; each action token is owner-bound, card-bound, expiring, and one-use. Durable progress projection, sandboxed execution, waits, and schedules remain available. Deployment requires Linux user namespaces, Bubblewrap, a user systemd manager, and delegated cgroup-v2 memory/PID controls; execution fails closed when that boundary is unavailable.

All `workflow.*` Level-2 calls require a trusted active agent request recognized by the core server's request cache. Supplying `x-lilac-*` headers to the HTTP endpoint is not sufficient. The broader Level-2 server is still an internal trusted-network service and must not be exposed as a public unauthenticated API.
