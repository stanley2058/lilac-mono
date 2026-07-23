import type {
  MiniLilacModelSummary,
  MiniLilacProfileSummary,
  MiniLilacReasoning,
  MiniLilacSessionResume,
  MiniLilacSessionSnapshot,
  MiniLilacTodoState,
  MiniLilacTransport,
  MiniLilacUIMessage,
} from "@stanley2058/mini-lilac-client";

import { canonicalCwd, type CliOptions } from "./cli";
import { modelChoices, selectChoice, type PreflightIO } from "./preflight";
import type { BindingPreference } from "./preferences";

export type StartupTransport = Pick<
  MiniLilacTransport,
  "getSessionResume" | "listModels" | "listProfiles" | "setReconnectCursor"
>;

export interface StartupSession {
  readonly sessionId: string;
  readonly model: string | undefined;
  readonly profile: string | undefined;
  readonly reasoning: MiniLilacReasoning | undefined;
  readonly snapshot: MiniLilacSessionSnapshot | undefined;
  readonly messages: MiniLilacUIMessage[];
  readonly todos: MiniLilacTodoState;
  readonly replayCursor: MiniLilacSessionResume["replayCursor"];
  readonly models: readonly MiniLilacModelSummary[];
  readonly profiles: readonly MiniLilacProfileSummary[];
}

export function verifySessionCwd(snapshot: MiniLilacSessionSnapshot, cwd: string): void {
  let storedCwd: string;
  try {
    storedCwd = canonicalCwd(snapshot.cwd);
  } catch {
    throw new Error(`Session '${snapshot.id}' cwd no longer resolves: ${snapshot.cwd}`);
  }
  if (storedCwd !== cwd) {
    throw new Error(
      `Session '${snapshot.id}' belongs to cwd '${storedCwd}', not current cwd '${cwd}'`,
    );
  }
}

export async function loadExistingSession(
  transport: Pick<MiniLilacTransport, "getSessionResume" | "setReconnectCursor">,
  sessionId: string,
  cwd: string,
): Promise<{
  readonly snapshot: MiniLilacSessionSnapshot;
  readonly messages: MiniLilacUIMessage[];
  readonly todos: MiniLilacTodoState;
  readonly replayCursor: MiniLilacSessionResume["replayCursor"];
}> {
  const { snapshot, messages, todos, replayCursor } = await transport.getSessionResume(sessionId);
  verifySessionCwd(snapshot, cwd);
  transport.setReconnectCursor(sessionId, replayCursor);
  return { snapshot, messages, todos, replayCursor };
}

/** Resolve a fresh or resumed session without creating fresh binding mismatches. */
export async function resolveStartupSession(
  transport: StartupTransport,
  options: CliOptions,
  io: PreflightIO,
  preference?: BindingPreference,
): Promise<StartupSession> {
  let snapshot: MiniLilacSessionSnapshot | undefined;
  let messages: MiniLilacUIMessage[] = [];
  let todos: MiniLilacTodoState = { revision: 0, todos: [] };
  let replayCursor: MiniLilacSessionResume["replayCursor"] = null;

  if (options.session !== undefined) {
    // Resume state and canonical transcript are loaded before catalog selection.
    ({ snapshot, messages, todos, replayCursor } = await loadExistingSession(
      transport,
      options.session,
      options.cwd,
    ));
    const ignoredBindings: string[] = [];
    if (options.model !== undefined && options.model !== (snapshot.model ?? undefined)) {
      ignoredBindings.push("--model");
    }
    if (options.profile !== undefined && options.profile !== (snapshot.profile ?? undefined)) {
      ignoredBindings.push("--profile");
    }
    if (
      options.reasoning !== undefined &&
      options.reasoning !== (snapshot.reasoning ?? undefined)
    ) {
      ignoredBindings.push("--reasoning");
    }
    if (ignoredBindings.length > 0) {
      io.write(
        `Warning: ${ignoredBindings.join(", ")} ignored; resumed sessions keep their stored bindings.\n`,
      );
    }
  }

  const [models, profiles] = await Promise.all([transport.listModels(), transport.listProfiles()]);
  // Every persisted value is authoritative on resume, including null (which is
  // represented as an omitted transport option). Never select a fresh binding.
  const preferredModel = options.model ?? preference?.model;
  const rememberedModel = models.some((entry) => entry.id === preferredModel)
    ? preferredModel
    : undefined;
  const model =
    snapshot === undefined
      ? (await selectChoice(io, "Model", modelChoices(models), options.model ?? rememberedModel)).id
      : (snapshot.model ?? undefined);
  const preferredProfile = options.profile ?? preference?.profile;
  if (
    snapshot === undefined &&
    options.profile !== undefined &&
    !profiles.some((entry) => entry.id === options.profile && !entry.subagentOnly)
  ) {
    throw new Error(`Unknown selection '${options.profile}' for profile`);
  }
  const rememberedProfile = profiles.some(
    (entry) => entry.id === preferredProfile && !entry.subagentOnly,
  )
    ? preferredProfile
    : undefined;
  const profile =
    snapshot === undefined
      ? (options.profile ?? rememberedProfile)
      : (snapshot.profile ?? undefined);

  return {
    sessionId: snapshot?.id ?? options.session ?? crypto.randomUUID(),
    model,
    profile,
    // Resume bindings are authoritative. A stored null means provider default,
    // not permission for a fresh CLI override.
    reasoning:
      snapshot === undefined
        ? (options.reasoning ?? preference?.reasoning)
        : (snapshot.reasoning ?? undefined),
    snapshot,
    messages,
    todos,
    replayCursor,
    models,
    profiles,
  };
}
