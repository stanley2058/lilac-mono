import { z } from "zod";

export const openAICompactionPartSchema = z
  .object({
    type: z.literal("custom"),
    kind: z.literal("openai.compaction"),
    providerOptions: z.unknown().optional(),
  })
  .passthrough();

export type OpenAICompactionPart = z.infer<typeof openAICompactionPartSchema>;

export const openAIMessagePhaseSchema = z.enum(["commentary", "final_answer"]);
export type OpenAIMessagePhase = z.infer<typeof openAIMessagePhaseSchema>;

const openAIMessagePhaseMetadataSchema = z.object({
  openai: z.object({ phase: openAIMessagePhaseSchema }),
});

export function openAIMessagePhase(value: unknown): OpenAIMessagePhase | undefined {
  const parsed = openAIMessagePhaseMetadataSchema.safeParse(value);
  return parsed.success ? parsed.data.openai.phase : undefined;
}

export function decodeOpenAICompactionPart(value: unknown): OpenAICompactionPart | undefined {
  const parsed = openAICompactionPartSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

/** Compatibility predicate for consumers that narrow AI SDK message parts. */
export function isOpenAICompactionPart(value: unknown): value is OpenAICompactionPart {
  return decodeOpenAICompactionPart(value) !== undefined;
}
