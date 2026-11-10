import type { PersistedDataError } from "@stanley2058/lilac-utils";
import type { Result as ResultType } from "better-result";
import type {
  WorkflowRevision,
  WorkflowRun,
  WorkflowOperation,
  WorkflowWait,
  WorkflowTrigger,
  WorkflowSurfaceBinding,
  WorkflowSurfaceAction,
  WorkflowArtifactReference,
} from "./workflow-domain";
import {
  decodeWorkflowPersistenceRow,
  type WorkflowPersistedRow,
  type DecodedWorkflowRequestDispatch,
  type DecodedWorkflowRequestTerminalReceipt,
  type DecodedWorkflowActionOutboxEntry,
} from "./workflow-persistence-codec";

export type WorkflowRowDecoder<T> = (input: {
  readonly row: WorkflowPersistedRow;
  readonly schemaVersion: number;
}) => ResultType<{ readonly value: T }, PersistedDataError>;

export function decodeWorkflowRevisionRow(
  input: Parameters<WorkflowRowDecoder<WorkflowRevision>>[0],
) {
  return decodeWorkflowPersistenceRow({ ...input, kind: "revision" });
}

export function decodeWorkflowRunRow(input: Parameters<WorkflowRowDecoder<WorkflowRun>>[0]) {
  return decodeWorkflowPersistenceRow({ ...input, kind: "run" });
}

export function decodeWorkflowOperationRow(
  input: Parameters<WorkflowRowDecoder<WorkflowOperation>>[0],
) {
  return decodeWorkflowPersistenceRow({ ...input, kind: "operation" });
}

export function decodeWorkflowWaitRow(input: Parameters<WorkflowRowDecoder<WorkflowWait>>[0]) {
  return decodeWorkflowPersistenceRow({ ...input, kind: "wait" });
}

export function decodeWorkflowTriggerRow(
  input: Parameters<WorkflowRowDecoder<WorkflowTrigger>>[0],
) {
  return decodeWorkflowPersistenceRow({ ...input, kind: "trigger" });
}

export function decodeWorkflowSurfaceBindingRow(
  input: Parameters<WorkflowRowDecoder<WorkflowSurfaceBinding>>[0],
) {
  return decodeWorkflowPersistenceRow({ ...input, kind: "binding" });
}

export function decodeWorkflowSurfaceActionRow(
  input: Parameters<WorkflowRowDecoder<WorkflowSurfaceAction>>[0],
) {
  return decodeWorkflowPersistenceRow({ ...input, kind: "action" });
}

export function decodeWorkflowRequestDispatchRow(
  input: Parameters<WorkflowRowDecoder<DecodedWorkflowRequestDispatch>>[0],
) {
  return decodeWorkflowPersistenceRow({ ...input, kind: "dispatch" });
}

export function decodeWorkflowRequestTerminalReceiptRow(
  input: Parameters<WorkflowRowDecoder<DecodedWorkflowRequestTerminalReceipt>>[0],
) {
  return decodeWorkflowPersistenceRow({ ...input, kind: "receipt" });
}

export function decodeWorkflowActionOutboxRow(
  input: Parameters<WorkflowRowDecoder<DecodedWorkflowActionOutboxEntry>>[0],
) {
  return decodeWorkflowPersistenceRow({ ...input, kind: "outbox" });
}

export function decodeWorkflowArtifactRow(
  input: Parameters<WorkflowRowDecoder<WorkflowArtifactReference>>[0],
) {
  return decodeWorkflowPersistenceRow({ ...input, kind: "artifact" });
}
