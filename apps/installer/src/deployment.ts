import path from "node:path";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rename, chmod, copyFile, rm } from "node:fs/promises";
import { Result, TaggedError } from "better-result";
import {
  parseDocument,
  Document,
  YAMLSeq,
  isAlias,
  isMap,
  isNode,
  isScalar,
  isSeq,
  visit,
} from "yaml";
import { z } from "zod";
import type { SetupDraft } from "./types";
import { writeDataFiles, type DataFileWriter } from "./data-files";
import { command } from "./system";
import { withInstallerCleanup } from "./failure";
import type { ExistingDeployment, ResolvedDeployment } from "./compose-inspection";

export class InstallerDeploymentFailed extends TaggedError("InstallerDeploymentFailed")<{
  readonly message: string;
}> {}

export const installerVersion = process.env.LILAC_INSTALLER_VERSION ?? "dev";
export const installerCommit = process.env.LILAC_INSTALLER_COMMIT ?? "dev";

export type ImageReferences = { core: string; gateway: string; runner: string };

const referenceSchema = z
  .string()
  .min(1)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._/:@-]*$/);

function validateComputerNetworking(
  draft: SetupDraft,
  existing?: ResolvedDeployment,
): Result<void, InstallerDeploymentFailed> {
  if (!draft.computerConfigured || !existing) return Result.ok(undefined);
  for (const [service, definition] of Object.entries(existing.services)) {
    if (definition?.network_mode === undefined) continue;
    return Result.err(
      new InstallerDeploymentFailed({
        message: `Guided computer-use setup requires Compose networks, but services.${service}.network_mode is set. Remove network_mode and use Compose networks for Core and the gateway, or rerun setup and skip computer use to preserve your existing configuration.`,
      }),
    );
  }
  return Result.ok(undefined);
}

export function validateDeploymentInputs(
  draft: SetupDraft,
  images: ImageReferences,
  existing?: ResolvedDeployment,
): Result<void, InstallerDeploymentFailed> {
  for (const image of Object.values(images)) {
    if (!referenceSchema.safeParse(image).success)
      return Result.err(
        new InstallerDeploymentFailed({
          message: "An image reference is invalid. Check the LILAC_IMAGE overrides.",
        }),
      );
  }
  for (const [key, value] of Object.entries(draft.secrets)) {
    if (
      draft.preservedEnvironmentSource !== undefined &&
      !draft.configuredEnvironmentKeys?.has(key)
    )
      continue;
    if (
      !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) ||
      value.includes("\r") ||
      value.includes("\n") ||
      value.includes("\0")
    ) {
      return Result.err(
        new InstallerDeploymentFailed({
          message:
            "An environment credential contains an invalid name or line break. Re-enter the credential before installing.",
        }),
      );
    }
  }
  for (const file of draft.files) {
    const segments = file.relativePath.split(/[\\/]/);
    if (path.isAbsolute(file.relativePath) || segments.includes("..") || segments.includes("")) {
      return Result.err(
        new InstallerDeploymentFailed({ message: "A setup file has an invalid relative path." }),
      );
    }
  }
  return validateComputerNetworking(draft, existing);
}

export function resolveImages(existing?: ResolvedDeployment): ImageReferences {
  const core = existing?.services.lilac;
  const gateway = existing?.services["computer-use-gateway"];
  return {
    core:
      process.env.LILAC_IMAGE ??
      (core?.build ? undefined : core?.image) ??
      process.env.LILAC_DEFAULT_IMAGE ??
      "ghcr.io/stanley2058/lilac-mono:latest",
    gateway:
      process.env.LILAC_COMPUTER_GATEWAY_IMAGE ??
      (gateway?.build ? undefined : gateway?.image) ??
      process.env.LILAC_DEFAULT_COMPUTER_GATEWAY_IMAGE ??
      "ghcr.io/stanley2058/lilac-computer-gateway:latest",
    runner:
      process.env.LILAC_COMPUTER_RUNNER_IMAGE ??
      (gateway?.build ? undefined : gateway?.environment.RUNNER_IMAGE) ??
      process.env.LILAC_DEFAULT_COMPUTER_RUNNER_IMAGE ??
      "ghcr.io/stanley2058/lilac-computer:latest",
  };
}

