import { Result } from "better-result";
import type { CSSProperties } from "react";
import { z } from "zod";
import { createStore } from "zustand/vanilla";
import { useStore } from "zustand";
import { cachedThemePair, loadThemePair, themeIds, type ThemeId } from "./catalog";
import type { ResolvedTheme, ThemeKind } from "./resolve-theme";

export type ThemeMode = "light" | "dark" | "system";
export type ThemeSelection = Record<ThemeKind, ThemeId>;
const selectionKey = "lilac-theme-palette-v1";
const modeKey = "lilac-theme-v1";
const selectionSchema = z.object({ light: z.enum(themeIds), dark: z.enum(themeIds) });
const lilac = cachedThemePair("lilac")!;
const defaultSelection: ThemeSelection = { light: "lilac", dark: "lilac" };
let appliedSelection = defaultSelection;
const themeStore = createStore(() => ({
  mode: "system" as ThemeMode,
  selection: defaultSelection,
  themes: lilac,
  syntax: lilac.dark.syntax,
  applied: { kind: "dark" as ThemeKind, theme: lilac.dark },
}));

export function useThemeMode() {
  return useStore(themeStore, (state) => state.mode);
}

export function useSyntaxTheme() {
  return useStore(themeStore, (state) => state.syntax);
}

export function useThemeSelection() {
  return useStore(themeStore, (state) => state.selection);
}

export function useAppliedTheme() {
  return useStore(themeStore, (state) => state.applied);
}

export function useInstalledThemes() {
  return useStore(themeStore, (state) => state.themes);
}

export function themeStyle(theme: ResolvedTheme): CSSProperties {
  return Object.fromEntries(
    Object.entries(theme.variables).map(([name, value]) => [`--ui-${name}`, value]),
  );
}

function decodeThemeMode(value: string | null | undefined): ThemeMode {
  return value === "light" || value === "dark" ? value : "system";
}

/** Shows a color scheme without saving it, as the design-system preview does. */
export function setThemeMode(value: string) {
  themeStore.setState({ mode: decodeThemeMode(value) });
  applyTheme();
}

/** Applies the person's color scheme and remembers it in this browser. */
export function chooseThemeMode(value: string) {
  setThemeMode(value);
  const saved = Result.try({
    try: () => localStorage.setItem(modeKey, themeStore.getState().mode),
    catch: () => "Storage unavailable",
  });
  saved.match({ ok: () => {}, err: () => {} });
}

export function installThemes(pair: { light: ResolvedTheme; dark: ResolvedTheme }) {
  themeStore.setState({ themes: pair });
  applyTheme();
}

export async function selectTheme(id: ThemeId, kinds: readonly ThemeKind[]) {
  const current = themeStore.getState().selection;
  const selection: ThemeSelection = {
    light: kinds.includes("light") ? id : current.light,
    dark: kinds.includes("dark") ? id : current.dark,
  };
  themeStore.setState({ selection });
  if (!(await applySelection(selection))) return;
  const saved = Result.try({
    try: () => localStorage.setItem(selectionKey, JSON.stringify(selection)),
    catch: () => "Storage unavailable",
  });
  saved.match({ ok: () => {}, err: () => {} });
}

// The picker shows a choice before its themes load, so a failed load restores the installed one.
async function applySelection(selection: ThemeSelection) {
  const [light, dark] = await Promise.all([
    loadThemePair(selection.light),
    loadThemePair(selection.dark),
  ]);
  if (themeStore.getState().selection !== selection) return false;
  const pair = Result.all([light, dark]).match({
    ok: ([lightPair, darkPair]) => ({ light: lightPair.light, dark: darkPair.dark }),
    err: () => undefined,
  });
  if (!pair) {
    themeStore.setState({ selection: appliedSelection });
    return false;
  }
  appliedSelection = selection;
  installThemes(pair);
  return true;
}

function effectiveKind(): ThemeKind {
  const mode = themeStore.getState().mode;
  if (mode !== "system") return mode;
  return matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

function applyTheme() {
  const kind = effectiveKind();
  const theme = themeStore.getState().themes[kind];
  const root = document.documentElement;
  root.dataset.theme = themeStore.getState().mode;
  root.style.colorScheme = kind;
  for (const [name, value] of Object.entries(theme.variables))
    root.style.setProperty(`--ui-${name}`, value);
  const applied = themeStore.getState().applied;
  if (applied.kind !== kind || applied.theme !== theme)
    themeStore.setState({ applied: { kind, theme } });
  if (themeStore.getState().syntax !== theme.syntax) themeStore.setState({ syntax: theme.syntax });
}

export function readTheme(): ThemeMode {
  return Result.try({
    try: () => localStorage.getItem(modeKey),
    catch: () => "Storage unavailable",
  }).match({ ok: decodeThemeMode, err: () => "system" });
}

export function decodeThemeSelection(raw: string | null): ThemeSelection {
  if (raw === null) return defaultSelection;
  return Result.try({ try: () => JSON.parse(raw), catch: () => "Invalid theme selection" }).match({
    ok: (value) => {
      const parsed = selectionSchema.safeParse(value);
      return parsed.success ? parsed.data : defaultSelection;
    },
    err: () => defaultSelection,
  });
}

function readSelection(): ThemeSelection {
  return Result.try({
    try: () => localStorage.getItem(selectionKey),
    catch: () => "Storage unavailable",
  }).match({
    ok: decodeThemeSelection,
    err: () => defaultSelection,
  });
}

export function watchSystemTheme() {
  themeStore.setState({ mode: readTheme() });
  const media = matchMedia("(prefers-color-scheme: light)");
  media.addEventListener("change", applyTheme);
  applyTheme();
  return () => media.removeEventListener("change", applyTheme);
}

export async function loadSavedTheme() {
  const selection = readSelection();
  themeStore.setState({ selection });
  await applySelection(selection);
}
