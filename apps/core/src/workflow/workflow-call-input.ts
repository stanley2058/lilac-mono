import { Result, TaggedError, type Result as ResultType } from "better-result";
import { z } from "zod";
import { jsonValueSchema } from "./workflow-domain";
import type { WorkflowSandboxCall } from "./workflow-sandbox";
import {
  resolveWorkflowAgentOperationInputResult,
  workflowPipelineOptionsSchema,
  workflowWaitForReplyOptionsSchema,
  type ResolvedWorkflowAgentInput,
  type WorkflowAgentOperationInputInvalid,
} from "./workflow-operation-policy";

export type DecodedWorkflowCallInput =
  | { readonly kind: "agent"; readonly input: ResolvedWorkflowAgentInput }
  | { readonly kind: "phase"; readonly input: z.output<typeof phaseInputSchema> }
  | { readonly kind: "parallel"; readonly input: z.output<typeof parallelInputSchema> }
  | { readonly kind: "pipeline"; readonly input: z.output<typeof pipelineInputSchema> }
  | {
      readonly kind: "waitForReply";
      readonly input: z.output<typeof workflowWaitForReplyOptionsSchema>;
    }
  | { readonly kind: "sleep"; readonly input: z.output<typeof sleepInputSchema> };

class WorkflowCallInputInvalid extends TaggedError("WorkflowCallInputInvalid")<{
  readonly kind: WorkflowSandboxCall["kind"];
  readonly message: string;
}> {}

export function decodeWorkflowCallInput(input: {
  readonly call: WorkflowSandboxCall;
  readonly canonicalWorkspaceRoot: string;
}): ResultType<
  DecodedWorkflowCallInput,
  WorkflowAgentOperationInputInvalid | WorkflowCallInputInvalid
> {
  if (input.call.kind === "agent") {
    return resolveWorkflowAgentOperationInputResult({
      value: input.call.input,
      canonicalWorkspaceRoot: input.canonicalWorkspaceRoot,
    }).map((value) => ({ kind: "agent", input: value }));
  }
  const invalid = (message: string) =>
    Result.err(
      new WorkflowCallInputInvalid({
        kind: input.call.kind,
        message,
      }),
    );
  switch (input.call.kind) {
    case "phase": {
      const decoded = phaseInputSchema.safeParse(input.call.input);
      return decoded.success
        ? Result.ok({ kind: input.call.kind, input: decoded.data })
        : invalid(decoded.error.issues[0]?.message ?? "Workflow call input is invalid");
    }
    case "parallel": {
      const decoded = parallelInputSchema.safeParse(input.call.input);
      return decoded.success
        ? Result.ok({ kind: input.call.kind, input: decoded.data })
        : invalid(decoded.error.issues[0]?.message ?? "Workflow call input is invalid");
    }
    case "pipeline": {
      const decoded = pipelineInputSchema.safeParse(input.call.input);
      return decoded.success
        ? Result.ok({ kind: input.call.kind, input: decoded.data })
        : invalid(decoded.error.issues[0]?.message ?? "Workflow call input is invalid");
    }
    case "waitForReply": {
      const decoded = workflowWaitForReplyOptionsSchema.safeParse(input.call.input);
      return decoded.success
        ? Result.ok({ kind: input.call.kind, input: decoded.data })
        : invalid(decoded.error.issues[0]?.message ?? "Workflow call input is invalid");
    }
    case "sleep": {
      const decoded = sleepInputSchema.safeParse(input.call.input);
      return decoded.success
        ? Result.ok({ kind: input.call.kind, input: decoded.data })
        : invalid(decoded.error.issues[0]?.message ?? "Workflow call input is invalid");
    }
  }
}

const phaseInputSchema = z.strictObject({ name: z.string().min(1).max(200) });
const parallelInputSchema = z.strictObject({
  count: z.number().int().nonnegative(),
});
const pipelineInputSchema = z.strictObject({
  items: z.array(jsonValueSchema).max(10_000),
  options: workflowPipelineOptionsSchema,
});
const sleepInputSchema = z.union([z.number().nonnegative(), z.string().min(1).max(100)]);