export function readEnvironment(source: string): Record<string, string> {
  const entries: Record<string, string> = {};
  for (const line of source.split(/\r?\n/)) {
    const matched = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (matched?.[1] !== undefined && matched[2] !== undefined) entries[matched[1]] = matched[2];
  }
  return entries;
}

export function serializeEnvironment(values: Record<string, string>): string {
  return (
    Object.entries(values)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => `${key}=${value}`)
      .join("\n") + "\n"
  );
}

export function readOptionalFile(filename: string): Promise<string | undefined> {
  return Bun.file(filename)
    .exists()
    .then((exists) => (exists ? readFile(filename, "utf8") : undefined));
}

export function parseDeployment(source: string) {
  const document = parseDocument(source);
  if (document.errors.length || !isMap(document.contents)) {
    return Result.err(
      new InstallerDeploymentFailed({
        message:
          "The existing compose.yaml is not a readable Lilac deployment. Choose another directory.",
      }),
    );
  }
  return Result.ok(document);
}

function cloneDeploymentAlias(document: Document, node: unknown): unknown {
  if (!isAlias(node)) return node;
  const replacement = node.resolve(document)?.clone();
  if (!replacement) return node;
  if ("anchor" in replacement) replacement.anchor = undefined;
  replacement.comment = node.comment ?? replacement.comment;
  replacement.commentBefore = node.commentBefore ?? replacement.commentBefore;
  return replacement;
}

function detachDeploymentAliases(document: Document, node: unknown): void {
  if (!isNode(node) || !("anchor" in node) || !node.anchor) return;
  visit(document, {
    Alias: (_key, alias) => {
      if (alias.resolve(document) !== node) return;
      const replacement = cloneDeploymentAlias(document, alias);
      if (isNode(replacement)) return replacement;
    },
  });
}

function editableServiceField(document: Document, service: string, field: string): unknown {
  const keyPath = ["services", service, field];
  const existing = document.getIn(keyPath, true);
  detachDeploymentAliases(document, existing);
  const replacement = cloneDeploymentAlias(document, existing);
  if (replacement !== existing) document.setIn(keyPath, replacement);
  return replacement;
}

function expandDeploymentMerges(
  document: Document,
  mapping: unknown,
  ancestors: ReadonlySet<unknown> = new Set(),
): void {
  if (!isMap(mapping)) return;
  const merges = mapping.items.filter(
    (pair) => isScalar(pair.key) && (pair.key.value === "<<" || typeof pair.key.value === "symbol"),
  );
  if (!merges.length) return;
  for (const merge of merges) detachDeploymentAliases(document, merge.value);
  mapping.items = mapping.items.filter((pair) => !merges.includes(pair));
  for (const merge of merges) {
    const value = isAlias(merge.value) ? merge.value.resolve(document) : merge.value;
    const sources = isSeq(value) ? value.items : [value];
    for (const source of sources) {
      const resolved = isAlias(source) ? source.resolve(document) : source;
      if (!isMap(resolved) || ancestors.has(resolved)) continue;
      const inherited = resolved.clone();
      if (!isMap(inherited)) continue;
      expandDeploymentMerges(document, inherited, new Set([...ancestors, resolved]));
      for (const pair of inherited.items) {
        if (!mapping.has(pair.key)) mapping.items.push(pair.clone());
      }
    }
  }
}

function isManagedEnvironmentFile(document: Document, entry: unknown, root: string): boolean {
  const node = cloneDeploymentAlias(document, entry);
  let filename: unknown;
  if (isMap(node)) {
    const value = cloneDeploymentAlias(document, node.get("path", true));
    filename = isScalar(value) ? value.value : value;
  }
  if (isScalar(node)) filename = node.value;
  return (
    typeof filename === "string" && path.resolve(root, filename) === path.join(root, "secrets.env")
  );
}

