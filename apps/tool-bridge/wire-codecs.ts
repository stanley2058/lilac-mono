import type { ServerToolFailure } from "@stanley2058/lilac-plugin-runtime/types";
import { z } from "zod";

const jsonValueSchema = z.json();
const jsonObjectSchema = z.record(z.string(), jsonValueSchema);

const primaryPositionalSchema = z.object({
  field: z.string().min(1),
  variadic: z.boolean().optional(),
});

const toolOutputFullSchema = z.object({
  callableId: z.string().min(1),
  name: z.string(),
  description: z.string(),
  shortInput: z.array(z.string()),
  input: z.array(z.string()),
  primaryPositional: primaryPositionalSchema.optional(),
  hidden: z.boolean().optional(),
});

const toolListItemSchema = toolOutputFullSchema.omit({ input: true });

export const listPayloadSchema = z.object({
  tools: z.array(toolListItemSchema),
});

export const callableIdListPayloadSchema = z.object({
  tools: z.array(z.object({ callableId: z.string().min(1) })),
});

export const errorPayloadSchema = z.object({
  message: z.string().optional(),
  error: jsonValueSchema.optional(),
});

export const backendVersionPayloadSchema = z.object({
  ok: z.literal(true),
  version: z.string(),
  commit: z.string(),
  dirty: z.boolean().optional(),
  builtAt: z.string().optional(),
  plugins: z
    .object({
      loadedExternal: z.number().int().nonnegative(),
    })
    .optional(),
});

export const serverToolFailureSchema: z.ZodType<ServerToolFailure> = z
  .object({
    kind: z.enum([
      "usage",
      "not_found",
      "denied",
      "conflict",
      "timeout",
      "unavailable",
      "cancelled",
      "internal",
    ]),
    code: z.string().min(1),
    message: z.string(),
    retryable: z.boolean(),
    details: jsonValueSchema.optional(),
  })
  .strict();

export const toolCallPayloadSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("ok"), value: jsonValueSchema }).strict(),
  z.object({ status: z.literal("error"), error: serverToolFailureSchema }).strict(),
]);

export const onboardingGpgGenerateSchema = z.object({ fingerprint: z.string().min(1) });
export const onboardingGpgExportSchema = z.object({ publicKeyArmored: z.string().optional() });
export { jsonObjectSchema, jsonValueSchema, toolOutputFullSchema };
