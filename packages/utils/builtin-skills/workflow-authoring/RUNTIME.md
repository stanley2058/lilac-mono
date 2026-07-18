# Workflow Runtime And Recovery

Read this reference only when diagnosing runtime behavior rather than authoring the common path.

## Revision And Admission

Triggering creates an immutable content-addressed revision containing source, input schema, normalized resources and limits, and their hashes. Concrete arguments are schema-validated, hashed, and persisted. Resource and limit changes therefore create a different revision identity.

Manual and scheduled invocations compete for the global active-run capacity. A rejected manual invocation creates no run and may be retried with the same idempotency key. Scheduled overlap and missed-run policy can skip or defer occurrences before run creation.

## Journal And Replay

Each host call has a source-instrumented call-site ID and deterministic operation path. `pipeline` adds a stable item path.

Each `agent()` attempt receives a deterministic request ID. A dispatch has one active owner and one exact terminal receipt for its dispatch epoch. Owner heartbeats allow stale work to be reclaimed; stale owners and epochs cannot publish terminal outcomes. Dispatch authority has no hard elapsed-time expiry. The resolved model request is pinned in the durable dispatch and reused during recovery.

The workflow program is replayed from its immutable source after restart. Completed journal operations return their persisted outcomes instead of repeating side effects. Dynamic orchestration must therefore reach the same host-call identities and inputs during replay.

## Pause, Cancellation, And Failure

Pausing aborts active local execution and preserves durable state for replay. Resuming queues the run again. Exact terminal receipts committed around a pause may be adopted during recovery; an ambiguous side-effect lifecycle is blocked for manual reconciliation rather than guessed.

Cancellation marks the run and children cancelled, cancels waits, deactivates dispatches, publishes child interruption, and forcibly terminates the local workflow subprocess.

Protocol and output-limit violations fail execution.

## Wait And Trigger Durability

Reply waits and sleeps are persisted separately from the workflow subprocess. Resolver checkpoints, reply matching, deadlines, and timer reconciliation survive restart. Trigger definitions pin the revision and origin at creation; later edits to the source do not alter an existing trigger.

## Results And Progress

Terminal results and operation outputs are stored inline up to 64 KiB and otherwise in bounded artifacts. Run inspection returns terminal results and details without sensitivity gating. Sensitive input fields and argument hashes remain redacted, and progress rendering does not expose sensitive arguments or terminal output derived from a sensitive workflow.

Progress cards are projected from durable run state and expose state-appropriate pause, resume, and cancel controls. Completion delivery and progress projection retry independently of workflow execution.

## Runtime Compatibility

The current runtime is `lilac-workflow-js-v4`. Compatible migrations preserve journals; runtime clean breaks archive bounded audit summaries and retire incompatible executable records. Schema 23 retired v3 runs, triggers, dispatches, and receipts while leaving source definition files available for validation and saving as v4 revisions.

The deterministic program runs as a `bun --smol` subprocess with restricted globals and an NDJSON host protocol. The host enforces cancellation, operation-idle, output-size, and protocol limits. There is no runtime memory-limit contract.
