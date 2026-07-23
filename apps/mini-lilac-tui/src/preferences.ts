import { mkdir, rename } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import { miniLilacReasoningSchema } from "@stanley2058/mini-lilac-client";
import { z } from "zod";

const bindingPreferenceSchema = z.object({
  model: z.string().min(1).optional(),
  profile: z.string().min(1).optional(),
  reasoning: miniLilacReasoningSchema.optional(),
});

const bindingPreferencesSchema = z.object({
  version: z.literal(1),
  servers: z.record(z.string(), bindingPreferenceSchema),
});

export type BindingPreference = z.infer<typeof bindingPreferenceSchema>;

export type BindingPreferences = z.infer<typeof bindingPreferencesSchema>;

export function bindingPreferenceServerKey(server: string): string {
  return server.replace(/\/+$/u, "");
}

export function bindingPreferencesPath(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const stateHome = env.XDG_STATE_HOME?.trim() || path.join(homedir(), ".local", "state");
  return path.join(stateHome, "mini-lilac", "preferences.json");
}

export async function loadBindingPreferences(filePath: string): Promise<BindingPreferences> {
  const file = Bun.file(filePath);
  if (!(await file.exists())) return { version: 1, servers: {} };
  return bindingPreferencesSchema.parse(await file.json());
}

export async function saveBindingPreferences(
  filePath: string,
  preferences: BindingPreferences,
): Promise<void> {
  const parsed = bindingPreferencesSchema.parse(preferences);
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await Bun.write(temporaryPath, `${JSON.stringify(parsed, null, 2)}\n`);
  await rename(temporaryPath, filePath);
}
