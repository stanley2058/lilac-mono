# Architecture Gate

The permanent architecture gate combines TypeScript semantic analysis with focused production-syntax
checks. It creates one TypeScript `Program` per active Bun workspace and reports every finding as an error
with an exact workspace, source location, rule, owning symbol, remediation, and fingerprint.

```sh
# Standalone subsets for focused development
bun scripts/architecture/runner.ts check
bun scripts/architecture/runner.ts check --workers=2
bun scripts/oxlint-plugins/check-production-syntax.mts
bun test scripts/architecture/architecture.test.ts

# Full permanent gate, concurrent local check, then conservative repository CI
bun run lint
bun run check
bun run ci
```

The standalone commands cover only their named subset. Use `bun run lint` for the complete lint and
architecture gate. `bun run check` overlaps independent generated-code, lint, test, typecheck, and format
gates for local validation; `bun run ci` runs the same classes of checks conservatively in series.

There is no baseline, suppression, inventory-expansion, or migration-status path. `runner.ts` accepts only
`check`, with an optional positive `--workers=N`; new findings must be fixed or represented by one of the
exact reviewed registrations below.

## Fail-Closed Inventory

`workspace-inventory.ts` discovers every `apps/*` and `packages/*` directory containing `package.json`.
The gate fails before analysis when a discovered workspace is missing from `ACTIVE_WORKSPACES`, a manifest
workspace no longer exists, or a root is duplicated. Adding a workspace therefore requires adding its
architecture policy in the same change.

Every active workspace always receives every rule in `FINAL_PACKAGE_WIDE_ARCHITECTURE_RULES` over the
single `**` zone. Registration-owned rules remain exact: manifest integrity derives their complete module
set from the registrations and rejects missing, stale, wildcard, or extra zones.

## Exact Registrations

`manifest.ts`, `precise-exception-identities.ts`, and `reviewed-exception-adapters.ts` are the
reviewed catalog for:

- boundary decoders, opaque values, and exact capability predicates;
- open-protocol adapters and their explicit local fallback variants;
- event, tool, Result-decoder, persistence, and SQLite contracts;
- event delivery APIs and cross-workspace consumers;
- operational Result APIs, compatibility outputs, and Panic sites; and
- host-signal adapters and defect supervisors.

Registrations name exact modules and symbols. Specialized Result-bearing registrations must also appear
in `operationalResultApis`. Event codec registrations point to one strict `defineLilacEvents` catalog;
the analyzer derives canonical and family membership and verifies that the codec registry is projected
from that exact catalog.

`APPROVED_EXCEPTION_ADAPTER_CATALOG` is derived only from exact host-signal and Panic-observation
registrations. External-to-Result capture is intrinsic and is not an exception-adapter category or
inventoried registration. Manifest integrity validates callable identity,
direction, syntax kinds, provenance, external/host relationship, reason, complete registration coverage,
and `APPROVED_EXCEPTION_ADAPTER_CATALOG_SHA256`. Change the owning registration, review the derived
catalog metadata, then update the digest and focused tests.

## Permanent Rules

Semantic rules enforce boundary decoding, domain-owned `unknown`, assertion and predicate safety, closed
union exhaustiveness, declarative Result handling, Panic registration, compatibility serialization,
redacted TaggedError logging, event delivery, persisted codecs, and SQLite transaction atomicity.
Production code must compose actual `better-result` values through `match`, `map`, `mapError`, `andThen`,
`tryRecover`, `gen`, or collection helpers instead of reading branch discriminants, invoking branch guards,
or extracting with `unwrap`. The analyzer resolves aliases and the installed library declarations so domain
objects and serialized compatibility envelopes with their own `status` fields remain unaffected.
Actual Result `match` calls also may not rebuild both `{ status: "ok", value }` and
`{ status: "error", error }` branches; domain projections and `Result.codec` envelopes remain valid.

