import { toast } from "./ui/toast";
import { Kbd } from "./ui/kbd";
import { useEventCallback } from "../use-event-callback";
import { Result } from "better-result";
import { useOptionalWorkspace } from "../workspace-context";
import "./composer-rich.css";
import { Button } from "./ui/button";
import {
  memo,
  lazy,
  Suspense,
  useMemo,
  useEffect,
  useContext,
  useCallback,
  useRef,
  useState,
  type DragEvent,
} from "react";
import { ArrowUp, CircleAlert, Paperclip, Square, Upload } from "lucide-react";
import { createPortal } from "react-dom";
import { hasFileDrag, installWindowFileDrop } from "../window-file-drop";
import "./composer-drop.css";
import { completeCatalog, type Completion } from "@stanley2058/lilac-client";
import type { CommandArgument } from "@stanley2058/lilac-client-protocol";
import {
  commandArgumentStep,
  tokenRemainder,
  validateCommandArguments,
  type ArgumentError,
  type ArgumentStep,
  type ArgumentSuggestion,
} from "../command-arguments";
import type { ChatCommon, ComposerSubmission, Attachment } from "../types";
import { readMessageClipboard, type MessageClipboard } from "../message-clipboard";
import { namePastedImage } from "../pasted-file";
import { IconButton, VirtualList, attempt } from "./ui";
import type { ComposerEditorHandle } from "./composer-editor";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "./ui/select";
import { Popover, PopoverTrigger, PopoverContent } from "./ui/popover";

const ComposerEditor = lazy(() => import("./composer-editor"));

import { MessageIdentityContext } from "./message-identity";
import { inputDeliveryOptions } from "../input-mode";

export type ComposerProps = Partial<Pick<ChatCommon, "client" | "scope" | "catalog">> & {
  text: string;
  documentKey?: string;
  loadingDraft?: boolean;
  autoFocus?: boolean;
  skillIds: string[];
  onSkills: (ids: string[]) => void;
  commandId?: string;
  onCommand: (id: string | undefined) => void;
  onText: (text: string) => void;
  attachments: readonly Attachment[];
  onAttach: (files: File[], requireAll?: boolean) => Attachment[] | void;
  onRemoveAttachment: (key: string) => void;
  onRetryAttachment: (key: string) => void;
  active: boolean;
  canCancel: boolean;
  disabled: boolean;
  windowDrop?: boolean;
  submitting?: boolean;
  offline?: boolean;
  modelId?: string;
  onModelChange: (modelId: string) => void;
  onSubmit: (value: ComposerSubmission) => void;
  onCancel: () => void;
};

