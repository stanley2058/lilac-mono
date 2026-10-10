import { createHash } from "node:crypto";
import type { AgentIdentity, DisplayCatalog } from "@stanley2058/lilac-client-protocol";
import type { CoreConfig } from "@stanley2058/lilac-utils/core-config";
import type { DiscoveredSkill } from "@stanley2058/lilac-utils/skills";
import type { CustomCommandDef } from "@stanley2058/lilac-utils/custom-commands";

export type NativeCatalogSource = {
  config: CoreConfig;
  skills: readonly DiscoveredSkill[];
  commands: readonly CustomCommandDef[];
};

export type NativeCatalogScope = {
  key: string;
  skillNames?: ReadonlySet<string>;
  commandNames?: ReadonlySet<string>;
};

const builtins: DisplayCatalog["commands"] = [
  { id: "model", name: "model", description: "Select the model for this thread", kind: "builtin" },
  { id: "cancel", name: "cancel", description: "Cancel the active run", kind: "builtin" },
];

export class NativeCatalogService {
  private source: Omit<DisplayCatalog, "revision">;
  private readonly scopes = new Map<string, DisplayCatalog>();
  private readonly listeners = new Set<() => void>();

  constructor(source: NativeCatalogSource) {
    this.source = projectCatalog(source);
  }

  update(source: NativeCatalogSource): void {
    this.source = {
      ...projectCatalog(source),
      ...(this.source.agent ? { agent: this.source.agent } : {}),
    };
    this.scopes.clear();
    for (const listener of this.listeners) listener();
  }

  setAgent(agent: AgentIdentity): void {
    if (JSON.stringify(this.source.agent) === JSON.stringify(agent)) return;
    this.source = { ...this.source, agent };
    this.scopes.clear();
    for (const listener of this.listeners) listener();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  get(
    scope: NativeCatalogScope,
    revision?: string,
  ): { kind: "unchanged"; revision: string } | { kind: "catalog"; catalog: DisplayCatalog } {
    const key = JSON.stringify([
      scope.key,
      scope.skillNames ? [...scope.skillNames].sort() : null,
      scope.commandNames ? [...scope.commandNames].sort() : null,
    ]);
    const cached = this.scopes.get(key);
    if (cached) return catalogReply(cached, revision);
    const source = this.source;
    const skills = scope.skillNames
      ? source.skills.filter((skill) => scope.skillNames?.has(skill.name))
      : source.skills;
    const commands = scope.commandNames
      ? source.commands.filter(
          (command) => command.kind === "builtin" || scope.commandNames?.has(command.name),
        )
      : source.commands;
    const display = {
      models: source.models,
      skills,
      commands,
      ...(source.agent ? { agent: source.agent } : {}),
    };
    const nextRevision = createHash("sha256")
      .update(scope.key)
      .update("\0")
      .update(JSON.stringify(display))
      .digest("hex");
    const catalog = { revision: nextRevision, ...display };
    if (this.scopes.size >= 128) this.scopes.clear();
    this.scopes.set(key, catalog);
    return catalogReply(catalog, revision);
  }
}

function catalogReply(
  catalog: DisplayCatalog,
  revision?: string,
): { kind: "unchanged"; revision: string } | { kind: "catalog"; catalog: DisplayCatalog } {
  if (revision === catalog.revision) return { kind: "unchanged", revision };
  return { kind: "catalog", catalog };
}

function projectCatalog(source: NativeCatalogSource): Omit<DisplayCatalog, "revision"> {
  const models = Object.entries(source.config.models.def).map(([id, model]) => ({
    id,
    label: id,
    ...(model.comment ? { description: model.comment.slice(0, 1024) } : {}),
  }));
  const primaryId = source.config.models.main.model;
  const primaryIndex = models.findIndex((model) => model.id === primaryId);
  const primary =
    primaryIndex >= 0 ? models.splice(primaryIndex, 1)[0]! : { id: primaryId, label: primaryId };
  models.unshift(primary);
  return {
    models,
    skills: source.skills.map((skill) => ({
      id: skill.name,
      name: skill.name,
      description: skill.description.slice(0, 1024),
      source: skill.source,
    })),
    commands: [
      ...builtins,
      ...source.commands.map((command) => ({
        id: `custom:${command.name}`,
        name: command.name,
        description: command.description,
        kind: "custom" as const,
        ...(command.args.length > 0
          ? {
              argumentHint: command.args
                .map((arg) => (arg.required ? `<${arg.key}>` : `[${arg.key}]`))
                .join(" ")
                .slice(0, 256),
              arguments: command.args.map((arg) => ({
                key: arg.key,
                type: arg.type,
                ...(arg.description ? { description: arg.description } : {}),
                required: arg.required,
                // Oversized choice lists stay server-validated only.
                ...(arg.choices && arg.choices.length <= 256 ? { choices: arg.choices } : {}),
              })),
            }
          : {}),
      })),
    ],
  };
}
