import { z } from "zod";

import { configureComputerUse } from "./optional-computer";
import { configureGithub } from "./optional-github";
import {
  credential,
  currentBoolean,
  currentString,
  validatedText,
  validateHttpUrl,
} from "./optional-input";
import type { Prompt, SetupDraft } from "./types";

const webProviderSchema = z.enum(["firecrawl", "exa", "tavily"]);
type WebProvider = z.infer<typeof webProviderSchema>;

const WEB_PROVIDERS: Record<WebProvider, { name: string; environment: string }> = {
  firecrawl: { name: "Firecrawl", environment: "FIRECRAWL_API_KEY" },
  exa: { name: "Exa", environment: "EXA_API_KEY" },
  tavily: { name: "Tavily", environment: "TAVILY_API_KEY" },
};

async function configureBlobStorage(prompt: Prompt, draft: SetupDraft): Promise<void> {
  const currentKind = draft.get(["blobStorage", "kind"]);
  const choice = await prompt.select(
    "Blob storage",
    [
      { value: "local", label: "Filesystem in the Lilac data directory" },
      { value: "s3", label: "S3-compatible bucket" },
      { value: "back", label: "Back without changes" },
    ],
    currentKind === "s3" ? "s3" : "local",
  );
  if (choice === "back") return;
  const previousKind = currentKind === "s3" ? "s3" : "local";
  if (
    choice !== previousKind &&
    (currentKind !== undefined || (await draft.readExistingFile("core-config.yaml")) !== undefined)
  ) {
    prompt.note(
      "Changing blob storage does not copy existing objects. Existing conversations may still reference objects in the previous store.",
    );
    if (!(await prompt.confirm("Switch this installation's blob storage backend?", false))) return;
  }
  if (choice === "local") {
    if (currentKind !== "s3") return;
    draft.set(["blobStorage"], { kind: "local", root: "/data/blobs" });
    return;
  }

  const bucket = await prompt.text({
    message: "S3 bucket",
    initial: currentString(draft, ["blobStorage", "bucket"]),
    required: true,
  });
  const prefix = await prompt.text({
    message: "Object prefix",
    initial: currentString(draft, ["blobStorage", "prefix"], "lilac/blobs"),
    required: true,
  });
  const endpoint = await validatedText(
    prompt,
    "S3 endpoint URL",
    currentString(draft, ["blobStorage", "endpoint"]),
    validateHttpUrl,
  );
  const region = await prompt.text({
    message: "S3 region",
    initial: currentString(draft, ["blobStorage", "region"], "us-east-1"),
    required: true,
  });
  const accessKeyIdEnv = currentString(
    draft,
    ["blobStorage", "accessKeyIdEnv"],
    "LILAC_S3_ACCESS_KEY_ID",
  );
  const secretAccessKeyEnv = currentString(
    draft,
    ["blobStorage", "secretAccessKeyEnv"],
    "LILAC_S3_SECRET_ACCESS_KEY",
  );
  await credential(prompt, draft, accessKeyIdEnv, "S3 access key ID");
  await credential(prompt, draft, secretAccessKeyEnv, "S3 secret access key");
  const sessionTokenEnv = currentString(
    draft,
    ["blobStorage", "sessionTokenEnv"],
    "LILAC_S3_SESSION_TOKEN",
  );
  const useSessionToken = await prompt.confirm(
    "Use a temporary S3 session token?",
    Boolean(draft.secrets[sessionTokenEnv]),
  );
  if (useSessionToken) await credential(prompt, draft, sessionTokenEnv, "S3 session token");
  const forcePathStyle = await prompt.confirm(
    "Use path-style bucket URLs?",
    currentBoolean(draft, ["blobStorage", "forcePathStyle"], true),
  );
  draft.set(["blobStorage"], {
    kind: "s3",
    bucket,
    prefix,
    endpoint,
    region,
    accessKeyIdEnv,
    secretAccessKeyEnv,
    ...(useSessionToken ? { sessionTokenEnv } : {}),
    forcePathStyle,
  });
}

function configuredWebProviders(draft: SetupDraft): WebProvider[] {
  const decoded = z
    .array(webProviderSchema)
    .safeParse(draft.get(["tools", "web", "extract", "providers"]));
  return decoded.success ? [...new Set(decoded.data)] : [];
}

async function orderWebProviders(prompt: Prompt, providers: WebProvider[]): Promise<WebProvider[]> {
  const order = await validatedText(
    prompt,
    "Provider order, comma-separated",
    providers.join(", "),
    (value) => {
      const selected = value.split(",").map((part) => part.trim());
      if (
        selected.length !== providers.length ||
        new Set(selected).size !== providers.length ||
        !providers.every((provider) => selected.includes(provider))
      ) {
        return `Include each configured provider once: ${providers.join(", ")}.`;
      }
      return undefined;
    },
  );
  return order.split(",").map((part) => webProviderSchema.parse(part.trim()));
}

async function configureWebTools(prompt: Prompt, draft: SetupDraft): Promise<void> {
  let providers = configuredWebProviders(draft);
  let changed = false;
  for (;;) {
    const choices: { value: WebProvider | "order" | "done"; label: string }[] =
      webProviderSchema.options.map((value) => {
        const provider = WEB_PROVIDERS[value];
        return {
          value,
          label: draft.secrets[provider.environment]
            ? `${provider.name} (configured)`
            : provider.name,
        };
      });
    if (providers.length > 1) choices.push({ value: "order", label: "Set provider order" });
    choices.push({ value: "done", label: "Done with web tools" });
    const choice = await prompt.select("Web tools providers", choices, "done");
    if (choice === "done") break;
    if (choice === "order") {
      providers = await orderWebProviders(prompt, providers);
      changed = true;
      continue;
    }
    const provider = WEB_PROVIDERS[choice];
    await credential(prompt, draft, provider.environment, `${provider.name} API key`);
    if (!providers.includes(choice)) providers.push(choice);
    changed = true;
    prompt.note(`Provider order: ${providers.join(", ")}.`);
  }
  if (!changed) return;
  draft.set(["tools", "web", "extract", "providers"], providers);
  draft.set(["tools", "web", "fetch", "mode"], "provider-only");
}