function attachManagedEnvironmentFile(document: Document, root: string, service: string): boolean {
  const keyPath = ["services", service, "env_file"];
  const existing = editableServiceField(document, service, "env_file");
  const files = isSeq(existing) ? existing : new YAMLSeq(document.schema);
  if (!isSeq(existing) && isNode(existing)) files.add(existing);
  let lastManaged = -1;
  for (let index = 0; index < files.items.length; index += 1) {
    const entry = files.items[index];
    if (!isManagedEnvironmentFile(document, entry, root)) continue;
    lastManaged = index;
  }
  if (lastManaged < 0) {
    files.add(document.createNode({ path: "./secrets.env", format: "raw" }));
    lastManaged = files.items.length - 1;
  }
  document.setIn(keyPath, files);
  return lastManaged < files.items.length - 1;
}

function removeCredentialOverrides(
  document: Document,
  service: string,
  keys: ReadonlySet<string>,
): void {
  if (!keys.size) return;
  const environment = editableServiceField(document, service, "environment");
  if (isMap(environment)) {
    expandDeploymentMerges(document, environment);
    for (const key of keys) {
      detachDeploymentAliases(document, environment.get(key, true));
      environment.delete(key);
    }
    return;
  }
  if (!isSeq(environment)) return;
  environment.items = environment.items.filter((entry) => {
    const value = cloneDeploymentAlias(document, entry);
    if (!isScalar(value) || typeof value.value !== "string") return true;
    const key = value.value.split("=", 1)[0];
    if (key === undefined || !keys.has(key)) return true;
    detachDeploymentAliases(document, entry);
    return false;
  });
}

function setServiceEnvironment(
  document: Document,
  service: string,
  key: string,
  value: string,
): void {
  const keyPath = ["services", service, "environment"];
  const environment = editableServiceField(document, service, "environment");
  if (!isSeq(environment)) {
    if (isMap(environment)) detachDeploymentAliases(document, environment.get(key, true));
    document.setIn([...keyPath, key], value);
    return;
  }
  let replaced = false;
  environment.items = environment.items.map((entry) => cloneDeploymentAlias(document, entry));
  environment.items = environment.items.filter((entry) => {
    if (!isScalar(entry) || typeof entry.value !== "string") return true;
    if (entry.value !== key && !entry.value.startsWith(`${key}=`)) return true;
    detachDeploymentAliases(document, entry);
    if (replaced) return false;
    entry.value = `${key}=${value}`;
    replaced = true;
    return true;
  });
  if (!replaced) environment.add(document.createNode(`${key}=${value}`));
}

function configureServiceEnvironment(
  document: Document,
  root: string,
  service: string,
  secrets: Readonly<Record<string, string>>,
  configuredKeys: ReadonlySet<string>,
  preserveSource: boolean,
): void {
  const hasLaterFiles = !preserveSource && attachManagedEnvironmentFile(document, root, service);
  if (!hasLaterFiles && !preserveSource) {
    removeCredentialOverrides(document, service, configuredKeys);
    return;
  }
  for (const key of configuredKeys) {
    const value = secrets[key];
    if (value === undefined) continue;
    // Compose interpolates even quoted YAML values; $$ preserves a literal dollar.
    setServiceEnvironment(
      document,
      service,
      key,
      value.replaceAll("$", () => "$$"),
    );
  }
}

function prepareServiceForEditing(document: Document, service: string): void {
  const services = editableServicesMap(document);
  if (!isMap(services)) return;
  const original = services.get(service, true);
  detachDeploymentAliases(document, original);
  const editable = cloneDeploymentAlias(document, original);
  if (editable !== original) services.set(service, editable);
  expandDeploymentMerges(document, editable);
}

function configureServiceImage(
  document: Document,
  service: string,
  image: string,
  built: boolean,
): void {
  prepareServiceForEditing(document, service);
  editableServiceField(document, service, "image");
  editableServiceField(document, service, "build");
  document.setIn(["services", service, "image"], image);
  document.deleteIn(["services", service, "build"]);
  if (!built) return;
  editableServiceField(document, service, "pull_policy");
  document.deleteIn(["services", service, "pull_policy"]);
}

function editableServicesMap(document: Document): unknown {
  const original = document.get("services", true);
  detachDeploymentAliases(document, original);
  const editable = cloneDeploymentAlias(document, original);
  if (editable !== original) document.set("services", editable);
  expandDeploymentMerges(document, editable);
  return editable;
}

