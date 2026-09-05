# Recoverable workflow artifact publication

Workflow artifact publication records ownership before an uploaded object becomes durable. The earlier
upload path returned a handle only after starting durable storage, leaving a crash window that the
workflow database could not recover.

## Publication lifecycle

BlobStore stages bytes with their final immutable content identity. Staged objects remain unavailable
to ordinary reads until adoption. Workflow uploads have a ten-minute staging deadline, set by
`WORKFLOW_ARTIFACT_STAGING_MS` in
[`workflow-artifact-store.ts`](../apps/core/src/workflow/workflow-artifact-store.ts).
Adoption atomically makes the exact completed object readable and durable. It cannot recreate a deleted
object or overwrite a terminal expiry decision.

Workflow schema 27 adds `workflow_artifact_publications`. Its columns are `object_id`, the primary key,
`artifact_id`, `blob_ref_json`, and `created_at`. The JSON field stores the expected complete `BlobRefV1`,
including its object ID, SHA-256, and byte length. A SQLite check correlates `object_id` with that
reference. Rows retain upload ownership for recovery and contain no artifact bytes.

Publication follows this sequence:

1. Complete a staged upload. A crash before ownership is recorded leaves staging data for expiry cleanup.
2. Persist the publication row before making the object durable.
3. Adopt the staged object and verify the stored bytes against the expected artifact reference.
4. In one workflow transaction, register the canonical artifact and remove its publication row. If
   another upload already won, keep the losing row until its blob deletion succeeds.

The writer and runtime maintenance use the same idempotent reconciliation operation. If a canonical
artifact already exists, reconciliation retires a matching intent or deletes the duplicate before
retiring its intent. If adoption establishes that staging is absent or expired, reconciliation also
finishes blob cleanup before removing the intent. Transient storage failures retain ownership for retry.

Startup attempts a bounded batch before starting workflow producers. Recovery errors are logged and
deferred; startup does not wait for every publication to finish. The existing Core maintenance cycle
retries bounded batches alongside blob expiry maintenance. There is no separate publication worker,
execution queue, dependency, or configuration option.

## Adoption, expiry, and delayed writes

BlobStore's internal reservation format includes a `staged` state, `stagingExpiresAt`, and optional
`pendingWrites` state. Adoption and expiry compete through one immutable backend decision. An adoption
attempt past the deadline must establish terminal expiry before reporting absence. If concurrent
adoption wins, recovery uses the adopted reference. A stale expiry read cannot delete that adopted
object, while explicit deletion still fences later use.

Expiry cannot prove that a remote byte write has stopped. Deleting a staged upload with unfinished
writes retains its reservation and expiry index so maintenance can remove late bytes. Only confirmed
completion of the producer's content writes permits retiring this cleanup ownership. A timeout or
process loss does not provide that proof and can leave a small cleanup record indefinitely. Backend
expiry scans advance through retained records and wrap after a complete pass so these records do not
starve later uploads.

A process interrupted immediately after a delayed backend decision write can also leave an inert
metadata file after deletion. It cannot resurrect readable content or a durable reference. Completed
calls clean that file, but interrupted calls do not guarantee removal of every metadata marker.

## Compatibility and rollback

`BlobHandleV1`, `BlobRefV1`, ordinary uploads, and existing artifact references retain their contracts.
Schema-26 workflow databases upgrade to schema 27 online. Databases below the schema-26 blob baseline
still require the existing offline blob migration.

This is not backward-compatible storage for older binaries. They reject workflow schema 27 and do not
understand staged reservation fields or the adoption decision file. Adopted objects retain staging
metadata, so emptying the publication table and expiring unfinished uploads does not make the current
store readable by an older binary.

There is no automatic downgrade. Rollback requires a coordinated pre-upgrade backup of Core's databases
and managed blob storage, or a separately reviewed downgrade. Stop producers before rollback and restore
the backup's databases and managed blob storage together. Before reusing current storage, resolve pending
publications and outstanding backend writes. Elapsed time alone cannot prove that a remote write has
stopped. See [the migration notes](../MIGRATIONS.md#workflow-schema-27-and-staged-blob-publication).

## Implementation and tests

- [`workflow-artifact-store.ts`](../apps/core/src/workflow/workflow-artifact-store.ts) owns publication,
  verification, duplicate cleanup, and reconciliation.
- [`durable-workflow-store.ts`](../apps/core/src/workflow/durable-workflow-store.ts) owns exact publication
  identity checks and atomic canonical registration. Schema 27 is defined in
  [`workflow-migrations.ts`](../apps/core/src/workflow/workflow-migrations.ts).
- [`workflow-artifact-publication.test.ts`](../apps/core/tests/workflow/workflow-artifact-publication.test.ts)
  covers restart recovery, expiry, concurrent adoption and publication, and failed duplicate cleanup.
- [`durable-workflow-store.test.ts`](../apps/core/tests/workflow/durable-workflow-store.test.ts) covers
  schema-26 data preservation, identity conflicts, and transaction rollback.
- [`staged-backend.test.ts`](../packages/blob-storage/tests/staged-backend.test.ts) and
  [`staged-settlement.test.ts`](../packages/blob-storage/tests/staged-settlement.test.ts) cover backend
  decision races, retained expiry scans, and delayed content writes.
