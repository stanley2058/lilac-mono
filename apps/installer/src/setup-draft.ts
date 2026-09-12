import type { SetupDraft } from "./types";

export function setSetupSecret(draft: SetupDraft, name: string, value: string): void {
  draft.secrets[name] = value;
  draft.configuredEnvironmentKeys?.add(name);
}
