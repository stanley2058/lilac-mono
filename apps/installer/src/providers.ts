import { Result, TaggedError, type Result as ResultType } from "better-result";
import { z } from "zod";

import {
  decodeCodexTokens,
  startCodexOAuthLogin,
  type CodexOAuthLoginWithResult,
  type StartCodexOAuthLoginOptions,
} from "../../../packages/utils/codex-oauth";
import {
  MODEL_REASONING_EFFORTS,
  type ModelReasoningEffort,
} from "../../../packages/utils/core-config/types";
import { setSetupSecret } from "./setup-draft";
import type { Prompt, SetupDraft } from "./types";

export const PROVIDERS = [
  {
    id: "openai",
    label: "OpenAI API",
    key: "OPENAI_API_KEY",
    baseEnv: "OPENAI_BASE_URL",
    base: "https://api.openai.com/v1",
    main: "gpt-5.6-sol",
    fast: "gpt-5.6-luna",
    mainReasoning: "medium",
    fastReasoning: "low",
  },
  {
    id: "codex",
    label: "OpenAI OAuth / Codex",
    key: "",
    baseEnv: "",
    base: "",
    main: "gpt-5.6-sol",
    fast: "gpt-5.6-luna",
    mainReasoning: "medium",
    fastReasoning: "low",
  },
  {
    id: "anthropic",
    label: "Anthropic API",
    key: "ANTHROPIC_API_KEY",
    baseEnv: "ANTHROPIC_BASE_URL",
    base: "https://api.anthropic.com/v1",
    main: "opus-5",
    fast: "sonnet-5",
    mainReasoning: "medium",
    fastReasoning: "medium",
  },
  {
    id: "vercel",
    label: "Vercel AI Gateway",
    key: "AI_GATEWAY_API_KEY",
    baseEnv: "AI_GATEWAY_BASE_URL",
    base: "https://ai-gateway.vercel.sh/v1",
    main: "openai/gpt-5.6-sol",
    fast: "openai/gpt-5.6-luna",
    mainReasoning: "medium",
    fastReasoning: "low",
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    key: "OPENROUTER_API_KEY",
    baseEnv: "OPENROUTER_BASE_URL",
    base: "https://openrouter.ai/api/v1",
    main: "openai/gpt-5.6-sol",
    fast: "openai/gpt-5.6-luna",
    mainReasoning: "medium",
    fastReasoning: "low",
  },
  {
    id: "xai",
    label: "xAI API",
    key: "XAI_API_KEY",
    baseEnv: "XAI_BASE_URL",
    base: "https://api.x.ai/v1",
    main: "grok-4.6",
    fast: "grok-4.5",
    mainReasoning: "high",
    fastReasoning: "medium",
  },
  {
    id: "cerebras",
    label: "Cerebras",
    key: "CEREBRAS_API_KEY",
    baseEnv: "",
    base: "https://api.cerebras.ai/v1",
    main: "",
    fast: "",
    mainReasoning: "provider-default",
    fastReasoning: "provider-default",
  },
  {
    id: "groq",
    label: "Groq",
    key: "GROQ_API_KEY",
    baseEnv: "GROQ_BASE_URL",
    base: "https://api.groq.com/openai/v1",
    main: "",
    fast: "",
    mainReasoning: "provider-default",
    fastReasoning: "provider-default",
  },
  {
    id: "openai-compatible",
    label: "OpenAI-compatible",
    key: "OPENAI_COMPATIBLE_API_KEY",
    baseEnv: "OPENAI_COMPATIBLE_BASE_URL",
    base: "",
    main: "",
    fast: "",
    mainReasoning: "provider-default",
    fastReasoning: "provider-default",
  },
] as const;

export type ProviderId = (typeof PROVIDERS)[number]["id"];
type Provider = (typeof PROVIDERS)[number];
type Model = { model: string; reasoning: ModelReasoningEffort };
type ProviderModels = { id: ProviderId; main: Model; fast: Model };
export type SetupFetch = (url: string, init?: RequestInit) => Promise<Response>;
type ProviderDependencies = {
  fetch?: SetupFetch;
  startOAuth?: (options: StartCodexOAuthLoginOptions) => Promise<CodexOAuthLoginWithResult>;
};

export class ProviderCheckFailed extends TaggedError("ProviderCheckFailed")<{
  message: string;
}> {}

const httpUrlSchema = z.url().refine((value) => {
  const url = new URL(value);
  return (
    (url.protocol === "https:" || url.protocol === "http:") &&
    !url.username &&
    !url.password &&
    !url.search &&
    !url.hash
  );
});