export const Composer = memo(function Composer(props: ComposerProps) {
  const workspace = useOptionalWorkspace();
  const client = props.client ?? workspace?.client;
  const scope = props.scope ?? workspace?.scope;
  const { agent } = useContext(MessageIdentityContext);
  const { text, onText, attachments, active, disabled, catalog } = props;
  const placeholder = active
    ? `Steer ${agent.displayName}, or queue a follow-up…`
    : `Message ${agent.displayName}…`;
  const input = useRef<ComposerEditorHandle>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const insertingCompletion = useRef<"hide" | "keep">(undefined);
  const [mode, setMode] = useState<"steer" | "followup">("steer");
  const commandId = props.commandId;
  const setCommandId = props.onCommand;
  const skillIds = props.skillIds;
  const setSkills = props.onSkills;
  const skills = useMemo(
    () => catalog?.skills.filter((skill) => skillIds.includes(skill.id)) ?? [],
    [skillIds, catalog],
  );
  const [editorValue, setEditorValue] = useState<{
    text: string;
    plainText: string;
    documentKey?: string;
  }>();
  const plainText = editorValue?.plainText ?? "";
  const editorReady = editorValue?.text === text && editorValue?.documentKey === props.documentKey;
  const updatePlainText = useCallback(
    (plainText: string, text: string) =>
      setEditorValue((current) =>
        current?.text === text &&
        current.plainText === plainText &&
        current.documentKey === props.documentKey
          ? current
          : { text, plainText, documentKey: props.documentKey },
      ),
    [props.documentKey],
  );
  const [prefix, setPrefix] = useState("");
  const [selected, setSelected] = useState(0);
  const [navigated, setNavigated] = useState(false);
  const [menuHidden, setMenuHidden] = useState(false);
  const [argumentError, setArgumentError] = useState<ArgumentError>();
  const [dragging, setDragging] = useState(false);
  const [documentKey, setDocumentKey] = useState(props.documentKey);
  if (documentKey !== props.documentKey) {
    setDocumentKey(props.documentKey);
    setMode("steer");
    setPrefix("");
    setSelected(0);
    setNavigated(false);
    setMenuHidden(false);
    setArgumentError(undefined);
    setDragging(false);
  }
  const dropProps = useRef(props);
  dropProps.current = props;
  useEffect(() => {
    if (!props.windowDrop) return;
    return installWindowFileDrop(window, {
      canAttach: () => !dropProps.current.disabled,
      show: setDragging,
      attach: (files) => dropProps.current.onAttach(files),
    });
  }, [props.windowDrop]);
  const match = /(?:^|\s)([$/])([^$/\n]*)$/.exec(prefix);
  const trigger = match?.[1] === "$" ? "$" : "/";
  const query = match?.[2] ?? "";
  const matching =
    catalog?.commands.filter(
      (entry) => plainText.trim() === `/${entry.name}` || plainText.startsWith(`/${entry.name} `),
    ) ?? [];
  const unambiguous = matching.length === 1 ? matching[0] : undefined;
  const command = commandId ? matching.find((entry) => entry.id === commandId) : unambiguous;
  const custom = command?.kind === "custom" ? command : undefined;
  const delivery = inputDeliveryOptions(active, mode, props.modelId, !!custom);
  const commandArguments = custom?.arguments?.length ? custom.arguments : undefined;
  const argumentText =
    commandArguments &&
    custom &&
    prefix.startsWith(`/${custom.name} `) &&
    plainText.startsWith(prefix)
      ? prefix.slice(custom.name.length + 2)
      : undefined;
  const argumentStep = useMemo(
    () =>
      commandArguments && argumentText !== undefined
        ? commandArgumentStep(commandArguments, argumentText)
        : undefined,
    [commandArguments, argumentText],
  );
  const guideOpen = !menuHidden && !!commandArguments && (!!argumentStep || !!argumentError);
  const completions = useMemo(() => {
    if (!match || menuHidden || argumentText !== undefined) return [];
    if (catalog) return completeCatalog(catalog, trigger, query, 100);
    return client && scope ? client.catalogs.complete(scope, trigger, query, 100) : [];
  }, [client, scope, trigger, query, !!match, menuHidden, catalog, argumentText === undefined]);
  const suggestions = guideOpen ? (argumentStep?.suggestions ?? []) : [];
  const menuSize = guideOpen ? suggestions.length : completions.length;
  // An optional argument can be skipped, so Enter sends until the user types or navigates.
  const autoHighlight =
    !argumentStep ||
    argumentStep.token !== "" ||
    (argumentStep.active !== undefined && !!commandArguments?.[argumentStep.active]?.required);
  const highlighted =
    menuSize && (navigated || autoHighlight) ? Math.min(selected, menuSize - 1) : -1;

  function choose(item: Completion) {
    const continues = item.kind === "custom" && !!catalogCommand(item.id)?.arguments?.length;
    insertingCompletion.current = continues ? "keep" : "hide";
    input.current?.complete(
      item.insertText,
      (match?.[2]?.length ?? 0) + 1,
      item.kind === "skill" ? { id: item.id, name: item.name } : undefined,
    );
    if (item.kind === "skill") setSkills([...new Set([...skillIds, item.id])].slice(0, 32));
    if (item.kind !== "skill") setCommandId(item.id);
  }

  function catalogCommand(id: string) {
    return catalog?.commands.find((entry) => entry.id === id);
  }

  function chooseArgument(item: ArgumentSuggestion) {
    insertingCompletion.current = "keep";
    // Replace the whole token, including any part after the cursor.
    const after = tokenRemainder(argumentText ?? "", plainText.slice(prefix.length));
    input.current?.complete(item.insertText, argumentStep?.token.length ?? 0, undefined, {
      space: !item.continues,
      after,
    });
  }

  function chooseAt(index: number) {
    const suggestion = guideOpen ? suggestions[index] : undefined;
    if (suggestion) return chooseArgument(suggestion);
    const completion = guideOpen ? undefined : completions[index];
    if (completion) choose(completion);
  }

  function moveHighlight(down: boolean) {
    // Without a highlight, Down starts at the first item and Up at the last.
    const start = down ? menuSize - 1 : 0;
    const from = highlighted >= 0 ? highlighted : start;
    setNavigated(true);
    setSelected((from + (down ? 1 : menuSize - 1)) % menuSize);
  }

  function submit() {
    if (
      disabled ||
      props.offline ||
      !editorReady ||
      props.submitting ||
      (!text.trim() && attachments.length === 0)
    )
      return;
    if (input.current?.hasMissingAttachments()) {
      toast.add({ title: "Reattach or remove the missing files before sending.", type: "error" });
      return;
    }
    if (text.length > 65_536) {
      toast.add({ title: "Messages can contain up to 65,536 characters.", type: "error" });
      return;
    }
    if (!commandId && matching.length > 1) {
      toast.add({ title: "Choose the command from the menu to resolve its name.", type: "error" });
      return;
    }
    if (commandId && !command) {
      setCommandId(undefined);
      toast.add({ title: "The selected command changed. Choose it again.", type: "error" });
      return;
    }
    const invalidArgument =
      custom && commandArguments
        ? validateCommandArguments(commandArguments, plainText.slice(custom.name.length + 2))
        : undefined;
    if (invalidArgument) {
      setArgumentError(invalidArgument);
      setMenuHidden(false);
      return;
    }
    if (command?.kind === "builtin" && command.id === "cancel") {
      props.onCancel();
      onText("");
      setCommandId(undefined);
      return;
    }
    if (command?.kind === "builtin" && command.id === "model") {
      document.getElementById("composer-model")?.focus();
      onText("");
      setCommandId(undefined);
      return;
    }
    props.onSubmit({
      text: input.current?.submissionText() ?? text,
      ...(attachments.length ? { attachmentText: text } : {}),
      skillIds,
      mode: delivery.mode === "prompt" ? mode : delivery.mode,
      modelId: delivery.modelId,
      command: custom
        ? { id: custom.id, arguments: plainText.slice(custom.name.length + 2) }
        : undefined,
      attachments: [...attachments],
    });
    setSkills([]);
    setCommandId(undefined);
    setMenuHidden(true);
  }

  function keydown(event: KeyboardEvent) {
    if (event.isComposing) return;
    if ((menuSize || guideOpen) && event.key === "Escape") {
      event.preventDefault();
      setMenuHidden(true);
      return;
    }
    if (menuSize && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
      event.preventDefault();
      moveHighlight(event.key === "ArrowDown");
      return;
    }
    if (menuSize && event.key === "Tab" && !event.shiftKey) {
      event.preventDefault();
      chooseAt(Math.max(0, highlighted));
      return;
    }
    const typedSuggestion =
      guideOpen &&
      !suggestions[highlighted]?.continues &&
      suggestions[highlighted]?.insertText === argumentStep?.token;
    if (event.key === "Enter" && highlighted >= 0 && !typedSuggestion) {
      event.preventDefault();
      chooseAt(highlighted);
      return;
    }
    if (event.key === "Enter" && !event.shiftKey) {
      if (window.matchMedia("(pointer: coarse)").matches) return;
      event.preventDefault();
      submit();
    }
  }
  const pastes = useRef(new Set<{ controller: AbortController; cancel: () => void }>());
  useEffect(
    () => () => {
      for (const paste of pastes.current) {
        paste.controller.abort();
        paste.cancel();
      }
      pastes.current.clear();
    },
    [props.documentKey],
  );

  async function pasteMessage(message: MessageClipboard) {
    const editor = input.current;
    const resourceUrl = workspace?.resourceUrl;
    if (!editor || !resourceUrl) return;
    const documentKey = props.documentKey;
    const target = editor.capturePaste();
    const controller = new AbortController();
    const paste = { controller, cancel: target.cancel };
    pastes.current.add(paste);
    await attempt(
      async () => {
        const downloads = await Promise.all(
          message.resources.map(async (resource) => {
            const response = await fetch(resourceUrl(resource.resourceId), {
              signal: controller.signal,
            });
            if (!response.ok) return Result.err(`Could not copy attachment ${resource.name}`);
            return Result.ok(
              new File([await response.blob()], resource.name, { type: resource.mediaType }),
            );
          }),
        );
        const files = Result.all(downloads).match({
          ok: (files) => files,
          err: (message) => {
            if (!controller.signal.aborted && dropProps.current.documentKey === documentKey)
              toast.add({ title: message, type: "error" });
            return undefined;
          },
        });
        if (!files) return;
        const { restoreMessageAttachments } = await import("./composer-editor");
        if (
          controller.signal.aborted ||
          dropProps.current.documentKey !== documentKey ||
          dropProps.current.disabled
        )
          return;
        if (dropProps.current.attachments.length + files.length > 32) {
          toast.add({ title: "A message can contain at most 32 attachments.", type: "error" });
          return;
        }
        const added = dropProps.current.onAttach(files, true);
        if (!added || added.length !== files.length) {
          toast.add({ title: "A message can contain at most 32 attachments.", type: "error" });
          return;
        }
        target.insert(
          restoreMessageAttachments(
            message.text,
            new Map(
              message.resources.map((resource, index) => [resource.resourceId, added[index]!]),
            ),
          ),
        );
      },
      (message) => {
        if (!controller.signal.aborted && dropProps.current.documentKey === documentKey)
          toast.add({ title: message, type: "error" });
      },
    );
    controller.abort();
    target.cancel();
    pastes.current.delete(paste);
  }

  function paste(event: ClipboardEvent) {
    if (disabled || !event.clipboardData) return;
    const message = readMessageClipboard(event.clipboardData.getData("text/html"));
    if (message && workspace) {
      event.preventDefault();
      void pasteMessage(message);
      return;
    }
    const files = [...event.clipboardData.files];
    if (files.length) {
      event.preventDefault();
      props.onAttach(files.map(namePastedImage));
    }
  }
  function drop(event: DragEvent) {
    if (!hasFileDrag(event.dataTransfer)) return;
    event.preventDefault();
    setDragging(false);
    if (disabled) return;
    props.onAttach([...event.dataTransfer.files]);
  }

  const changeText = useEventCallback((value: string, visibleText: string, badges: string[]) => {
    setEditorValue({
      text: value,
      plainText: visibleText,
      documentKey: props.documentKey,
    });
    setArgumentError(undefined);
    setSelected(0);
    setNavigated(false);
    if (insertingCompletion.current) {
      setMenuHidden(insertingCompletion.current === "hide");
      insertingCompletion.current = undefined;
      onText(value);
      return;
    }
    const chosen = catalog?.commands.find((entry) => entry.id === commandId);
    if (
      chosen &&
      visibleText.trim() !== `/${chosen.name}` &&
      !visibleText.startsWith(`/${chosen.name} `)
    )
      setCommandId(undefined);
    const badgeSkills = badges.slice(0, 32);
    if (badgeSkills.join("\n") !== skillIds.join("\n")) setSkills(badgeSkills);
    onText(value);
    setMenuHidden(false);
  });
  const editorKeyDown = useEventCallback(keydown);
  const editorPaste = useEventCallback(paste);

  return (
    <div
      className={`composer-wrap relative ${dragging ? "is-dragging" : ""}`}
      onDragOver={
        props.windowDrop
          ? undefined
          : (event) => {
              if (!hasFileDrag(event.dataTransfer)) return;
              event.preventDefault();
              setDragging(!disabled);
            }
      }
      onDragLeave={props.windowDrop ? undefined : () => setDragging(false)}
      onDrop={props.windowDrop ? undefined : drop}
    >
      {props.windowDrop && dragging && !disabled
        ? createPortal(
            <div
              className="composer-window-drop fixed inset-3 z-100 flex items-center justify-center flex-col gap-4 rounded-lg [background:color-mix(in_srgb,_var(--ui-background)_88%,_transparent)] [backdrop-filter:blur(calc(var(--ui-space-unit)*1))] text-foreground text-xl font-medium pointer-events-none [box-shadow:inset_0_0_0_calc(var(--ui-space-unit)*1)_color-mix(in_srgb,_var(--ui-primary)_65%,_transparent)]"
              role="status"
            >
              <Upload aria-hidden="true" />
              <span>Add photos &amp; files</span>
            </div>,
            document.body,
          )
        : null}
      <Popover
        open={completions.length > 0 || guideOpen}
        onOpenChange={(open) => {
          if (!open) setMenuHidden(true);
        }}
      >
        <PopoverTrigger
          nativeButton={false}
          render={<span className="composer-completion-anchor block w-full h-0" />}
          tabIndex={-1}
          aria-hidden
        />
        <PopoverContent
          side="top"
          align="start"
          initialFocus={false}
          finalFocus={false}
          className="completion-popover absolute left-0 right-0 bottom-[calc(100%_+_calc(var(--ui-space-unit)*2))] h-80 p-[calc(calc(var(--ui-space-unit)*1)_*_1.5)] rounded-lg bg-surface-raised shadow-overlay z-20"
          data-mode={guideOpen ? "arguments" : undefined}
        >
          {guideOpen && custom && commandArguments ? (
            <CommandGuide
              name={custom.name}
              args={commandArguments}
              step={argumentStep}
              error={argumentError ?? argumentStep?.error}
            />
          ) : null}
          {menuSize ? (
            <div
              id="composer-completions"
              role="listbox"
              aria-label={completionLabel(guideOpen, trigger)}
              className="completion-list min-h-0 flex-1"
              style={guideOpen ? { height: Math.min(menuSize, 6) * 44 } : undefined}
            >
              {guideOpen ? (
                <VirtualList
                  items={suggestions}
                  itemKey={(item) => item.id}
                  label="Suggestions"
                  presentation
                  activeIndex={highlighted < 0 ? undefined : highlighted}
                  estimate={44}
                  render={(item, index) => (
                    <CompletionOption
                      index={index}
                      selected={index === highlighted}
                      name={item.label}
                      description={item.description}
                      mono
                      onChoose={() => chooseArgument(item)}
                    />
                  )}
                />
              ) : (
                <VirtualList
                  items={completions}
                  itemKey={(item) => `${item.kind}:${item.id}`}
                  label="Suggestions"
                  presentation
                  activeIndex={highlighted}
                  estimate={44}
                  render={(item, index) => (
                    <CompletionOption
                      index={index}
                      selected={index === highlighted}
                      name={trigger === "/" ? item.insertText : item.name}
                      description={item.description}
                      source={item.source}
                      onChoose={() => choose(item)}
                    />
                  )}
                />
              )}
            </div>
          ) : null}
        </PopoverContent>
      </Popover>
      <div className="composer bg-surface text-card-foreground rounded-lg p-3">
        <Suspense
          fallback={
            <div role="status" aria-label="Loading editor">
              <div className="composer-formatting flex gap-1 px-1 flex-wrap" aria-hidden="true">
                {[0, 1, 2, 3, 4, 5, 6, 7, 8].map((index) => (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="icon-button rounded-sm text-muted-foreground"
                    disabled
                    key={index}
                  />
                ))}
              </div>
              <div className="composer-editor" />
            </div>
          }
        >
          <ComposerEditor
            documentKey={props.documentKey}
            loadingDraft={props.loadingDraft}
            autoFocus={props.autoFocus}
            ref={input}
            text={text}
            attachments={attachments}
            skills={skills}
            onRemoveAttachment={props.onRemoveAttachment}
            onRetryAttachment={props.onRetryAttachment}
            onText={changeText}
            onPlainText={updatePlainText}
            onPrefix={setPrefix}
            onKeyDown={editorKeyDown}
            onPaste={editorPaste}
            placeholder={placeholder}
            expanded={menuSize > 0}
            activeDescendant={highlighted >= 0 ? `completion-${highlighted}` : undefined}
            disabled={disabled}
          />
        </Suspense>
        <footer className="composer-toolbar pl-2 flex flex-wrap gap-1 items-center pt-2">
          <ComposerModel
            models={catalog?.models}
            modelId={props.modelId}
            disabled={disabled || delivery.mode === "steer"}
            onChange={props.onModelChange}
          />
          <span className="toolbar-spacer flex-1" />
          {active ? (
            <div className="queue-mode flex shrink-0 items-center text-muted-foreground">
              <Select
                disabled={!!custom}
                value={delivery.mode}
                onValueChange={(value) => setMode(value === "followup" ? "followup" : "steer")}
              >
                <SelectTrigger
                  aria-label={
                    custom
                      ? "Custom commands queue as follow-ups"
                      : "When sent during an active run"
                  }
                >
                  <SelectValue>{delivery.mode === "followup" ? "Queue" : "Steer"}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="steer">Steer</SelectItem>
                  <SelectItem value="followup">Queue</SelectItem>
                </SelectContent>
              </Select>
            </div>
          ) : null}
          <input
            ref={fileInput}
            type="file"
            aria-label="Attach files"
            multiple
            className="sr-only absolute w-px h-px overflow-hidden [clip:rect(0,_0,_0,_0)] whitespace-nowrap"
            tabIndex={-1}
            onChange={(event) => {
              props.onAttach([...(event.target.files ?? [])]);
              event.target.value = "";
            }}
          />
          <IconButton
            label="Attach files"
            disabled={disabled}
            onClick={() => fileInput.current?.click()}
          >
            <Paperclip />
          </IconButton>
          {props.canCancel ? (
            <IconButton
              label="Cancel run"
              variant="destructive"
              className="rounded-full"
              onClick={props.onCancel}
            >
              <Square />
            </IconButton>
          ) : null}
          <IconButton
            label={active && custom ? "Queue command as follow-up" : "Send message"}
            tooltip={
              <>
                {active && custom ? "Queue command as follow-up" : "Send message"}
                <Kbd>Enter</Kbd>
              </>
            }
            aria-keyshortcuts="Enter"
            variant="default"
            className="rounded-full"
            disabled={
              disabled ||
              props.offline ||
              !editorReady ||
              props.submitting ||
              (!text.trim() && !attachments.length)
            }
            onClick={submit}
          >
            <ArrowUp />
          </IconButton>
        </footer>
      </div>
    </div>
  );
});