function connectComputerGateway(
  document: Document,
  created: boolean,
  existing?: ResolvedDeployment,
): void {
  const core = existing?.services.lilac;
  const gateway = existing?.services["computer-use-gateway"];
  if (core?.network_mode !== undefined || gateway?.network_mode !== undefined) return;
  const keyPath = ["services", "computer-use-gateway", "networks"];
  const coreNames = Object.keys(core?.networks ?? {});
  const coreNetworks = coreNames.length ? coreNames : ["default"];
  if (created) {
    document.setIn(keyPath, document.createNode(coreNetworks));
    return;
  }
  const gatewayNames = Object.keys(gateway?.networks ?? {});
  const gatewayNetworks = gatewayNames.length ? gatewayNames : ["default"];
  if (coreNetworks.some((network) => gatewayNetworks.includes(network))) return;
  const connection = coreNetworks[0];
  if (!connection) return;
  const networks = editableServiceField(document, "computer-use-gateway", "networks");
  if (isMap(networks)) {
    networks.set(document.createNode(connection), null);
    return;
  }
  if (isSeq(networks)) {
    networks.add(document.createNode(connection));
    return;
  }
  document.setIn(keyPath, document.createNode([...gatewayNetworks, connection]));
  if (gatewayNetworks.includes("default") && !document.hasIn(["networks", "default"])) {
    document.setIn(["networks", "default"], {});
  }
}

export function createDeployment(
  root: string,
  draft: SetupDraft,
  images: ImageReferences,
  existing?: ExistingDeployment,
  managedEnvironmentKeys: ReadonlySet<string> = new Set(),
) {
  const document = existing?.document.clone() ?? new Document();
  if (!document.has("name"))
    document.set("name", `lilac-${createHash("sha256").update(root).digest("hex").slice(0, 10)}`);
  if (!existing) {
    document.set(
      "services",
      document.createNode({
        lilac: {
          image: images.core,
          depends_on: { redis: { condition: "service_healthy" } },
          environment: {
            REDIS_URL: "redis://redis:6379",
            DATA_DIR: "/data",
            LL_TOOL_SERVER_PORT: "8080",
            LILAC_WORKSPACE_DIR: "/data/workspace",
            GIT_CONFIG_GLOBAL: "/data/.gitconfig",
            GNUPGHOME: "/data/secret/gnupg",
            BUN_INSTALL_GLOBAL_DIR: "/data/.bun/install/global",
            BUN_INSTALL_BIN: "/data/bin",
            BUN_INSTALL_CACHE_DIR: "/data/.bun/install/cache",
            NPM_CONFIG_PREFIX: "/data/.npm-global",
            XDG_CONFIG_HOME: "/data/.config",
          },
          volumes: ["./data:/data"],
          extra_hosts: ["host.docker.internal:host-gateway"],
          tmpfs: [
            "/run:rw,nosuid,nodev,mode=755,size=64m",
            "/tmp:rw,nosuid,nodev,mode=1777,size=1g",
          ],
          mem_limit: "4g",
          pids_limit: 1024,
          stop_grace_period: "30s",
          healthcheck: {
            test: [
              "CMD",
              "curl",
              "--connect-timeout",
              "1",
              "--max-time",
              "4",
              "-fsS",
              "http://127.0.0.1:8080/readyz",
            ],
            interval: "5s",
            timeout: "5s",
            retries: 12,
            start_period: "30s",
          },
          restart: "unless-stopped",
        },
        redis: {
          image: "redis:7-alpine",
          command: ["redis-server", "--appendonly", "yes"],
          volumes: ["redis-data:/data"],
          healthcheck: {
            test: ["CMD", "redis-cli", "ping"],
            interval: "5s",
            timeout: "3s",
            retries: 20,
          },
          restart: "unless-stopped",
        },
      }),
    );
    document.set("volumes", document.createNode({ "redis-data": {} }));
  }
  configureServiceImage(document, "lilac", images.core, !!existing?.resolved.services.lilac.build);
  configureServiceEnvironment(
    document,
    root,
    "lilac",
    draft.secrets,
    managedEnvironmentKeys,
    draft.preservedEnvironmentSource !== undefined,
  );
  document.set("x-lilac-installer", { version: installerVersion, commit: installerCommit });
  if (!draft.computerEnabled) return document;
  const createdGateway = existing?.resolved.services["computer-use-gateway"] === undefined;
  if (createdGateway) {
    document.setIn(
      ["services", "computer-use-gateway"],
      document.createNode({
        image: images.gateway,
        env_file: [
          draft.preservedEnvironmentSource === undefined
            ? { path: "./secrets.env", format: "raw" }
            : { path: "./secrets.env" },
        ],
        environment: { RUNNER_IMAGE: images.runner },
        volumes: ["/var/run/docker.sock:/var/run/docker.sock", "computer-use-data:/data"],
        ports: ["127.0.0.1:8081:8080"],
        stop_grace_period: "180s",
        healthcheck: {
          test: [
            "CMD",
            "bun",
            "-e",
            "fetch('http://127.0.0.1:8080/health').then(r => process.exit(r.ok ? 0 : 1))",
          ],
          interval: "5s",
          timeout: "5s",
          retries: 12,
          start_period: "60s",
        },
        restart: "unless-stopped",
      }),
    );
    document.setIn(["volumes", "computer-use-data"], {});
  }
  configureServiceImage(
    document,
    "computer-use-gateway",
    images.gateway,
    !!existing?.resolved.services["computer-use-gateway"]?.build,
  );
  configureServiceEnvironment(
    document,
    root,
    "computer-use-gateway",
    draft.secrets,
    managedEnvironmentKeys,
    draft.preservedEnvironmentSource !== undefined,
  );
  setServiceEnvironment(document, "computer-use-gateway", "RUNNER_IMAGE", images.runner);
  connectComputerGateway(document, createdGateway, existing?.resolved);
  return document;
}

