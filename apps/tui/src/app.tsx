/** @jsxImportSource @opentui/solid */
import { createCliRenderer, type TextareaRenderable } from "@opentui/core";
import { render, useKeyboard, usePaste, useRenderer, useTerminalDimensions } from "@opentui/solid";
import {
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  onMount,
  Show,
  For,
  on,
} from "solid-js";
import { basename, resolve } from "node:path";
import { homedir } from "node:os";
import type { TuiSession } from "./session.ts";
import { Result } from "better-result";
import { rethrowTuiDefect, captureTuiException } from "./fatal.ts";
import { TuiController } from "./controller.ts";
import { isHiddenSlot, safeText, slotText, textWindow } from "./plaintext.ts";

const colors = {
  background: "#17161b",
  panel: "#23212a",
  selection: "#3a3147",
  foreground: "#eee9f4",
  muted: "#aea6b8",
  accent: "#c6a5df",
  error: "#f4a9a9",
};
const help = `Enter send · Shift+Enter newline · Ctrl+C cancel · Ctrl+Q exit
Temporary conversation: deleted on exit · PgUp/PgDn scroll
:model <id>
:attach <path> · :detach <number> · :uploads · :retry-upload <number>
:steer · :followup · :queue · :remove <number> · :cancel · :retry
:older · :newer · :more · :help
Use $ or /skill: for skills, / for commands. Tab inserts a suggestion.`;

