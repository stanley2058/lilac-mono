import { z } from "zod";

export * from "@stanley2058/lilac-core/tool-server/client-protocol";

export const onboardingGpgGenerateSchema = z.object({ fingerprint: z.string().min(1) });
export const onboardingGpgExportSchema = z.object({ publicKeyArmored: z.string().optional() });
