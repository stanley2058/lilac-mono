import type { ModelMessage } from "ai";
import { Result, TaggedError, type Result as ResultType } from "better-result";
import {
  errorMessage,
  captureResultOutcome as resultOutcome,
} from "@stanley2058/lilac-utils/runtime-utils";
import {
  captureAgentOperation,
  rethrowAgentPanic,
  type OpaqueAgentValue,
} from "./failure-adapters";

class SteeringMessageCloneFailed extends TaggedError("SteeringMessageCloneFailed")<{
  readonly cause?: OpaqueAgentValue;
  readonly message: string;
}> {}

function cloneSteeringValue(
  value: OpaqueAgentValue,
  ancestors: ReadonlySet<object>,
): ResultType<OpaqueAgentValue, SteeringMessageCloneFailed> {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "undefined" ||
    typeof value === "bigint"
  ) {
    return Result.ok(value);
  }
  if (typeof value === "function" || typeof value === "symbol") {
    return Result.err(
      new SteeringMessageCloneFailed({ message: `unsupported ${typeof value} value` }),
    );
  }
  if (value instanceof URL) return Result.ok(new URL(value.href));
  if (value instanceof ArrayBuffer) return Result.ok(value.slice(0));
  if (value instanceof Uint8Array) return Result.ok(new Uint8Array(value));
  if (ArrayBuffer.isView(value)) {
    return Result.err(
      new SteeringMessageCloneFailed({
        message: `unsupported buffer view '${value.constructor.name}'`,
      }),
    );
  }
  if (ancestors.has(value)) {
    return Result.err(new SteeringMessageCloneFailed({ message: "cyclic values are unsupported" }));
  }
  const nestedAncestors = new Set(ancestors);
  nestedAncestors.add(value);
  if (Array.isArray(value)) {
    const cloned: OpaqueAgentValue[] = [];
    for (const entry of value) {
      const outcome = resultOutcome(cloneSteeringValue(entry, nestedAncestors));
      if (!outcome.ok) return Result.err(outcome.error);
      cloned.push(outcome.value);
    }
    return Result.ok(cloned);
  }
  const inspected = resultOutcome(
    captureAgentOperation(() => ({
      prototype: Object.getPrototypeOf(value),
      symbols: Object.getOwnPropertySymbols(value),
      descriptors: Object.getOwnPropertyDescriptors(value),
    })),
  );
  if (!inspected.ok) {
    rethrowAgentPanic(inspected.error);
    return Result.err(
      new SteeringMessageCloneFailed({
        cause: inspected.error,
        message: `reflective message inspection failed: ${errorMessage(inspected.error)}`,
      }),
    );
  }
  const { prototype, symbols, descriptors } = inspected.value;
  if (prototype !== Object.prototype && prototype !== null) {
    return Result.err(
      new SteeringMessageCloneFailed({
        message: `unsupported object prototype '${prototype?.constructor?.name ?? "unknown"}'`,
      }),
    );
  }
  if (symbols.length > 0) {
    return Result.err(
      new SteeringMessageCloneFailed({ message: "symbol-keyed properties are unsupported" }),
    );
  }
  const cloned: Record<string, OpaqueAgentValue> = prototype === null ? { __proto__: null } : {};
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (!descriptor.enumerable) {
      return Result.err(
        new SteeringMessageCloneFailed({
          message: `non-enumerable property '${key}' is unsupported`,
        }),
      );
    }
    if (!("value" in descriptor)) {
      return Result.err(
        new SteeringMessageCloneFailed({ message: `accessor property '${key}' is unsupported` }),
      );
    }
    const property = resultOutcome(cloneSteeringValue(descriptor.value, nestedAncestors));
    if (!property.ok) return Result.err(property.error);
    Object.defineProperty(cloned, key, {
      value: property.value,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return Result.ok(cloned);
}

function isClonedModelMessage(value: unknown): value is ModelMessage {
  return (
    typeof value === "object" &&
    value !== null &&
    "role" in value &&
    typeof value.role === "string" &&
    ["system", "user", "assistant", "tool"].includes(value.role)
  );
}

export function cloneAgentMessage(
  message: ModelMessage,
): ResultType<ModelMessage, SteeringMessageCloneFailed> {
  const cloned = cloneSteeringValue(message, new Set());
  const outcome = resultOutcome(cloned);
  if (!outcome.ok) return Result.err(outcome.error);
  if (!isClonedModelMessage(outcome.value)) {
    return Result.err(
      new SteeringMessageCloneFailed({ message: "cloned message lost its valid role" }),
    );
  }
  return Result.ok(outcome.value);
}

export function snapshotAgentMessage(message: ModelMessage): ModelMessage {
  const outcome = resultOutcome(cloneAgentMessage(message));
  if (outcome.ok) return outcome.value;
  throw new Error("Cannot snapshot canonical agent message", { cause: outcome.error });
}