function CompletionOption(props: {
  index: number;
  selected: boolean;
  name: string;
  description?: string;
  source?: string;
  mono?: boolean;
  onChoose: () => void;
}) {
  return (
    <button
      type="button"
      role="option"
      aria-selected={props.selected}
      id={`completion-${props.index}`}
      className={`completion flex items-center gap-2 w-full p-3 text-left rounded-sm text-sm ${props.selected ? "selected" : ""}`}
      onMouseDown={(event) => event.preventDefault()}
      onClick={props.onChoose}
    >
      <span
        className={`completion-name font-[550] whitespace-nowrap ${props.mono ? "font-mono" : ""}`}
      >
        {props.name}
      </span>
      <span className="completion-description flex-1 whitespace-nowrap overflow-hidden text-ellipsis text-muted-foreground">
        {props.description}
      </span>
      {props.source ? (
        <span className="badge inline-flex items-center gap-1 bg-surface-hover text-muted-foreground rounded-sm py-1 px-2 text-xs whitespace-nowrap">
          {props.source}
        </span>
      ) : null}
    </button>
  );
}

const argumentTypeLabels: Record<CommandArgument["type"], string> = {
  string: "Text",
  number: "Number",
  boolean: "Yes or no",
};

function argumentDetail(arg: CommandArgument): string {
  const type = arg.choices?.length ? "Choice" : argumentTypeLabels[arg.type];
  return [type, arg.required ? "required" : "optional", arg.description]
    .filter(Boolean)
    .join(" · ");
}

