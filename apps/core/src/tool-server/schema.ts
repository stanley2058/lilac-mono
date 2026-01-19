import { z } from "zod";

export const BridgeListResponse = z.object({
  tools: z.array(
    z.object({
      callableId: z.string(),
      name: z.string(),
      description: z.string(),
      shortInput: z.array(z.string()),
    }),
  ),
});

export const BridgeFnHelpRequest = z.object({
  callableId: z.string(),
});

export const BridgeFnHelpResponse = z.object({
  callableId: z.string(),
  name: z.string(),
  description: z.string(),
  shortInput: z.array(z.string()),
  input: z.array(z.string()),
});

export const BridgeFnRequest = z.object({
  callableId: z.string(),
  input: z.record(z.string(), z.unknown()),
});

export const BridgeFnResponse = z.object({
  isError: z.boolean(),
  output: z.unknown(),
});
