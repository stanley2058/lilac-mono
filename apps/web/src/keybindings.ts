import { z } from "zod";
import { Result } from "better-result";
import { createStore } from "zustand/vanilla";
import type { CacheScope } from "@stanley2058/lilac-client";

export const threadActions = [
  "thread1",
  "thread2",
  "thread3",
  "thread4",
  "thread5",
  "thread6",
  "thread7",
  "thread8",
  "thread9",
  "thread10",
] as const;
export const shortcutActions = [
  "newThread",
  "settings",
  "sidebar",
  "rightPanel",
  ...threadActions,
] as const;
export type ShortcutAction = (typeof shortcutActions)[number];
const bindingSchema = z
  .object({
    code: z
      .string()
      .regex(
        /^(Key[A-Z]|Digit[0-9]|F([1-9]|1[0-2])|Comma|Period|Slash|Backslash|BracketLeft|BracketRight|Semicolon|Quote|Minus|Equal|Backquote|Space|Enter|Arrow(Up|Down|Left|Right))$/,
      ),
    mod: z.boolean(),
    alt: z.boolean(),
    shift: z.boolean(),
  })
  .strict()
  .refine((value) => value.mod || value.alt);
export type Keybinding = z.infer<typeof bindingSchema>;
export type Keybindings = Record<ShortcutAction, Keybinding | null>;
const storedSchema = z
  .object({
    version: z.literal(1),
    bindings: z.record(z.enum(shortcutActions), bindingSchema.nullable()),
  })
  .strict();
const binding = (code: string, alt = false, shift = false): Keybinding => ({
  code,
  mod: true,
  alt,
  shift,
});
export const defaultKeybindings: Keybindings = {
  newThread: binding("KeyN", true),
  settings: binding("Comma", false, true),
  sidebar: binding("Backslash"),
  rightPanel: binding("Backslash", false, true),
  thread1: binding("Digit1", true),
  thread2: binding("Digit2", true),
  thread3: binding("Digit3", true),
  thread4: binding("Digit4", true),
  thread5: binding("Digit5", true),
  thread6: binding("Digit6", true),
  thread7: binding("Digit7", true),
  thread8: binding("Digit8", true),
  thread9: binding("Digit9", true),
  thread10: binding("Digit0", true),
};
export const shortcutLabels: Record<ShortcutAction, string> = {
  newThread: "New conversation",
  settings: "Open settings",
  sidebar: "Toggle left sidebar",
  rightPanel: "Toggle right panel",
  thread1: "Conversation 1",
  thread2: "Conversation 2",
  thread3: "Conversation 3",
  thread4: "Conversation 4",
  thread5: "Conversation 5",
  thread6: "Conversation 6",
  thread7: "Conversation 7",
  thread8: "Conversation 8",
  thread9: "Conversation 9",
  thread10: "Conversation 10",
};
export function isMacKeyboard() {
  return typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.userAgent);
}
export function sameBinding(a: Keybinding | null, b: Keybinding | null) {
  return (
    a === b ||
    (!!a && !!b && a.code === b.code && a.mod === b.mod && a.alt === b.alt && a.shift === b.shift)
  );
}
export function bindingConflict(
  bindings: Keybindings,
  action: ShortcutAction,
  value: Keybinding | null,
) {
  if (!value) return undefined;
  return shortcutActions.find((other) => other !== action && sameBinding(bindings[other], value));
}
export function decodeKeybindings(raw: string | null): Keybindings {
  if (raw === null) return defaultKeybindings;
  return Result.try({ try: () => JSON.parse(raw), catch: () => "Invalid keybindings" }).match({
    ok: (value) => {
      const parsed = storedSchema.safeParse(value);
      if (!parsed.success) return defaultKeybindings;
      if (
        shortcutActions.some((action) =>
          bindingConflict(parsed.data.bindings, action, parsed.data.bindings[action]),
        )
      )
        return defaultKeybindings;
      return parsed.data.bindings;
    },
    err: () => defaultKeybindings,
  });
}
export function createKeybindings(scope?: Pick<CacheScope, "installationId" | "principalId">) {
  const key = scope
    ? `lilac-keybindings-v1:${JSON.stringify([scope.installationId, scope.principalId])}`
    : undefined;
  const bindings = key
    ? Result.try({
        try: () => localStorage.getItem(key),
        catch: () => "Storage unavailable",
      }).match({ ok: decodeKeybindings, err: () => defaultKeybindings })
    : defaultKeybindings;
  return createStore<{
    bindings: Keybindings;
    storageError?: string;
    targets: readonly string[];
    heldTargets?: readonly string[];
    showThreadHints: boolean;
    selectThread?: (id: string) => void;
    setBinding: (action: ShortcutAction, value: Keybinding | null) => void;
  }>((set, get) => ({
    bindings,
    targets: [],
    showThreadHints: false,
    setBinding(action, value) {
      if (bindingConflict(get().bindings, action, value)) return;
      const next = { ...get().bindings, [action]: value };
      const storageError = key
        ? Result.try({
            try: () => localStorage.setItem(key, JSON.stringify({ version: 1, bindings: next })),
            catch: () => "Changes apply for this session only. Storage is unavailable.",
          }).match({ ok: () => undefined, err: (error) => error })
        : undefined;
      set({ bindings: next, storageError });
    },
  }));
}
export function threadShortcutTarget(
  targets: readonly string[],
  heldTargets: readonly string[] | undefined,
  index: number,
) {
  const id = (heldTargets ?? targets)[index];
  return id && targets.includes(id) ? id : undefined;
}
export type KeybindingStore = ReturnType<typeof createKeybindings>;
export const previewKeybindings = createKeybindings();

