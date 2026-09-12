import path from "node:path";
import { Result, TaggedError, type Result as ResultType } from "better-result";
import type { JSONValue } from "../../../packages/utils/core-config/types";
import { createPrompt } from "./prompt";
import { configureProviders } from "./providers";
import { configureDiscord } from "./discord";
import { configureOptional } from "./optional";
import {
  createConfigDocument,
  parseConfigDocument,
  getConfigValue,
  setConfigValue,
  deleteConfigValue,
  serializeConfigDocument,
  validateConfigDocument,
} from "./config-document";
import {
  composeArguments,
  readOptionalFile,
  parseDeployment,
  resolveImages,
  createDeployment,
  writeInstallation,
  startDeployment,
  validateDeploymentInputs,
} from "./deployment";
import { readSetupEnvironment } from "./environment";
import { inspectDeployment } from "./compose-inspection";
import type { Prompt, SetupDraft } from "./types";
import { readSetupFiles } from "./data-files";
import {
  captureInstallerException,
  isInstallerCancellation,
  withInstallerCleanup,
} from "./failure";

export class InstallerSetupFailed extends TaggedError("InstallerSetupFailed")<{
  readonly message: string;
}> {}

function redactConfig(value: JSONValue, secretValues: string[]): JSONValue {
  if (typeof value === "string") {
    let redacted = value;
    for (const secret of secretValues) {
      if (secret.length >= 4) redacted = redacted.replaceAll(secret, "[redacted]");
    }
    return redacted;
  }
  if (Array.isArray(value)) return value.map((entry) => redactConfig(entry, secretValues));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        /token|secret|password|api.?key|private.?key/i.test(key) && !key.endsWith("Env")
          ? "[redacted]"
          : redactConfig(entry ?? null, secretValues),
      ]),
    );
  }
  return value;
}

async function configureExisting(prompt: Prompt, draft: SetupDraft): Promise<void> {
  for (;;) {
    const section = await prompt.select(
      "Update configuration",
      [
        { value: "providers", label: "Models and providers" },
        { value: "discord", label: "Discord" },
        { value: "optional", label: "Optional integrations" },
        { value: "review", label: "Review changes" },
      ],
      "review",
    );
    if (section === "review") return;
    if (section === "providers") await configureProviders(prompt, draft);
    if (section === "discord") await configureDiscord(prompt, draft);
    if (section === "optional") await configureOptional(prompt, draft);
  }
}

export async function runWizard(
  stagingDir: string,
  installExecutable: boolean,
): Promise<
  ResultType<{ installed: boolean; root: string }, { message: string; cancelled: boolean }>
> {
  const prompt = createPrompt();
  let cancelled = false;
  const result = await Result.tryPromise({
    try: () =>
      withInstallerCleanup(
        () => configureInstallation(prompt, stagingDir, installExecutable),
        () => {
          cancelled = prompt.cancelled();
          prompt.close();
        },
      ),
    catch: captureInstallerException,
  });
  if (result.isErr()) {
    if (cancelled && isInstallerCancellation(result.error)) {
      return Result.err({ message: "Setup cancelled.", cancelled: true });
    }
    throw result.error;
  }
  return result
    .andThen((value) => value)
    .mapError((error) => ({ message: error.message, cancelled: false }));
}