export async function validateProvider(
  id: Exclude<ProviderId, "codex">,
  key: string,
  baseUrl: string,
  fetchFn: SetupFetch = fetch,
): Promise<ResultType<void, ProviderCheckFailed>> {
  if (!httpUrlSchema.safeParse(baseUrl).success) {
    return Result.err(
      new ProviderCheckFailed({
        message:
          "Enter an HTTP or HTTPS API base URL without embedded credentials, query parameters, or a fragment.",
      }),
    );
  }
  let endpoint = "models";
  if (id === "openrouter") endpoint = "key";
  if (id === "vercel") endpoint = "credits";
  const headers: Record<string, string> = { Accept: "application/json" };
  if (key) headers.Authorization = `Bearer ${key}`;
  if (id === "anthropic") {
    delete headers.Authorization;
    headers["x-api-key"] = key;
    headers["anthropic-version"] = "2023-06-01";
  }
  const checkUrl = new URL(`${baseUrl.replace(/\/$/, "")}/${endpoint}`);
  if (checkUrl.hostname === "host.docker.internal") checkUrl.hostname = "localhost";
  const requested = await Result.tryPromise({
    try: () =>
      fetchFn(checkUrl.toString(), {
        headers,
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
      }),
    catch: () =>
      new ProviderCheckFailed({
        message:
          "Could not reach the provider. Check the API base URL and network connection, then retry.",
      }),
  });
  return requested.andThen((response) => {
    if (response.ok) return Result.ok(undefined);
    if (response.status === 401 || response.status === 403)
      return Result.err(
        new ProviderCheckFailed({
          message: "The provider rejected these credentials. Check the key and its permissions.",
        }),
      );
    return Result.err(
      new ProviderCheckFailed({
        message: `Provider check returned HTTP ${response.status}. Check the endpoint or retry when the provider is available.`,
      }),
    );
  });
}

async function configureApi(
  prompt: Prompt,
  draft: SetupDraft,
  provider: Exclude<Provider, { id: "codex" }>,
  fetchFn: SetupFetch,
): Promise<boolean> {
  let key = draft.secrets[provider.key] ?? "";
  let baseUrl = draft.secrets[provider.baseEnv] ?? provider.base;
  while (true) {
    if (provider.id === "openai-compatible") {
      const nextBaseUrl = await prompt.text({
        message: "API base URL, including /v1 where required",
        initial: baseUrl,
        required: true,
      });
      if (nextBaseUrl.replace(/\/$/, "") !== baseUrl.replace(/\/$/, "")) {
        key = "";
        prompt.note(
          "Enter an API key for this endpoint, or leave it blank for a local server without authentication.",
        );
      }
      baseUrl = nextBaseUrl;
      prompt.note(
        "Use an address reachable from the Docker container. For a service on this machine, use host.docker.internal instead of localhost. The service must listen on an interface reachable from Docker, not only the host's loopback address.",
      );
    }
    key = await prompt.text({
      message: `${provider.label} API key${provider.id === "openai-compatible" ? " (optional for local servers)" : ""}`,
      initial: key,
      secret: true,
      required: provider.id !== "openai-compatible",
    });
    const checked = await validateProvider(provider.id, key, baseUrl, fetchFn);
    const issue = checked.match({ ok: () => undefined, err: (error) => error.message });
    if (issue) {
      prompt.note(issue);
      if (await prompt.confirm("Retry this provider?", true)) continue;
      return false;
    }
    setSetupSecret(draft, provider.key, key);
    if (provider.id === "openai-compatible") setSetupSecret(draft, provider.baseEnv, baseUrl);
    prompt.note(`${provider.label} connection checked.`);
    return true;
  }
}

function readExistingCodexLogin(serialized: string | undefined) {
  return decodeCodexTokens({
    serialized: serialized ?? null,
    storagePath: "secret/codex.json",
  }).map((decoded) => decoded.value !== null);
}

async function codexContents(draft: SetupDraft): Promise<string | undefined> {
  const staged = draft.files.findLast((file) => file.relativePath === "secret/codex.json");
  if (staged) return staged.content;
  return draft.readExistingFile("secret/codex.json");
}

