# Workflow Authoring Reference

Read only the section needed for the current authoring branch.

## Locations And Discovery

- Project definition: `<authorized-project-root>/.lilac/workflows/<name>.js`
- Personal definition: `${DATA_DIR}/workflows/<name>.js`
- `scope: "auto"`: project first, then personal.
- Project scope comes from the server-authorized request cwd bound to the Level-2 capability. An internal shell `cd` does not change it.
- Names are lowercase kebab-case, at most 64 characters. Definitions are flat `.js` regular files; directly addressing nested names, traversal, symlinks, other extensions, or invalid names fails.
- Listing ignores unsupported names, extensions, and nested entries. An existing invalid project definition shadows a personal definition under auto scope and reports the project error.

## Input Schema

The root must be `{ type: "object" }`. Supported nested types and keywords are:

- Objects: `properties`, `required`, `additionalProperties: false`. Omission normalizes to `false`.
- Arrays: `items`, `minItems`, `maxItems`.
- Strings: `minLength`, `maxLength`. User regex patterns are unsupported.
- Numbers and integers: `minimum`, `maximum`.
- Scalars: `enum`, `const`.
- Every schema: `description`, `sensitive`.

Bounds are depth 16, 256 properties per object, 256 enum values, 16,384 characters per schema string, and 10,000 array items. Arguments must be plain JSON, fit `maxInputBytes`, match without coercion, contain no unknown properties, and never use `__proto__`, `prototype`, or `constructor` keys.

## Resources And Limits

```js
resources: {
  agents: { maxConcurrent: 8, maxTotal: 40 },
  waits: ["reply", "sleep"],
  maxNestingDepth: 8,
  operationIdleTimeoutMs: 600000,
},
limits: {
  maxSourceBytes: 262144,
  maxInputBytes: 262144,
  maxOperationOutputBytes: 1048576,
  maxResultBytes: 1048576,
},
```

- `agents.maxConcurrent`: integer 1–64 and no greater than `maxTotal`.
- `agents.maxTotal`: integer 1–10,000.
- `waits`: `reply` and/or `sleep`; defaults to `[]` and normalizes sorted and unique.
- `maxNestingDepth`: integer 1–64; default 8.
- `operationIdleTimeoutMs`: 1,000–86,400,000; default 600,000.
- `maxSourceBytes` and `maxInputBytes`: positive integers, default and maximum 262,144.
- `maxOperationOutputBytes` and `maxResultBytes`: positive integers, default 1,048,576 and maximum 16,777,216.

Host bounds include agent prompt 1,000,000 characters, model/reasoning identifiers 200, cwd 4,096, label 500, phase name 200, reply prompt 2,000, reply IDs 200, reply timeout seven days, pipeline items 10,000, and pipeline concurrency 1–64.

Values above 64 KiB are stored out of line when allowed by the declared operation or result limit. Retrieve a terminal result with `workflow.run.get --include-result-artifact=true`.

## Scheduled Triggers

Timestamp trigger input:

```json
{
  "scope": "auto",
  "name": "audit-routes",
  "args": { "directory": "src" },
  "schedule": { "kind": "timestamp", "at": "2030-01-01T00:00:00Z" },
  "idempotencyKey": "audit-routes-2030"
}
```

`at` accepts an ISO timestamp or nonnegative epoch milliseconds.

Cron trigger input:

```json
{
  "scope": "auto",
  "name": "audit-routes",
  "args": { "directory": "src" },
  "schedule": {
    "kind": "cron",
    "expression": "0 3 * * 1",
    "timezone": "UTC",
    "skipMissed": true,
    "overlap": "coalesce"
  }
}
```

Cron expressions have five fields. Timezone defaults to UTC. Optional `startAt` is epoch milliseconds. `skipMissed` defaults to `true`; `overlap` defaults to `coalesce` and may be `parallel`.

Creation pins the immutable workflow revision and origin snapshot. Each successfully admitted occurrence creates a distinct queued run. Coalescing and global capacity may skip or defer an occurrence. Cancelling a trigger does not cancel runs it already created.

Use `sleep()` instead when the delay belongs inside one already-created run.

## Reply Wait Details

Reply waits require an authenticated Discord origin. `platform`, `channelId`, and `fromUserId` default to and, when supplied, must match that origin. `fromUserId` is the input match filter; the resolved event reports that value as `userId`. `platform` may only be `"discord"`. Supplying `messageId` requires a direct reply to that message. A timeout is optional; without one, the wait remains pending until a matching reply or cancellation.

Resolved value:

```js
{
  platform: "discord",
  channelId: "...",
  messageId: "...",
  userId: "...",
  userName: "...", // optional
  text: "...",
  ts: 1234567890,
}
```

## Definition Replacement

Get the current source hash before replacing an existing definition, then pass it as `expectedSha256` to `workflow.definition.save`. A stale hash fails rather than overwriting concurrent edits.