async function configureConversationThreads(prompt: Prompt, draft: SetupDraft): Promise<void> {
  const base = ["conversation", "thread"];
  prompt.note(
    "Thread summaries and related-thread lookup are experimental. Summaries use a chat model; semantic search also needs a provider that supports embeddings.",
  );
  const summaries = await prompt.confirm(
    "Enable background thread summaries?",
    currentBoolean(draft, [...base, "summarization", "enabled"], true),
  );
  draft.set([...base, "summarization", "enabled"], summaries);
  if (summaries) {
    const model = await prompt.text({
      message: "Thread summary model",
      initial: currentString(draft, [...base, "summarization", "model"], "fast"),
      required: true,
    });
    draft.set([...base, "summarization", "model"], model);
  }
  const embeddings = await prompt.confirm(
    "Enable semantic thread embeddings?",
    currentBoolean(draft, [...base, "embedding", "enabled"]),
  );
  draft.set([...base, "embedding", "enabled"], embeddings);
  if (embeddings) {
    const model = await prompt.text({
      message: "Embedding model (provider/model or model alias)",
      initial: currentString(
        draft,
        [...base, "embedding", "model"],
        "openai/text-embedding-3-small",
      ),
      required: true,
    });
    draft.set([...base, "embedding", "model"], model);
  }
  const autoInject = await prompt.confirm(
    "Automatically find related threads before replies?",
    currentBoolean(draft, [...base, "autoInject", "enabled"]),
  );
  draft.set([...base, "autoInject", "enabled"], autoInject);
  if (!autoInject) return;
  const model = await prompt.text({
    message: "Related-thread query planner model",
    initial: currentString(draft, [...base, "autoInject", "plannerModel"], "fast"),
    required: true,
  });
  draft.set([...base, "autoInject", "plannerModel"], model);
  if (!embeddings) {
    draft.set([...base, "autoInject", "mode"], "lexical");
    return;
  }
  const currentMode = z
    .enum(["hybrid", "semantic", "lexical"])
    .safeParse(draft.get([...base, "autoInject", "mode"]));
  const mode = await prompt.select(
    "Related-thread search",
    [
      { value: "hybrid", label: "Semantic and keyword search" },
      { value: "semantic", label: "Semantic search" },
      { value: "lexical", label: "Keyword search" },
    ],
    currentMode.success ? currentMode.data : "hybrid",
  );
  draft.set([...base, "autoInject", "mode"], mode);
}

async function configureEntityAliases(prompt: Prompt, draft: SetupDraft): Promise<void> {
  for (;;) {
    const kind = await prompt.select(
      "Entity aliases",
      [
        { value: "user", label: "Add or update a user alias" },
        { value: "channel", label: "Add or update a channel alias" },
        { value: "done", label: "Done with aliases" },
      ],
      "done",
    );
    if (kind === "done") return;
    const enteredAlias = await validatedText(prompt, "Alias name", "", (value) =>
      value.replace(/^[@#]+/, "").trim() ? undefined : "Enter an alias name.",
    );
    const alias = enteredAlias
      .replace(/^[@#]+/, "")
      .trim()
      .replace(/\s+/g, "_");
    const path =
      kind === "user" ? ["entity", "users", alias] : ["entity", "sessions", "discord", alias];
    const initialId = currentString(draft, path, currentString(draft, [...path, "discord"]));
    prompt.note(
      "Discord's Developer Mode lets you copy user and channel IDs from their context menus.",
    );
    const discord = await validatedText(
      prompt,
      kind === "user" ? "Discord user ID" : "Discord channel ID",
      initialId,
      (value) =>
        /^\d{17,20}$/.test(value) ? undefined : "Enter the numeric Discord ID, 17 to 20 digits.",
    );
    const comment = await prompt.text({
      message: "Alias description (optional)",
      initial: currentString(draft, [...path, "comment"]),
    });
    draft.set(path, { discord, ...(comment.trim() ? { comment: comment.trim() } : {}) });
    prompt.note(`${kind === "user" ? "@" : "#"}${alias} is selected.`);
  }
}

export async function configureOptional(prompt: Prompt, draft: SetupDraft): Promise<void> {
  for (;;) {
    const section = await prompt.select(
      "Optional setup",
      [
        {
          value: "computer",
          label: draft.computerEnabled ? "Computer use (enabled)" : "Computer use",
        },
        { value: "github", label: "GitHub integration" },
        { value: "blobs", label: "Blob storage" },
        { value: "web", label: "Web tools providers" },
        { value: "threads", label: "Conversation threads" },
        { value: "entities", label: "User and channel aliases" },
        { value: "done", label: "Continue to review / skip remaining" },
      ],
      "done",
    );
    switch (section) {
      case "computer":
        await configureComputerUse(prompt, draft);
        break;
      case "github":
        await configureGithub(prompt, draft);
        break;
      case "blobs":
        await configureBlobStorage(prompt, draft);
        break;
      case "web":
        await configureWebTools(prompt, draft);
        break;
      case "threads":
        await configureConversationThreads(prompt, draft);
        break;
      case "entities":
        await configureEntityAliases(prompt, draft);
        break;
      case "done":
        return;
    }
  }
}
