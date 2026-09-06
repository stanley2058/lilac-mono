import { z } from "zod";
import type { ResponsesServerEvent } from "openai/resources/responses/responses";

const ignoredFieldSchema = z.unknown().transform(() => undefined);
const optionalStringSchema = z.union([z.string(), ignoredFieldSchema]).optional();
const errorFieldsSchema = z.object({
  message: optionalStringSchema,
  code: optionalStringSchema,
  type: optionalStringSchema,
  param: optionalStringSchema,
});

const errorEnvelopeSchema = errorFieldsSchema.extend({
  error: z.union([errorFieldsSchema, ignoredFieldSchema]).optional(),
  status: z.union([z.number(), ignoredFieldSchema]).optional(),
  response: z
    .union([
      z.object({
        status: optionalStringSchema,
        error: z.union([errorFieldsSchema, ignoredFieldSchema]).optional(),
      }),
      ignoredFieldSchema,
    ])
    .optional(),
});

type ErrorEnvelope = z.infer<typeof errorEnvelopeSchema>;
type ResponseFailureDetails = {
  message: string;
  details: { code: string; type: string; param: string | null; statusCode?: number };
};

function decodeResponsesErrorFields(event: ResponsesServerEvent): ErrorEnvelope {
  const parsed = errorEnvelopeSchema.safeParse(event);
  return parsed.success ? parsed.data : {};
}

export function readResponsesStreamError(event: ResponsesServerEvent): ResponseFailureDetails {
  const fields = decodeResponsesErrorFields(event);
  const code = fields.error?.code ?? fields.code ?? "response_error";
  return {
    message: fields.error?.message ?? fields.message ?? "Response stream error",
    details: {
      code,
      type: fields.error?.type ?? code,
      param: fields.error?.param ?? fields.param ?? null,
      statusCode: fields.status,
    },
  };
}

export function readResponsesTerminalError(
  event: ResponsesServerEvent,
): ResponseFailureDetails | undefined {
  const fields = decodeResponsesErrorFields(event);
  const error = fields.response?.error ?? fields.error;
  const status = fields.response?.status;
  if (event.type !== "response.failed" && status !== "failed" && !error) return undefined;
  const code = error?.code ?? "response_failed";
  const fallback = status
    ? `Responses request failed (status=${status})`
    : "Responses request failed";
  return {
    message: error?.message ?? fallback,
    details: {
      code,
      type: error?.type ?? code,
      param: error?.param ?? null,
      statusCode: fields.status,
    },
  };
}
