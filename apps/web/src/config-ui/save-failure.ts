import { ORPCError } from "@orpc/client";
import { uiError } from "../components/ui";

export type SaveFailure = { readonly conflict: boolean; readonly message: string };

/** Classifies a failed config save; Core reports a stale revision as `CONFLICT`. */
export function decodeSaveFailure(cause: unknown): SaveFailure {
  return {
    conflict: cause instanceof ORPCError && cause.code === "CONFLICT",
    message: uiError(cause),
  };
}
