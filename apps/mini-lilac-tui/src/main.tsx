import { createCliRenderer } from "@opentui/core";
import { render } from "@opentui/solid";
import { Show, createSignal } from "solid-js";

import { MiniLilacTransport } from "@stanley2058/mini-lilac-client";

import { MiniLilacApp } from "./app";
import { HELP_TEXT, parseCliOptions } from "./cli";
import { continuationCommand } from "./continuation";
import { createReadlinePreflightIO } from "./preflight";
import {
  bindingPreferenceServerKey,
  bindingPreferencesPath,
  loadBindingPreferences,
  saveBindingPreferences,
  type BindingPreferences,
} from "./preferences";
import { loadExistingSession, resolveStartupSession, type StartupSession } from "./startup";
import { COLORS, createTerminalTheme } from "./theme";

export async function main(argv: readonly string[]): Promise<number> {
  const options = parseCliOptions({ argv, env: process.env, cwd: process.cwd() });

  if (options.help) {
    process.stdout.write(HELP_TEXT);
    return 0;
  }

  if (process.stdin.isTTY !== true || process.stdout.isTTY !== true) {
    process.stderr.write("Failed to start: mini-lilac requires TTY stdin and stdout.\n");
    return 1;
  }

  const baseTransport = new MiniLilacTransport({
    baseUrl: options.server,
    bearerToken: () => options.token,
    cwd: options.cwd,
  });

  const preferencesPath = bindingPreferencesPath(process.env);
  const preferenceServer = bindingPreferenceServerKey(options.server);
  let preferences: BindingPreferences = { version: 1, servers: {} };
  try {
    preferences = await loadBindingPreferences(preferencesPath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Warning: could not load TUI preferences: ${message}\n`);
  }

  const io = createReadlinePreflightIO();
  let startup: StartupSession;
  try {
    startup = await resolveStartupSession(
      baseTransport,
      options,
      io,
      preferences.servers[preferenceServer],
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Failed to start: ${message}\n`);
    return 1;
  } finally {
    io.close();
  }

  const transport = new MiniLilacTransport({
    baseUrl: options.server,
    bearerToken: () => options.token,
    cwd: options.cwd,
    model: startup.model,
    profile: startup.profile,
    reasoning: startup.reasoning,
  });

  let resolveDestroyed: (() => void) | undefined;
  const destroyed = new Promise<void>((resolve) => {
    resolveDestroyed = resolve;
  });
  const renderer = await createCliRenderer({
    exitOnCtrlC: false,
    clearOnShutdown: true,
    targetFps: 30,
    useMouse: true,
    autoFocus: false,
    useKittyKeyboard: {},
    backgroundColor: "transparent",
    onDestroy: () => resolveDestroyed?.(),
  });
  const terminalColors = await renderer.getPalette({ size: 16 }).catch(() => undefined);
  const theme = terminalColors === undefined ? COLORS : createTerminalTheme(terminalColors);
  renderer.setBackgroundColor(theme.background);
  let continuationRequested = false;
  let currentSessionId = startup.sessionId;
  let preferenceWrite = Promise.resolve();
  const rememberBindings = (bindings: {
    readonly model: string | undefined;
    readonly profile: string | undefined;
    readonly reasoning: StartupSession["reasoning"];
  }) => {
    preferences = {
      ...preferences,
      servers: { ...preferences.servers, [preferenceServer]: bindings },
    };
    preferenceWrite = preferenceWrite
      .then(() => saveBindingPreferences(preferencesPath, preferences))
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(`Warning: could not save TUI preferences: ${message}\n`);
      });
  };

  try {
    await render(() => {
      const [current, setCurrent] = createSignal(startup);
      const switchSession = async (sessionId: string): Promise<void> => {
        const { snapshot, messages, todos } = await loadExistingSession(
          transport,
          sessionId,
          options.cwd,
        );
        transport.setSessionBindings({
          model: snapshot.model ?? undefined,
          profile: snapshot.profile ?? undefined,
          reasoning: snapshot.reasoning ?? undefined,
        });
        currentSessionId = snapshot.id;
        setCurrent({
          sessionId: snapshot.id,
          model: snapshot.model ?? undefined,
          profile: snapshot.profile ?? undefined,
          reasoning: snapshot.reasoning ?? undefined,
          snapshot,
          messages,
          todos,
          models: startup.models,
          profiles: startup.profiles,
        });
      };
      const newSession = async (bindings: {
        readonly model: string | undefined;
        readonly profile: string | undefined;
        readonly reasoning: StartupSession["reasoning"];
      }): Promise<void> => {
        const sessionId = crypto.randomUUID();
        transport.setSessionBindings(bindings);
        currentSessionId = sessionId;
        setCurrent({
          sessionId,
          ...bindings,
          snapshot: undefined,
          messages: [],
          todos: { revision: 0, todos: [] },
          models: startup.models,
          profiles: startup.profiles,
        });
      };
      return (
        <Show when={current()} keyed>
          {(session) => (
            <MiniLilacApp
              transport={transport}
              cwd={options.cwd}
              sessionId={session.sessionId}
              model={session.model}
              profile={session.profile}
              reasoning={session.reasoning}
              models={session.models}
              profiles={session.profiles}
              initialSnapshot={session.snapshot}
              initialMessages={session.messages}
              initialTodos={session.todos}
              theme={theme}
              onBindingsChange={rememberBindings}
              onNewSession={newSession}
              onSessionSelect={switchSession}
              onExit={() => {
                continuationRequested = true;
                renderer.destroy();
              }}
            />
          )}
        </Show>
      );
    }, renderer);
    await destroyed;
    if (continuationRequested) {
      process.stdout.write(
        `To continue this session, run: ${continuationCommand(options.server, currentSessionId)}\n`,
      );
      const usedCliToken = argv.some(
        (argument) => argument === "--token" || argument.startsWith("--token="),
      );
      if (usedCliToken) {
        process.stdout.write(
          "Re-supply --token or set MINI_LILAC_TOKEN; tokens are never printed to scrollback.\n",
        );
      }
    }
    return 0;
  } finally {
    if (!renderer.isDestroyed) renderer.destroy();
    await preferenceWrite;
  }
}

if (import.meta.main) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`${message}\n`);
      process.exitCode = 1;
    });
}