export function TuiApp(props: {
  controller: TuiController;
  onExit: () => Promise<void>;
  threadId?: string;
}) {
  const controller = props.controller;
  const renderer = useRenderer();
  const dimensions = useTerminalDimensions();
  const [state, setState] = createSignal(controller.state);
  const [view, setView] = createSignal<"chat" | "help" | "queue" | "models">("chat");
  const [offset, setOffset] = createSignal(Number.MAX_SAFE_INTEGER);
  const [suggestion, setSuggestion] = createSignal(0);
  const [menuHidden, setMenuHidden] = createSignal(false);
  let editor: TextareaRenderable | undefined;
  const unsubscribe = controller.subscribe(() => setState(controller.state));
  onCleanup(() => {
    unsubscribe();
    controller.dispose();
  });
  onMount(() => {
    controller.run(controller.start(props.threadId));
  });
  const current = () => {
    void state().version;
    return controller.currentThread();
  };
  const paletteOpen = () => view() === "models";
  const paletteHeight = () => Math.min(7, Math.max(3, Math.floor(dimensions().height / 3)));
  const height = () =>
    Math.max(
      2,
      dimensions().height -
        10 -
        (paletteOpen() ? paletteHeight() : Math.min(5, completions().length)) -
        Number(!!state().error) -
        Number(!!state().notice) -
        Number(state().attachments.some((item) => !item.sent || item.state !== "ready")),
    );
  const completions = createMemo(() => {
    void state().version;
    return menuHidden() ? [] : controller.completions();
  });
  const content = createMemo(() => {
    const snapshot = state();
    if (view() === "help") return help;
    if (view() === "queue")
      return (
        snapshot.queue
          .map((item, index) => `${index + 1}. [${item.state}] ${item.text}`)
          .join("\n\n") || "Queue is empty."
      );
    if (!snapshot.selected) return "";
    const store = controller.session.client.thread(snapshot.selected);
    const end = snapshot.slotIds.indexOf(snapshot.slotId ?? "") + 1;
    return snapshot.slotIds
      .slice(Math.max(0, end - 5), end)
      .map((id) => store.get(id))
      .filter((slot) => slot !== undefined)
      .filter((slot) => !isHiddenSlot(slot))
      .map(slotText)
      .join("\n\n");
  });
  const visible = createMemo(() =>
    textWindow(content(), dimensions().width - 4, height(), offset()),
  );
  createEffect(() => {
    const value = state().draft;
    if (!editor || editor.plainText === value) return;
    editor.setText(value);
    editor.cursorOffset = value.length;
  });
  createEffect(
    on(
      () => [state().slotId, view()],
      () => setOffset(Number.MAX_SAFE_INTEGER),
    ),
  );
  async function exit() {
    controller.dispose();
    renderer.destroy();
    await props.onExit();
  }
  async function attachPath(value: string) {
    const unquoted = value.replace(/^(['"])(.*)\1$/, "$2");
    const path = resolve(
      unquoted.startsWith("~/") ? `${homedir()}/${unquoted.slice(2)}` : unquoted,
    );
    const file = Bun.file(path);
    const exists = await controller.attempt(() => file.exists());
    if (!exists) {
      controller.update({ error: "Attachment file does not exist." });
      return;
    }
    controller.attach(file, basename(path));
  }
  async function command(text: string): Promise<boolean> {
    if (!text.startsWith(":")) return false;
    const split = text.indexOf(" ");
    const name = split < 0 ? text : text.slice(0, split);
    const argument = split < 0 ? "" : text.slice(split + 1).trim();
    controller.update({ draft: "", error: undefined });
    switch (name) {
      case ":help":
        setView("help");
        return true;
      case ":attach":
        await attachPath(argument);
        return true;
      case ":detach": {
        const file = state().attachments[Number(argument) - 1];
        if (file && !file.sent) controller.removeAttachment(file.id);
        return true;
      }
      case ":retry-upload": {
        const file = state().attachments[Number(argument) - 1];
        if (file) controller.retryUpload(file.id);
        return true;
      }
      case ":uploads":
        controller.update({
          notice:
            state()
              .attachments.map(
                (file, index) =>
                  `${index + 1}. ${file.name}: ${file.state} ${Math.round(file.progress * 100)}%${file.error ? `: ${file.error}` : ""}`,
              )
              .join("\n") || "No uploads.",
        });
        return true;
      case ":model":
        if (!argument) {
          setView("models");
          return true;
        }
        if (!state().catalog?.models.some((model) => model.id === argument)) {
          controller.update({
            notice:
              "Models: " +
              state()
                .catalog?.models.map((model) => model.id)
                .join(", "),
          });
          return true;
        }
        controller.update({ modelId: argument });
        return true;
      case ":steer":
        controller.update({ mode: "steer" });
        return true;
      case ":followup":
        controller.update({ mode: "followup" });
        return true;
      case ":queue":
        await controller.refreshQueue();
        setView("queue");
        return true;
      case ":remove": {
        const entry = state().queue[Number(argument) - 1];
        if (entry) await controller.removeQueued(entry.inputId);
        return true;
      }
      case ":cancel":
        await controller.cancel();
        return true;
      case ":retry":
        await controller.retrySend();
        return true;
      case ":older":
        controller.navigate(-1);
        setView("chat");
        await controller.more();
        return true;
      case ":newer":
        controller.navigate(1);
        setView("chat");
        return true;
      case ":more":
        await controller.more();
        return true;
      default:
        controller.update({
          draft: text,
          error: "Unknown terminal command. :help lists commands.",
        });
        return true;
    }
  }
  async function submit() {
    const text = state().draft;
    if (await command(text)) return;
    setView("chat");
    await controller.send();
  }
  usePaste((event) => {
    if (!event.metadata?.mimeType?.startsWith("image/")) return;
    event.preventDefault();
    controller.attach(
      new Blob([Uint8Array.from(event.bytes)], { type: event.metadata.mimeType }),
      "pasted-image",
    );
  });
  useKeyboard((key) => {
    const handled = () => {
      key.preventDefault();
      key.stopPropagation();
    };
    if (key.ctrl && key.name === "q") {
      handled();
      controller.run(exit());
      return;
    }
    if (key.ctrl && key.name === "c") {
      handled();
      controller.run(controller.cancel());
      return;
    }
    if (key.ctrl && key.name === "m") {
      handled();
      setView("models");
      return;
    }
    if (key.ctrl && key.name === "k") {
      handled();
      controller.run(controller.refreshQueue());
      setView("queue");
      return;
    }
    if (key.name === "pageup") {
      handled();
      if (visible().offset === 0) {
        controller.navigate(-1);
        return;
      }
      setOffset(Math.max(0, visible().offset - height()));
      return;
    }
    if (key.name === "pagedown") {
      handled();
      setOffset(visible().offset + height());
      return;
    }
    if (key.name === "escape") {
      handled();
      setView("chat");
      setMenuHidden(true);
      controller.update({ error: undefined, notice: undefined });
      return;
    }
    if (paletteOpen()) return;
    const choices = completions();
    if (choices.length && ["up", "down", "tab"].includes(key.name)) {
      handled();
      if (key.name === "up") {
        setSuggestion((suggestion() + choices.length - 1) % choices.length);
        return;
      }
      if (key.name === "down") {
        setSuggestion((suggestion() + 1) % choices.length);
        return;
      }
      const choice = choices[suggestion() % choices.length];
      if (choice) {
        controller.complete(choice);
        setMenuHidden(true);
      }
      return;
    }
  });
  const attachmentLine = () =>
    state()
      .attachments.filter((item) => !item.sent || item.state !== "ready")
      .slice(-3)
      .map((item) => safeText(`${item.name} ${item.state} ${Math.round(item.progress * 100)}%`))
      .join(" · ");
  return (
    <box
      width="100%"
      height="100%"
      flexDirection="column"
      paddingLeft={2}
      paddingRight={2}
      paddingTop={1}
      paddingBottom={1}
      backgroundColor={colors.background}
    >
      <box height={height()} flexShrink={0} overflow="hidden">
        <text fg={colors.foreground}>{visible().lines.join("\n")}</text>
      </box>
      <Show when={paletteOpen()}>
        <box
          height={paletteHeight()}
          backgroundColor={colors.panel}
          paddingLeft={1}
          paddingRight={1}
        >
          <select
            height={paletteHeight()}
            focused={paletteOpen()}
            showDescription={true}
            showScrollIndicator={true}
            backgroundColor={colors.panel}
            focusedBackgroundColor={colors.panel}
            textColor={colors.foreground}
            selectedBackgroundColor={colors.selection}
            selectedTextColor={colors.accent}
            options={(state().catalog?.models ?? []).map((model) => ({
              name: safeText(model.label),
              description: safeText(model.description ?? model.id),
              value: model.id,
            }))}
            onSelect={(_index, option) => {
              if (!option) return;
              controller.update({ modelId: String(option.value) });
              setView("chat");
            }}
          />
        </box>
      </Show>
      <Show when={!paletteOpen() && completions().length > 0}>
        <box backgroundColor={colors.panel} height={Math.min(5, completions().length)}>
          <For
            each={completions().slice(
              Math.floor(suggestion() / 5) * 5,
              Math.floor(suggestion() / 5) * 5 + 5,
            )}
          >
            {(choice, index) => (
              <box
                height={1}
                flexDirection="row"
                backgroundColor={index() === suggestion() % 5 ? colors.selection : colors.panel}
                paddingLeft={1}
                paddingRight={1}
              >
                <text
                  width={Math.min(26, Math.floor(dimensions().width / 3))}
                  fg={colors.accent}
                  truncate={true}
                >
                  {safeText(`${index() === suggestion() % 5 ? "> " : "  "}${choice.insertText}`)}
                </text>
                <text fg={colors.muted} truncate={true}>
                  {safeText(choice.description)}
                </text>
              </box>
            )}
          </For>
        </box>
      </Show>
      <Show when={attachmentLine()}>
        <text fg={colors.muted} height={1}>
          {attachmentLine()}
        </text>
      </Show>
      <Show when={state().error}>
        <text fg={colors.error} height={1}>
          {safeText(state().error ?? "")}
        </text>
      </Show>
      <Show when={state().notice}>
        <text fg={colors.muted} height={1}>
          {safeText(state().notice ?? "").replaceAll("\n", " · ")}
        </text>
      </Show>
      <box
        backgroundColor={colors.panel}
        paddingLeft={1}
        paddingRight={1}
        paddingTop={1}
        paddingBottom={1}
        height={5}
      >
        <textarea
          id="composer"
          ref={(value) => {
            editor = value;
            editor.setText(state().draft);
          }}
          height={3}
          focused={!paletteOpen()}
          backgroundColor={colors.panel}
          focusedBackgroundColor={colors.panel}
          textColor={colors.foreground}
          focusedTextColor={colors.foreground}
          cursorColor={colors.accent}
          placeholder={
            current()?.capabilities.edit === false
              ? "Read-only. :help for navigation"
              : "Ask anything…"
          }
          onContentChange={(value) => {
            controller.update({
              draft: typeof value === "string" ? value : (editor?.plainText ?? ""),
            });
            setMenuHidden(false);
            setSuggestion(0);
          }}
          keyBindings={[
            { name: "return", action: "submit" },
            { name: "return", shift: true, action: "newline" },
          ]}
          onSubmit={() => {
            controller.run(submit());
          }}
        />
      </box>
      <box height={1} flexDirection="row" marginTop={1}>
        <text fg={colors.foreground} flexGrow={1} truncate={true}>
          {safeText(current()?.title || "New conversation")}
        </text>
        <text fg={colors.muted}>
          {safeText(state().modelId ?? current()?.modelId ?? "default model")}
        </text>
      </box>
      <box height={1} flexDirection="row">
        <text fg={colors.accent} flexGrow={1}>
          {safeText(
            `${state().connection} · ${current()?.activeRunId ? "working" : "idle"} · ${state().mode}`,
          )}
        </text>
        <text fg={colors.muted}>Temporary · deleted on exit · Ctrl+M model · :help</text>
      </box>
    </box>
  );
}

export async function runTui(session: TuiSession, threadId?: string): Promise<void> {
  const closed = Promise.withResolvers<void>();
  const renderer = await createCliRenderer({
    exitOnCtrlC: false,
    targetFps: 30,
    useKittyKeyboard: {},
  });
  const controller = new TuiController(session, (error) => {
    controller.dispose();
    renderer.destroy();
    closed.reject(error);
  });
  const terminate = () => {
    renderer.destroy();
    closed.resolve();
  };
  process.once("SIGTERM", terminate);
  process.once("SIGHUP", terminate);
  const mounted = await Result.tryPromise({
    try: () =>
      render(
        () => (
          <TuiApp
            controller={controller}
            threadId={threadId}
            onExit={async () => {
              closed.resolve();
            }}
          />
        ),
        renderer,
      ),
    catch: captureTuiException,
  });
  const failure = mounted.match({ ok: () => undefined, err: (error) => error });
  if (failure) {
    controller.dispose();
    renderer.destroy();
    rethrowTuiDefect(failure);
  }
  await closed.promise;
  process.removeListener("SIGTERM", terminate);
  process.removeListener("SIGHUP", terminate);
}