async function configureInstallation(
  prompt: Prompt,
  stagingDir: string,
  installExecutable: boolean,
) {
  return Result.gen(async function* () {
    const root = path.resolve(
      await prompt.text({
        message: "Where should Lilac store its files?",
        initial: process.cwd(),
        required: true,
      }),
    );
    const dataDir = path.join(root, "data");
    const composeSource = await readOptionalFile(path.join(root, "compose.yaml"));
    const document =
      composeSource === undefined ? undefined : yield* parseDeployment(composeSource);
    const existing = document
      ? { document, resolved: yield* Result.await(inspectDeployment(root, document)) }
      : undefined;
    const images = resolveImages(existing?.resolved);
    const setupFiles = yield* Result.await(readSetupFiles(dataDir, images.core));
    const configSource = setupFiles["core-config.yaml"];
    const loaded = {
      exists: configSource !== undefined,
      document:
        configSource === undefined
          ? createConfigDocument()
          : yield* parseConfigDocument(configSource),
    };
    const secretsSource = await readOptionalFile(path.join(root, "secrets.env"));
    const environment = readSetupEnvironment(existing?.resolved, secretsSource);
    const draft: SetupDraft = {
      get: (key) => getConfigValue(loaded.document, key),
      set: (key, value) => setConfigValue(loaded.document, key, value),
      remove: (key) => deleteConfigValue(loaded.document, key),
      ...environment,
      configuredEnvironmentKeys: new Set(),
      files: [],
      stagingDir,
      readExistingFile: (filename) => Promise.resolve(setupFiles[filename]),
      computerEnabled: existing?.resolved.services["computer-use-gateway"] !== undefined,
    };
    let reinstall = false;
    if (existing || loaded.exists) {
      prompt.note(`Existing installation: ${root}`);
      const action = await prompt.select("What would you like to do?", [
        { value: "update", label: "Update configuration" },
        { value: "reinstall", label: "Reinstall containers, preserving configuration and data" },
        { value: "cancel", label: "Cancel" },
      ]);
      if (action === "cancel") return Result.ok({ installed: false, root });
      reinstall = action === "reinstall";
      if (!reinstall && loaded.document.get("configVersion") !== 2) {
        return Result.err(
          new InstallerSetupFailed({
            message:
              "Guided updates require configVersion: 2. Follow docs/core-config-migrations.md before updating this configuration. Reinstall can preserve the current version.",
          }),
        );
      }
      if (!reinstall) await configureExisting(prompt, draft);
    } else {
      await configureProviders(prompt, draft);
      await configureDiscord(prompt, draft);
      await configureOptional(prompt, draft);
    }

    yield* validateConfigDocument(loaded.document);
    yield* validateDeploymentInputs(draft, images, existing?.resolved);
    const deployment = createDeployment(
      root,
      draft,
      images,
      existing,
      draft.configuredEnvironmentKeys,
    );
    yield* composeArguments(root, deployment);
    const config = serializeConfigDocument(loaded.document);
    const current = getConfigValue(loaded.document, []);
    prompt.note("Review installation");
    prompt.note(`Directory: ${root}\nContainer UID: 1000\nCore image: ${images.core}`);
    if (draft.computerEnabled)
      prompt.note(`Computer gateway: ${images.gateway}\nComputer runner: ${images.runner}`);
    if (
      existing?.resolved.services.lilac.build ||
      existing?.resolved.services["computer-use-gateway"]?.build
    )
      prompt.note("Existing source builds will be replaced by the published images shown above.");
    prompt.note(
      Bun.YAML.stringify(redactConfig(current ?? {}, Object.values(draft.secrets)), null, 2),
    );
    prompt.note(
      `Credentials: ${Object.keys(draft.secrets).sort().join(", ") || "none"} (values hidden)`,
    );
    if (draft.files.length)
      prompt.note(`Additional files: ${draft.files.map((file) => file.relativePath).join(", ")}`);
    prompt.note(
      "Setup writes compose.yaml, secrets.env, and data/core-config.yaml. Existing data is preserved.",
    );
    const confirmed = await prompt.confirm("Write configuration and start Lilac?", false);
    if (!confirmed) {
      prompt.note("Cancelled. Installation files were not changed.");
      return Result.ok({ installed: false, root });
    }
    prompt.note("Preparing private data files for container UID 1000…");
    yield* Result.await(
      writeInstallation({
        root,
        draft,
        config,
        compose: deployment.toString(),
        installExecutable,
        image: images.core,
      }),
    );
    prompt.note("Pulling images and starting containers…");
    yield* Result.await(startDeployment(root, images, draft.computerEnabled));
    const quotedRoot = "'" + root.replaceAll("'", "'\"'\"'") + "'";
    prompt.note(
      `Lilac is healthy. Mention your bot in an allowed Discord channel to try it.\n\nTo update this installation, run:\n  cd ${quotedRoot}\n  ./bin/lilac\n\nFor logs, run docker compose logs -f from:\n  ${root}`,
    );
    return Result.ok({ installed: true, root });
  });
}
