import type { Prompt, SetupDraft, SetupFile } from "./types";
import { setSetupSecret } from "./setup-draft";

export function currentString(draft: SetupDraft, path: string[], fallback = ""): string {
  const value = draft.get(path);
  return typeof value === "string" ? value : fallback;
}

export function currentBoolean(draft: SetupDraft, path: string[], fallback = false): boolean {
  const value = draft.get(path);
  return typeof value === "boolean" ? value : fallback;
}

export function stageFile(draft: SetupDraft, file: SetupFile): void {
  const index = draft.files.findIndex((existing) => existing.relativePath === file.relativePath);
  if (index < 0) {
    draft.files.push(file);
    return;
  }
  draft.files[index] = file;
}

export async function savedFile(
  draft: SetupDraft,
  relativePath: string,
): Promise<string | undefined> {
  const staged = draft.files.find((file) => file.relativePath === relativePath);
  if (staged) return staged.content;
  return draft.readExistingFile(relativePath);
}

export async function validatedText(
  prompt: Prompt,
  message: string,
  initial: string,
  validate: (value: string) => string | undefined,
): Promise<string> {
  for (;;) {
    const value = (await prompt.text({ message, initial, required: true })).trim();
    const error = validate(value);
    if (!error) return value;
    prompt.note(error);
  }
}

export function validateHttpUrl(value: string): string | undefined {
  if (!URL.canParse(value)) return "Enter an absolute HTTP or HTTPS URL.";
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return "Use an HTTP or HTTPS URL.";
  }
  if (url.username || url.password) return "Keep credentials out of the URL.";
  return undefined;
}

export async function credential(
  prompt: Prompt,
  draft: SetupDraft,
  name: string,
  label: string,
): Promise<void> {
  const value = await prompt.text({
    message: label,
    initial: draft.secrets[name],
    secret: true,
    required: true,
  });
  setSetupSecret(draft, name, value);
}