const CommandGuide = memo(function CommandGuide({
  name,
  args,
  step,
  error,
}: {
  name: string;
  args: readonly CommandArgument[];
  step?: ArgumentStep;
  error?: ArgumentError;
}) {
  const active = error ? error.index : step?.active;
  const inPrompt = !error && !!step && step.active === undefined;
  const activeArg = active === undefined ? undefined : args[active];
  return (
    <div className="command-guide flex flex-col gap-1.5 px-2 pt-1" data-ui="command-guide">
      <div className="flex flex-wrap items-center gap-1 font-mono text-xs" aria-hidden>
        <span className="text-muted-foreground pr-1">/{name}</span>
        {args.map((arg, index) => {
          const value = step?.values[index];
          const state = chipState(index === active, !!error, value !== undefined);
          return (
            <span
              key={arg.key}
              data-state={state}
              className={`inline-flex items-center max-w-48 rounded-sm px-1.5 py-0.5 transition-colors ${guideChipStyles[state]}`}
            >
              <span className="shrink-0">
                {arg.key}
                {arg.required || value !== undefined ? "" : "?"}
              </span>
              {value !== undefined && state !== "active" ? (
                <span className="truncate text-muted-foreground">={value}</span>
              ) : null}
            </span>
          );
        })}
        <span
          data-state={inPrompt ? "active" : "pending"}
          className={`inline-flex items-center rounded-sm px-1.5 py-0.5 transition-colors ${guideChipStyles[inPrompt ? "active" : "pending"]}`}
        >
          prompt…
        </span>
      </div>
      <p
        className={`flex items-center gap-1.5 min-h-[1lh] text-xs ${error ? "text-danger" : "text-muted-foreground"}`}
        aria-live="polite"
      >
        {error ? <CircleAlert className="size-3.5 shrink-0" aria-hidden /> : null}
        <span className="truncate">{guideMessage(error, activeArg)}</span>
      </p>
    </div>
  );
});