async function configureCodex(
  prompt: Prompt,
  draft: SetupDraft,
  startOAuth: NonNullable<ProviderDependencies["startOAuth"]>,
): Promise<boolean> {
  const existing = await codexContents(draft);
  const decoded = readExistingCodexLogin(existing);
  const hasTokens = decoded.match({ ok: (value) => value, err: () => false });
  if (hasTokens && (await prompt.confirm("Keep the existing Codex login?", true))) return true;
  let stagedTokens: string | undefined;
  const started = await Result.tryPromise({
    try: () =>
      startOAuth({
        callbackServer: "optional",
        storagePath: `${draft.stagingDir}/secret/codex.json`,
        writeTokens: async (tokens) => {
          stagedTokens = `${JSON.stringify(tokens, null, 2)}\n`;
        },
      }),
    catch: () =>
      new ProviderCheckFailed({
        message: "Could not start Codex login. Retry or choose another provider.",
      }),
  });
  const login = started.match<CodexOAuthLoginWithResult | ProviderCheckFailed>({
    ok: (value) => value,
    err: (error) => error,
  });
  if (ProviderCheckFailed.is(login)) {
    prompt.note(login.message);
    return false;
  }
  const loginOwner = { [Symbol.asyncDispose]: () => login.close() };
  await using _login = loginOwner;
  prompt.note(
    `Open this link to sign in with OpenAI:\n${login.authorizeUrl}\nAfter signing in, press Enter here. If you are using SSH, paste the full localhost callback URL from your browser. Enter cancel to choose another provider.`,
  );
  let callbackIssue: string | undefined;
  const completion = Result.tryPromise({
    try: () => login.result,
    catch: () =>
      new ProviderCheckFailed({ message: "The browser login failed. Start the login again." }),
  });
  void completion.then((result) => {
    callbackIssue = result.match({ ok: () => undefined, err: (error) => error.message });
  });
  while (true) {
    const callbackUrl = await prompt.text({
      message: "Codex callback URL, or Enter when signed in",
      secret: true,
    });
    if (callbackUrl === "cancel") return false;
    if (callbackIssue) {
      prompt.note(callbackIssue);
      return false;
    }
    if (callbackUrl && !stagedTokens) {
      const exchanged = await login.exchangeResult({ callbackUrl });
      const issue = exchanged.match({
        ok: () => undefined,
        err: () =>
          "Could not finish login. Paste the complete callback URL from this login attempt.",
      });
      if (issue) {
        prompt.note(issue);
        continue;
      }
    }
    if (!stagedTokens) {
      prompt.note("Login is still pending. Complete the browser flow, or paste its callback URL.");
      continue;
    }
    const file = { relativePath: "secret/codex.json", content: stagedTokens, mode: 0o600 };
    const previous = draft.files.findIndex((entry) => entry.relativePath === file.relativePath);
    if (previous < 0) draft.files.push(file);
    else draft.files[previous] = file;
    prompt.note("Codex login complete. Credentials will be saved when you confirm installation.");
    return true;
  }
}

function existingModel(
  draft: SetupDraft,
  slot: "main" | "fast",
  provider: Provider,
): Model | undefined {
  const reference = draft.get(["models", slot, "model"]);
  if (typeof reference !== "string") return undefined;
  const model = reference.includes("/")
    ? reference
    : draft.get(["models", "def", reference, "model"]);
  if (typeof model !== "string" || !model.startsWith(`${provider.id}/`)) return undefined;
  const reasoning = z
    .enum(MODEL_REASONING_EFFORTS)
    .safeParse(
      draft.get(["models", slot, "reasoning"]) ??
        draft.get(["models", "def", reference, "reasoning"]),
    );
  return {
    model: model.slice(provider.id.length + 1),
    reasoning: reasoning.data ?? "provider-default",
  };
}

async function promptModel(
  prompt: Prompt,
  provider: Provider,
  slot: "main" | "fast",
  initial: Model,
  fallback?: Model,
): Promise<Model> {
  const slug = await prompt.text({
    message: `${provider.label} ${slot} model slug${fallback && !initial.model ? " (blank uses main)" : ""}`,
    initial: initial.model || undefined,
    required: !fallback,
  });
  if (!slug && fallback) return fallback;
  const reasoning = await prompt.select(
    `${slot === "main" ? "Main" : "Fast"} model reasoning`,
    MODEL_REASONING_EFFORTS.map((value) => ({ value, label: value })),
    initial.reasoning,
  );
  return { model: slug.replace(new RegExp(`^${provider.id}/`), ""), reasoning };
}