One local settlement form is intrinsic: a positive instance `captured.isErr()` may be the complete
condition of an `if` when `captured` is an immutable local initialized directly, and in the same lexical
block, from object-form `Result.try` or an awaited object-form `Result.tryPromise`. The Err branch may
return, throw, or record failure state before continuing. Aliases, transformed Results, negated or compound
conditions, `isOk`, static guards, and all other manual Result discrimination remain invalid.

Object-form `Result.try` and `Result.tryPromise` are intrinsic capture boundaries only through direct
immutable `better-result` import bindings and need no exception registration. Catch mappers must be inline
or direct immutable function bindings with visible implementations, and must return captured data rather
than throw, reject, or signal a host;
exported and operational Result error contracts cannot contain `Panic` or `unknown`. Function-form capture
remains invalid because it exposes `UnhandledException`.

The syntax gate rejects every production `TryStatement` without a manifest exemption, as well as
unregistered host exception flow, inline async Result callbacks, presentation decoder imports,
store-owned inline decoding, direct SQLite transactions, `else` branches after terminal statements,
ordered disjunctive `if`/`else if` chains that should use `switch (true)`, and violations of the unified
managed-blob seam. Oxlint also applies the permanent package-wide nested-ternary and local-record-guard
rules. Syntax registrations use the same exact manifest identities as semantic analysis; there is no
separate syntax exception catalog.

### Unified blob storage

`BLOB_STORAGE_ARCHITECTURE_POLICY` registers the storage workspace, adapter construction owners, Core
close owner, materialization modules, current event schema, and offline migration modules. The syntax
gate enforces these contracts:

- only `packages/blob-storage` imports Bun S3 storage operations;
- `packages/blob-storage` does not import another Lilac workspace domain;
- only registered composition and migration modules construct adapters;
- current event schemas and Core databases do not store managed inline bytes;
- only the Core runtime owner closes the runtime-composed `BlobStore`; the offline migration entrypoint
  closes the separate store it constructs;
- `BlobStore.open` stays in registered hydration or materialization modules; and
- legacy blob decoder imports stay in the registered offline migration task.

The Core BLOB-column check has one registered structured-data exception: conversation-thread vector
embeddings. Migration modules are exact registrations because their job is to read and remove legacy byte
formats; runtime modules receive no compatibility exemption.

Semantic and syntax checks share the exclusions in `source-policy.ts`. Test modules, test-support
trees, vendored source, generated output, and the Core remote-runner bundle are excluded. Generated
bundles are checked at their TypeScript source. A `fixtures` directory alone is not an exclusion:
production `src/fixtures` is checked, while fixtures under test-support trees are excluded.

### Persisted Codecs

Each `persistedCodecs` registration names one exact Result-returning callable, its persisted input
parameter, one exact fixture catalog, and its complete success-provenance union. Success has the shape
`{ value: Decoded; provenance }`; `current` is required. A normal compatibility codec also requires
`migrated`. A clean-break codec declares `legacyOutcome: "rejected"`, omits `migrated`, and must reject
its legacy fixture. `missing-defaulted` is allowed only for a genuine missing-value default contract.
Decoded values and owned errors recursively exclude `any`, `unknown`, and `never`.

The fixture catalog contains exactly `current`, `legacy`, `missing-defaulted`, `unsupported-version`,
`malformed-serialization`, and `corrupt-fields`. The current fixture succeeds with current provenance.
The legacy fixture either succeeds with migrated provenance or fails under a registered clean break.
The missing fixture succeeds with `missing-defaulted` only when registered; otherwise it fails.
Unsupported, malformed, and corrupt fixtures fail without provenance.

Every codec is also an `operationalResultApis` entry. `persistedStoreConsumers` binds store policy to
the complete codec set each consumer must call, and each consumer is likewise an operational Result API.
`lilac/no-store-inline-decoding` rejects `JSON.parse`, Zod-style `parse` or `safeParse`, and their async
variants in registered consumers and nested callbacks. Persisted decoding belongs in the registered
codec, not in the store.

### SQLite Results

Each `sqliteTransactionAdapters` registration names the adapter, database and operation parameters,
rollback sentinel, Panic classifier, and SQLite driver classifier. The adapter must:

- accept a real `bun:sqlite` `Database` and a callback returning a direct Result;
- invoke `Database.transaction` with a callback that returns a plain value;
- throw one exact non-exported sentinel when the logical callback returns Err and recover only that
  sentinel from an object-form `Result.try` captured outcome outside the driver callback;
- take a positive branch controlled only by exact `better-result#Panic.is` classification of the captured
  cause and rethrow that same cause before ordinary driver classification;
- return only failures recognized by the exact registered SQLite driver classifier;
- rethrow every unrecognized thrown value as a defect; and
- be linked in `operationalResultApis`.

The direct Err discriminator required inside that exact driver callback is the only registered exception
to declarative Result handling. The analyzer derives it from the SQLite adapter registration and verifies
that the branch throws the registered private rollback sentinel; registration does not exempt other Result
branching in the adapter.

`architecture/no-result-err-in-sqlite-callback` resolves the actual `bun:sqlite` callback and
`better-result` declarations. It rejects inline `Result.err` and named callbacks whose return type
contains `Err`, preventing a logical failure from being committed as a plain callback return.

Each `sqliteTransactionConsumers` entry must invoke its exact adapter and be linked in
`operationalResultApis`. `lilac/no-direct-sqlite-transaction` rejects direct `.transaction()` calls and
SQL `BEGIN`, `COMMIT`, or `ROLLBACK` in registered consumers and descendants. The registered adapter is
the only rollback exception boundary.

For either contract, land focused real compatibility or atomicity tests before registration, register
every public or operational Result consumer, and add every owned module to the exact semantic zone.
Manifest integrity rejects broad, missing, extra, and stale zones. Run `bun run test:architecture`,
`bun run test:lint-rules`, `bun run typecheck:architecture`, `bun run typecheck:lint-plugins`, the
architecture runner, `bun run lint`, and `bun run fmt:check` after changing these registrations.

The real-library fixtures use installed `better-result` 3.0 and `bun:sqlite` to exercise all six
persistence outcomes plus commit, logical-Err rollback, recognized driver failure mapping, and exact
Panic identity propagation against in-memory SQLite.

## Performance

`runner.ts check` validates workspace inventory and manifest integrity once in the parent, then analyzes
workspaces in isolated subprocesses. Each child resolves one workspace configuration, creates exactly one
TypeScript `Program` rooted at production files and declarations, reports that workspace's diagnostics, and
exits. The operating system then reclaims the Program, checker, source files, and lazy declaration indexes.
Package-root, event-delivery, persistence, and approved-exception catalogs are still derived from the full
manifest in every workspace analysis, so partitioning does not narrow cross-workspace rules.

The default is one worker, preserving the lowest-memory serial path used by `lint` and CI. Local `check`
uses two workers. Worker output is bounded, captured, and emitted in manifest order so diagnostics remain
deterministic even when workers overlap. Exit status is aggregated so findings from any worker fail the
parent command; an unexpected worker exit stops new scheduling and fails closed. Each worker constructs
and validates its TypeScript Program, then reuses completed workspace diagnostics from a repository-scoped
cache under the system temporary directory when every loaded source, compiler option, registration,
analyzer implementation file, and TypeScript version has the same content hash. Entries are immutable and
written with an atomic rename so overlapping workers and commands cannot observe partial data.

Focused integration tests spawn the real worker against checked-in `fixtures/workspace-runner` projects and
assert its exact output and exit protocol. The fixture manifest is selected only for those direct test
processes; `runner.ts check` removes the fixture selector from every production worker environment.

Measure architecture-runner changes with
`/usr/bin/time -v bun scripts/architecture/runner.ts check` and the equivalent `--workers=2` command.
Record wall time and maximum RSS for both when changing program creation, process partitioning, source
traversal, registration resolution, or caching. Measure both a cold cache and an immediate warm rerun.
Compare the same checkout and environment before and after the change; dated development-checkout
snapshots are not permanent benchmarks.
