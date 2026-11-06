import * as monaco from "monaco-editor/esm/vs/editor/editor.api";
import "monaco-editor/esm/vs/editor/editor.all";
import YamlWorker from "./yaml.worker?worker";
import EditorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import { createHighlighterCore } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
import { shikiToMonaco } from "@shikijs/monaco";
import { Result } from "better-result";
import { syntaxLanguages } from "./syntax-languages";
import type { ResolvedTheme } from "../theme/resolve-theme";
import { builtinThemes } from "../theme/builtin";

self.MonacoEnvironment = {
  getWorker: (_id, label) => (label === "yaml" ? new YamlWorker() : new EditorWorker()),
};
// Monaco tokenizes incrementally. Its grammar state must not share the theme mutations of chat rendering.
const highlighter = createHighlighterCore({
  langs: syntaxLanguages,
  themes: [],
  engine: createJavaScriptRegexEngine(),
});
const createEditor = monaco.editor.create;
const setTheme = monaco.editor.setTheme;
let sequence = Promise.resolve();
let currentTheme: ResolvedTheme | undefined;
let currentThemeName = "vs-dark";
let nextTheme = 0;

export function prepareEditor(language: string, theme: ResolvedTheme) {
  const task = sequence.then(() => configure(language, theme));
  const captured = Result.tryPromise({
    try: () => task,
    catch: () => "Editor highlighting is unavailable",
  });
  sequence = captured.then(() => undefined);
  return captured;
}

async function configure(language: string, theme: ResolvedTheme) {
  const instance = await highlighter;
  let changed = false;
  if (
    !["text", "plaintext"].includes(language) &&
    !instance.getLoadedLanguages().includes(language)
  ) {
    const { bundledLanguagesInfo } = await import("shiki/langs");
    const entry = bundledLanguagesInfo.find(
      (item) => item.id === language || item.aliases?.includes(language),
    );
    if (entry) {
      await instance.loadLanguage(entry.import);
      changed = true;
    }
  }
  if (currentTheme !== theme) {
    currentThemeName = `lilac-editor-${++nextTheme}`;
    const base = builtinThemes[theme.kind];
    await instance.loadTheme({
      ...base,
      ...theme.syntax,
      name: currentThemeName,
      colors: {
        ...base.colors,
        "editor.background": theme.variables.background,
        "editor.foreground": theme.variables.foreground,
        ...theme.syntax?.colors,
      },
      tokenColors: theme.syntax?.tokenColors ??
        theme.syntax?.settings ?? [
          {
            scope: ["keyword", "entity.name.function", "constant"],
            settings: { foreground: theme.variables.primary },
          },
          { scope: "comment", settings: { foreground: theme.variables["muted-foreground"] } },
          { scope: "string", settings: { foreground: theme.variables.foreground } },
        ],
    });
    currentTheme = theme;
    changed = true;
  }
  if (changed || monaco.languages.getLanguages().length < 2) {
    const registered = new Set(monaco.languages.getLanguages().map((item) => item.id));
    for (const id of instance.getLoadedLanguages())
      if (!registered.has(id)) monaco.languages.register({ id });
    // The adapter wraps these methods; restore them before rebuilding its theme/language registry.
    monaco.editor.create = createEditor;
    monaco.editor.setTheme = setTheme;
    shikiToMonaco(instance, monaco);
  }
  monaco.editor.setTheme(currentThemeName);
  return monaco;
}

export { monaco };