type ChipState = "active" | "error" | "filled" | "pending";

const guideChipStyles: Record<ChipState, string> = {
  active: "bg-primary/10 text-primary",
  error: "bg-danger/10 text-danger",
  filled: "bg-surface-hover text-foreground",
  pending: "text-muted-foreground",
};

function chipState(active: boolean, invalid: boolean, filled: boolean): ChipState {
  if (active) return invalid ? "error" : "active";
  return filled ? "filled" : "pending";
}

function guideMessage(error?: ArgumentError, arg?: CommandArgument): string {
  if (error) return error.message;
  if (arg) return `${arg.key}: ${argumentDetail(arg)}`;
  return "Add instructions for the reply, or press Enter to send.";
}

function completionLabel(argumentsOpen: boolean, trigger: "$" | "/"): string {
  if (argumentsOpen) return "Argument values";
  return trigger === "$" ? "Skills" : "Commands and skills";
}

const ComposerModel = memo(function ComposerModel({
  models,
  modelId,
  disabled,
  onChange,
}: {
  models: NonNullable<ComposerProps["catalog"]>["models"] | undefined;
  modelId?: string;
  disabled: boolean;
  onChange: (modelId: string) => void;
}) {
  return (
    <Select
      items={models?.map((model) => ({ value: model.id, label: model.label }))}
      value={modelId ?? models?.[0]?.id ?? ""}
      disabled={disabled}
      onValueChange={(value) => {
        if (!value) return;
        onChange(value);
      }}
    >
      <SelectTrigger
        id="composer-model"
        aria-label="Response model"
        className="composer-model [flex:0_1_auto] min-w-0 max-w-full"
      >
        <SelectValue className="min-w-0">
          <span className="truncate">
            {models?.find((entry) => entry.id === (modelId ?? models?.[0]?.id))?.label}
          </span>
        </SelectValue>
      </SelectTrigger>
      <SelectContent>
        {models?.map((model) => (
          <SelectItem key={model.id} value={model.id}>
            {model.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
});