export async function writeInstallation(
  options: {
    root: string;
    draft: SetupDraft;
    config: string;
    compose: string;
    installExecutable: boolean;
    image: string;
  },
  writeData: DataFileWriter = writeDataFiles,
) {
  const files: { filename: string; content?: string; mode: number }[] = [
    {
      filename: path.join(options.root, "secrets.env"),
      content:
        options.draft.preservedEnvironmentSource ?? serializeEnvironment(options.draft.secrets),
      mode: 0o600,
    },
    { filename: path.join(options.root, "compose.yaml"), content: options.compose, mode: 0o600 },
  ];
  const executable = path.join(options.root, "bin", "lilac");
  if (options.installExecutable && process.execPath !== executable)
    files.push({ filename: executable, mode: 0o755 });
  const staged = files.map((file) => ({
    ...file,
    temporary: `${file.filename}.${crypto.randomUUID()}.tmp`,
  }));
  const temporaryFiles: string[] = [];
  const writeFailure = () =>
    new InstallerDeploymentFailed({
      message:
        "Could not write installation files. Check directory permissions and free disk space, then rerun setup.",
    });
  let cleanupResult: Result<void, InstallerDeploymentFailed> = Result.ok(undefined);
  const installation = await withInstallerCleanup(
    () =>
      Result.gen(async function* () {
        for (const directory of new Set(files.map((file) => path.dirname(file.filename)))) {
          const entries = yield* Result.await(
            Result.tryPromise({
              try: async () => {
                await mkdir(directory, { recursive: true, mode: 0o700 });
                return readdir(directory, { withFileTypes: true });
              },
              catch: writeFailure,
            }),
          );
          if (
            files.some(
              (file) =>
                path.dirname(file.filename) === directory &&
                entries.some(
                  (entry) => entry.name === path.basename(file.filename) && entry.isDirectory(),
                ),
            )
          )
            return Result.err(writeFailure());
        }
        yield* Result.await(
          Result.tryPromise({
            try: async () => {
              for (const file of staged) {
                temporaryFiles.push(file.temporary);
                if (file.content === undefined) await copyFile(process.execPath, file.temporary);
                else await Bun.write(file.temporary, file.content, { mode: file.mode });
                await chmod(file.temporary, file.mode);
              }
            },
            catch: writeFailure,
          }),
        );
        yield* Result.await(
          writeData(
            path.join(options.root, "data"),
            [
              { relativePath: "core-config.yaml", content: options.config, mode: 0o600 },
              ...options.draft.files,
            ],
            options.image,
          ),
        );
        yield* Result.await(
          Result.tryPromise({
            try: async () => {
              for (const file of staged) await rename(file.temporary, file.filename);
            },
            catch: writeFailure,
          }),
        );
        return Result.ok(undefined);
      }),
    async () => {
      const removed = await Promise.all(
        temporaryFiles.map((temporary) =>
          Result.tryPromise({
            try: () => rm(temporary, { force: true }),
            catch: () =>
              new InstallerDeploymentFailed({
                message:
                  "Could not remove temporary installation files. Check directory permissions before rerunning setup.",
              }),
          }),
        ),
      );
      cleanupResult = Result.all(removed).map(() => undefined);
    },
  );
  return installation.andThen(() => cleanupResult);
}

