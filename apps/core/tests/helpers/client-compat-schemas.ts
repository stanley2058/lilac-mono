import {
  getEventIteratorSchemaDetails,
  isContractProcedure,
  type AnyContractRouter,
} from "@orpc/contract";
import type { CachePatch, ThreadCheckpoint } from "../../../../packages/client/src/cache";
import { z } from "zod";
import * as protocol from "../../../../packages/client-protocol/src";

// These describe the TypeScript-only cache envelopes in packages/client/src/cache.ts.
const cachedSlot = z.strictObject({
  revision: protocol.revisionSchema,
  slot: protocol.turnSlotSchema,
});
export const cachePatchSchema = z.strictObject({
  checkpoint: protocol.replayCheckpointSchema,
  replace: z.boolean(),
  put: z.array(cachedSlot),
  remove: z.array(z.string()),
}) satisfies z.ZodType<CachePatch>;
export const cacheRowSchema = z.strictObject({
  checkpoint: protocol.replayCheckpointSchema,
  slots: z.array(cachedSlot),
}) satisfies z.ZodType<ThreadCheckpoint>;

export function compatSchemas(): Record<string, z.ZodType> {
  const schemas: Record<string, z.ZodType> = {
    bootstrap: protocol.bootstrapReplySchema,
    cachePatch: cachePatchSchema,
    cacheRow: cacheRowSchema,
  };
  for (const [name, schema] of Object.entries(protocol)) {
    if (schema instanceof z.ZodType) schemas[name] = schema;
  }
  function visit(router: AnyContractRouter, path: string[] = []) {
    if (isContractProcedure(router)) {
      const output = router["~orpc"].outputSchema;
      const events = getEventIteratorSchemaDetails(output);
      const schema = events?.yields ?? output;
      if (!(schema instanceof z.ZodType)) throw new Error(`Unsupported output: ${path.join(".")}`);
      schemas[path.join(".")] = schema;
      return;
    }
    for (const [name, child] of Object.entries(router)) visit(child, [...path, name]);
  }
  visit(protocol.nativeContract);
  return schemas;
}