type KeyEvent = Pick<
  KeyboardEvent,
  | "code"
  | "ctrlKey"
  | "metaKey"
  | "altKey"
  | "shiftKey"
  | "isComposing"
  | "repeat"
  | "getModifierState"
>;
export function recordedBinding(event: KeyEvent, mac = isMacKeyboard()): Keybinding | undefined {
  if (event.isComposing || event.repeat || event.getModifierState("AltGraph")) return undefined;
  if (mac ? event.ctrlKey : event.metaKey) return undefined;
  const parsed = bindingSchema.safeParse({
    code: event.code,
    mod: mac ? event.metaKey : event.ctrlKey,
    alt: event.altKey,
    shift: event.shiftKey,
  });
  return parsed.success ? parsed.data : undefined;
}
export function editingConflict(value: Keybinding | null) {
  if (!value) return false;
  if (value.code === "Space" || value.code === "Enter" || value.code.startsWith("Arrow"))
    return true;
  if (!value.mod) return true;
  if (value.alt) return false;
  return ["KeyA", "KeyB", "KeyC", "KeyI", "KeyU", "KeyV", "KeyX", "KeyY", "KeyZ"].includes(
    value.code,
  );
}
export function browserConflict(value: Keybinding | null, mac = isMacKeyboard()) {
  if (!value) return undefined;
  const plain = value.mod && !value.alt && !value.shift;
  const shifted = value.mod && value.shift && !value.alt;
  if (
    plain &&
    (value.code.startsWith("Digit") ||
      [
        "KeyN",
        "KeyT",
        "KeyW",
        "KeyL",
        "KeyR",
        "KeyF",
        "KeyP",
        "KeyS",
        "KeyD",
        "KeyH",
        "KeyJ",
        "KeyK",
        "KeyO",
        "Equal",
        "Minus",
      ].includes(value.code))
  )
    return "This shortcut is also used by the browser and may not reach Lilac.";
  if (
    shifted &&
    ["KeyN", "KeyT", "KeyW", "KeyB", "KeyR", "KeyJ", "KeyI", "KeyC"].includes(value.code)
  )
    return "This shortcut is also used by the browser and may not reach Lilac.";
  if (
    mac &&
    value.mod &&
    ((value.code === "Comma" && !value.shift && !value.alt) ||
      (value.code === "KeyB" && value.alt) ||
      (value.shift && ["Digit3", "Digit4", "Digit5"].includes(value.code)))
  )
    return "This shortcut is also used by macOS or the browser and may not reach Lilac.";
  return undefined;
}
const keyLabels: Record<string, string> = {
  Comma: ",",
  Period: ".",
  Slash: "/",
  Backslash: "\\",
  BracketLeft: "[",
  BracketRight: "]",
  Semicolon: ";",
  Quote: "'",
  Minus: "-",
  Equal: "=",
  Backquote: "`",
};
export function formatBinding(value: Keybinding | null, mac = isMacKeyboard()) {
  if (!value) return "";
  const labels = mac ? ["⌘", "⌥", "⇧"] : ["Ctrl", "Alt", "Shift"];
  return [
    value.mod ? labels[0] : "",
    value.alt ? labels[1] : "",
    value.shift ? labels[2] : "",
    keyLabels[value.code] ?? value.code.replace(/^(Key|Digit)/, ""),
  ]
    .filter(Boolean)
    .join(mac ? "" : "+");
}
export function ariaBinding(value: Keybinding | null, mac = isMacKeyboard()) {
  if (!value) return undefined;
  const modifier = mac ? "Meta" : "Control";
  return [
    value.mod ? modifier : "",
    value.alt ? "Alt" : "",
    value.shift ? "Shift" : "",
    keyLabels[value.code] ?? value.code.replace(/^(Key|Digit)/, ""),
  ]
    .filter(Boolean)
    .join("+");
}