export function composeArguments(root: string, deployment: Document) {
  const projectName = deployment.has("name")
    ? deployment.get("name")
    : `lilac-${createHash("sha256").update(root).digest("hex").slice(0, 10)}`;
  if (typeof projectName !== "string" || !/^[a-z0-9][a-z0-9_-]*$/.test(projectName))
    return Result.err(
      new InstallerDeploymentFailed({
        message:
          "The installation's Compose project name is invalid. Set a literal name in compose.yaml and rerun setup.",
      }),
    );
  return Result.ok([
    "docker",
    "compose",
    "--file",
    path.resolve(root, "compose.yaml"),
    "--project-name",
    projectName,
  ]);
}

export async function startDeployment(
  root: string,
  images: ImageReferences,
  computerEnabled: boolean,
  run: typeof command = command,
) {
  return Result.gen(async function* () {
    for (const image of Object.values(images)) {
      if (!referenceSchema.safeParse(image).success)
        return Result.err(
          new InstallerDeploymentFailed({
            message: "An image reference is invalid. Check the LILAC_IMAGE overrides.",
          }),
        );
    }
    const composeFile = path.resolve(root, "compose.yaml");
    const source = yield* Result.await(
      Result.tryPromise({
        try: () => readFile(composeFile, "utf8"),
        catch: () =>
          new InstallerDeploymentFailed({
            message:
              "Could not read the installation's compose.yaml. Check the file and rerun setup.",
          }),
      }),
    );
    const deployment = yield* parseDeployment(source);
    const compose = [...(yield* composeArguments(root, deployment)), "--profile", ""];
    const services = computerEnabled ? ["lilac", "computer-use-gateway"] : ["lilac"];
    if (computerEnabled) {
      const runner = yield* Result.await(
        run(["docker", "pull", images.runner], { inherit: true, timeoutMs: 20 * 60_000 }),
      );
      if (runner.code !== 0)
        return Result.err(
          new InstallerDeploymentFailed({
            message:
              "Could not pull the computer-use runner image. Check the image reference and registry access.",
          }),
        );
    }
    const pull = yield* Result.await(
      run([...compose, "pull", "--include-deps", "--ignore-buildable", ...services], {
        cwd: root,
        inherit: true,
        timeoutMs: 20 * 60_000,
      }),
    );
    if (pull.code !== 0)
      return Result.err(
        new InstallerDeploymentFailed({
          message: "Image pull failed. Check registry access, then rerun the installer to retry.",
        }),
      );
    const args = [
      ...compose,
      "up",
      "--detach",
      "--wait",
      "--wait-timeout",
      "180",
      "--force-recreate",
      ...services,
    ];
    const started = yield* Result.await(
      run(args, { cwd: root, inherit: true, timeoutMs: 20 * 60_000 }),
    );
    if (started.code !== 0)
      return Result.err(
        new InstallerDeploymentFailed({
          message:
            "Containers did not become healthy. Run docker compose logs in the installation directory, fix the reported issue, and rerun setup.",
        }),
      );
    return Result.ok(undefined);
  });
}

export async function clearStaging(directory: string) {
  return Result.tryPromise({
    try: () => rm(directory, { recursive: true, force: true }),
    catch: () =>
      new InstallerDeploymentFailed({ message: "Could not remove the temporary setup directory." }),
  });
}
