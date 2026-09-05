# Recoverable workflow artifact publication

Approved by the user on September 5, 2026 for ARCH-11. The previous BlobStore started durable storage before callers received an upload handle. Saving that returned handle could not close the crash window.

## Approved change

Add a staged-upload lifecycle inside BlobStore. A staged upload writes bytes with their final immutable content identity, but remains unavailable to ordinary reads until adoption. A finite staging deadline lets existing blob maintenance remove uploads that never acquired a workflow owner. Adoption atomically makes that exact staged object durable. It cannot recreate a deleted object or overwrite an expiry decision.

Add workflow schema 27 with a `workflow_artifact_publications` table. Each row records the artifact ID, staged upload handle, expected SHA-256 and length, and creation time. Rows are recovery ownership for uploads, not another copy of artifact content.

Publication becomes:

1. Complete a staged upload. A crash here leaves only expiring staging data.
2. Persist its publication row before making the object durable.
3. Adopt the staged object.
4. In a workflow transaction, register the canonical artifact and remove its publication row. If another upload already won, retain the losing row until its blob deletion succeeds.

The writer and existing runtime maintenance may finish the same publication. They use the same idempotent operation. A publication is deleted only after a canonical winner is known, or the staged object is terminally absent/expired. Transient storage errors retain the row for retry. This avoids a separate worker, owner heartbeat, or execution queue.

## Compatibility and concurrency

Existing BlobHandleV1 and BlobRefV1 wire formats, normal uploads, and existing artifact rows remain unchanged. BlobStore gains private staged upload/adoption operations. Its internal reservation format gains staging state and a deadline. Backend adoption and expiry compete through one immutable decision so a stale cleanup read cannot delete a successfully adopted object. Normal explicit deletion still fences later use.

A rollback must first finish pending publication rows and clear staged uploads. Older binaries do not understand the new staged reservation state. The migration notes will state that limit.

No new dependency or configuration option is proposed. The staging deadline is an implementation constant. Recovery runs through existing Core maintenance and before workflow producers start.

## Review refinements

An expired adoption attempt must establish the shared terminal expiry decision before returning absence.
If concurrent adoption wins that decision, recovery uses the adopted reference instead of deleting it.

Expiry cannot prove that a remote byte write has stopped. A staged upload deleted while writes remain
unfinished retains its reservation and expiry index. Maintenance repeatedly removes any late bytes.
Only confirmed byte-write completion permits retiring this cleanup ownership; a timeout or process loss
does not. Interrupted producers can leave a small cleanup record indefinitely. Backend expiry scans
advance through retained records and wrap after a complete pass so these records cannot starve later
uploads. This uses the approved reservation lifecycle and existing maintenance.

## Verification

- Interrupt before and after publication-row persistence, adoption, and registry commit; recover without abandoning durable bytes.
- Race duplicate writers, recovery, adoption, and expiry; keep the canonical artifact readable and delete losers.
- Inject deletion failure and verify the publication remains until retry succeeds.
- Test local, memory, and S3 backend decision semantics; preserve existing upload/read/delete behavior.
- Verify schema-26 upgrade preserves existing workflow data and registration atomicity.
