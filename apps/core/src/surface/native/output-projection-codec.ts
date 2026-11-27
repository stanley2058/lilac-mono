import {
  displayPartSchema,
  identitySchema,
  revisionSchema,
} from "@stanley2058/lilac-client-protocol/replay";
import { z } from "zod";

const partProvenanceSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("text"),
    partIndex: revisionSchema,
    createdOrdinal: revisionSchema,
    incomplete: z.boolean().optional(),
  }),
  z.strictObject({
    kind: z.literal("data"),
    partIndex: revisionSchema,
    versions: z.array(z.strictObject({ ordinal: revisionSchema, part: displayPartSchema })).min(1),
  }),
]);
export const nativeOutputProjectionStateSchema = z.strictObject({
  version: z.literal(1),
  messages: z.array(
    z.strictObject({
      messageId: identitySchema,
      createdOrdinal: revisionSchema,
      initialPhase: z.enum(["commentary", "final"]).optional(),
      unspecifiedPhase: z.boolean().optional(),
      parts: z.array(partProvenanceSchema),
    }),
  ),
});
export type NativeOutputProjectionState = z.infer<typeof nativeOutputProjectionStateSchema>;
export type NativePartProvenance = z.infer<typeof partProvenanceSchema>;
