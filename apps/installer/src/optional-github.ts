import { createPrivateKey } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { Result } from "better-result";
import { z } from "zod";

import { savedFile, stageFile, validatedText } from "./optional-input";
import type { Prompt, SetupDraft } from "./types";

const savedUserTokenSchema = z.object({
  type: z.literal("github_user_token"),
  token: z.string().min(1),
  host: z.string().optional(),
  apiBaseUrl: z.string().optional(),
});

const savedAppSchema = z.object({
  type: z.literal("github_app"),
  appId: z.number().int().positive(),
  installationId: z.number().int().positive(),
  host: z.string().optional(),
  apiBaseUrl: z.string().optional(),
});

async function readSavedJson<T>(
  draft: SetupDraft,
  relativePath: string,
  schema: z.ZodType<T>,
): Promise<T | undefined> {
  const content = await savedFile(draft, relativePath);
  if (content === undefined) return undefined;
  return Result.try({
    try: (): unknown => JSON.parse(content),
    catch: () => "invalid-json" as const,
  }).match({
    ok: (value) => {
      const decoded = schema.safeParse(value);
      return decoded.success ? decoded.data : undefined;
    },
    err: () => undefined,
  });
}

function validateGithubHost(value: string): string | undefined {
  if (!/^[a-zA-Z0-9.-]+(?::[0-9]+)?$/.test(value) || !URL.canParse(`https://${value}`)) {
    return "Enter a GitHub hostname, such as github.com, without a scheme or path.";
  }
  return undefined;
}

function validateId(value: string): string | undefined {
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) <= 0) {
    return "Enter a positive numeric ID.";
  }
  return undefined;
}

async function privateKey(prompt: Prompt): Promise<string> {
  for (;;) {
    const filename = await prompt.text({ message: "GitHub App private key file", required: true });
    const absolutePath = filename.startsWith("~/") ? join(homedir(), filename.slice(2)) : filename;
    const content = (
      await Result.tryPromise({
        try: () => Bun.file(absolutePath).text(),
        catch: () => "unreadable-key" as const,
      })
    ).match({ ok: (value) => value, err: () => undefined });
    if (!content) {
      prompt.note(
        "The private key file could not be read. Choose the PEM downloaded from your GitHub App settings.",
      );
      continue;
    }
    const valid = Result.try({
      try: () => createPrivateKey(content).asymmetricKeyType === "rsa",
      catch: () => "invalid-key" as const,
    }).match({ ok: (value) => value, err: () => false });
    if (!valid) {
      prompt.note("The file must contain an unencrypted RSA private key in PEM format.");
      continue;
    }
    return content;
  }
}

function githubApiBaseUrl(
  host: string,
  current: { host?: string; apiBaseUrl?: string } | undefined,
): string {
  if (host === current?.host && current.apiBaseUrl) return current.apiBaseUrl;
  if (host === "github.com") return "https://api.github.com";
  return `https://${host}/api/v3`;
}

async function configureUserToken(prompt: Prompt, draft: SetupDraft): Promise<void> {
  const current = await readSavedJson(draft, "secret/github-user-token.json", savedUserTokenSchema);
  const token = await prompt.text({
    message: "GitHub personal access token",
    initial: current?.token,
    secret: true,
    required: true,
  });
  const host = await validatedText(
    prompt,
    "GitHub hostname",
    current?.host ?? "github.com",
    validateGithubHost,
  );
  const apiBaseUrl = githubApiBaseUrl(host, current);
  stageFile(draft, {
    relativePath: "secret/github-user-token.json",
    content: `${JSON.stringify({ type: "github_user_token", token, host, apiBaseUrl }, null, 2)}\n`,
    mode: 0o600,
  });
}

async function configureApp(prompt: Prompt, draft: SetupDraft): Promise<void> {
  const current = await readSavedJson(draft, "secret/github-app.json", savedAppSchema);
  prompt.note(
    "GitHub App access uses an App ID, installation ID, and private key. Lilac creates short-lived installation tokens from these credentials.",
  );
  const appId = Number(
    await validatedText(prompt, "GitHub App ID", current?.appId.toString() ?? "", validateId),
  );
  const installationId = Number(
    await validatedText(
      prompt,
      "GitHub App installation ID",
      current?.installationId.toString() ?? "",
      validateId,
    ),
  );
  const host = await validatedText(
    prompt,
    "GitHub hostname",
    current?.host ?? "github.com",
    validateGithubHost,
  );
  const existingKey = await savedFile(draft, "secret/github-app.private-key.pem");
  const keepKey =
    Boolean(existingKey) &&
    (await prompt.confirm("Keep the existing GitHub App private key?", true));
  const pem = keepKey && existingKey ? existingKey : await privateKey(prompt);
  const apiBaseUrl = githubApiBaseUrl(host, current);
  stageFile(draft, {
    relativePath: "secret/github-app.private-key.pem",
    content: pem,
    mode: 0o600,
  });
  stageFile(draft, {
    relativePath: "secret/github-app.json",
    content: `${JSON.stringify({ type: "github_app", appId, installationId, host, apiBaseUrl, privateKeyPath: "/data/secret/github-app.private-key.pem" }, null, 2)}\n`,
    mode: 0o600,
  });
}

export async function configureGithub(prompt: Prompt, draft: SetupDraft): Promise<void> {
  const method = await prompt.select(
    "GitHub authentication",
    [
      { value: "pat", label: "Personal access token" },
      { value: "app", label: "GitHub App" },
      { value: "both", label: "Personal access token and GitHub App" },
      { value: "back", label: "Back without changes" },
    ],
    "back",
  );
  if (method === "back") return;
  if (method === "pat" || method === "both") await configureUserToken(prompt, draft);
  if (method === "app" || method === "both") await configureApp(prompt, draft);
}