async function currentProviderModels(draft: SetupDraft): Promise<ProviderModels[]> {
  const configured: ProviderModels[] = [];
  for (const provider of PROVIDERS) {
    const main = existingModel(draft, "main", provider);
    const fast = existingModel(draft, "fast", provider);
    if (!main && !fast) continue;
    const authenticated =
      provider.id === "codex"
        ? readExistingCodexLogin(await codexContents(draft)).match({
            ok: (value) => value,
            err: () => false,
          })
        : Boolean(
            draft.secrets[provider.key] ||
            (provider.id === "openai-compatible" && draft.secrets[provider.baseEnv]),
          );
    if (!authenticated) continue;
    configured.push({
      id: provider.id,
      main: main ?? { model: provider.main || fast!.model, reasoning: provider.mainReasoning },
      fast: fast ?? { model: provider.fast || main!.model, reasoning: provider.fastReasoning },
    });
  }
  return configured;
}

export async function configureProviders(
  prompt: Prompt,
  draft: SetupDraft,
  dependencies: ProviderDependencies = {},
): Promise<void> {
  const configured = await currentProviderModels(draft);
  while (true) {
    const choices: { value: ProviderId | "done"; label: string }[] = PROVIDERS.map((provider) => ({
      value: provider.id,
      label: `${provider.label}${configured.some((entry) => entry.id === provider.id) ? " (configured)" : ""}`,
    }));
    if (configured.length)
      choices.push({ value: "done", label: "Continue with configured providers" });
    const selected = await prompt.select(
      "Model provider",
      choices,
      configured.length ? "done" : undefined,
    );
    if (selected === "done") break;
    const provider = PROVIDERS.find((entry) => entry.id === selected)!;
    const authenticated =
      provider.id === "codex"
        ? await configureCodex(prompt, draft, dependencies.startOAuth ?? startCodexOAuthLogin)
        : await configureApi(prompt, draft, provider, dependencies.fetch ?? fetch);
    if (!authenticated) continue;
    const main = await promptModel(
      prompt,
      provider,
      "main",
      existingModel(draft, "main", provider) ?? {
        model: provider.main,
        reasoning: provider.mainReasoning,
      },
    );
    const fast = await promptModel(
      prompt,
      provider,
      "fast",
      existingModel(draft, "fast", provider) ?? {
        model: provider.fast,
        reasoning: provider.fastReasoning,
      },
      provider.fast ? undefined : main,
    );
    const models = { id: provider.id, main, fast };
    const index = configured.findIndex((entry) => entry.id === provider.id);
    if (index < 0) configured.push(models);
    else configured[index] = models;
  }
  for (const slot of ["main", "fast"] as const) {
    const choices = configured.map((entry) => ({
      value: entry.id,
      label: `${entry.id}/${entry[slot].model} (${entry[slot].reasoning})`,
    }));
    const current = draft.get(["models", slot, "model"]);
    const currentDefinition =
      typeof current === "string" ? draft.get(["models", "def", current, "model"]) : undefined;
    const previousModel = currentDefinition ?? current;
    const previous = choices.find(
      (choice) => typeof previousModel === "string" && previousModel.startsWith(`${choice.value}/`),
    );
    const selected =
      configured.length === 1
        ? configured[0]!.id
        : await prompt.select(
            `Use which provider for the ${slot} model?`,
            choices,
            previous?.value,
          );
    const chosen = configured.find((entry) => entry.id === selected)!;
    const selectedModel = `${chosen.id}/${chosen[slot].model}`;
    const providerChanged =
      typeof previousModel === "string" && !previousModel.startsWith(`${chosen.id}/`);
    const hasCustomOptions =
      draft.get(["models", slot, "options"]) !== undefined ||
      draft.get(["models", slot, "fallback"]) !== undefined;
    if (providerChanged && hasCustomOptions) await confirmProviderOptions(prompt, draft, slot);
    if (currentDefinition !== selectedModel) draft.set(["models", slot, "model"], selectedModel);
    draft.set(["models", slot, "reasoning"], chosen[slot].reasoning);
  }
}

async function confirmProviderOptions(
  prompt: Prompt,
  draft: SetupDraft,
  slot: "main" | "fast",
): Promise<void> {
  prompt.note(
    `The existing ${slot} model options and fallbacks may only work with the previous provider.`,
  );
  if (
    await prompt.confirm(
      `Keep custom ${slot} options and fallbacks after changing provider?`,
      false,
    )
  )
    return;
  draft.remove(["models", slot, "options"]);
  draft.remove(["models", slot, "fallback"]);
}
