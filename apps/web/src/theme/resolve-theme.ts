import type { ThemeRegistration } from "shiki/core";
import { builtinThemes } from "./builtin";

export type ThemeKind = "light" | "dark";
export type ResolvedTheme = ReturnType<typeof resolveTheme>;
export type ThemeDefinition = Omit<ThemeRegistration, "type"> & { type?: string; include?: never };

// Theme input is resolved VS Code JSON imported by the application, not extension code.
export function resolveTheme(
  theme: ThemeDefinition,
  kind: ThemeKind = theme.type === "light" ? "light" : "dark",
) {
  const defaults: Record<string, string> = builtinThemes[kind].colors;
  const color = (key: string, fallback: string) => {
    const value = theme.colors?.[key];
    return value && /^#(?:[\da-f]{3,4}|[\da-f]{6}|[\da-f]{8})$/i.test(value) ? value : fallback;
  };
  const base = (key: string) => color(key, defaults[key] ?? "transparent");
  const background = base("editor.background");
  const foreground = color(
    "editor.foreground",
    color("foreground", defaults["editor.foreground"]!),
  );
  const surface = color("sideBar.background", background);
  const surfaceForeground = color("sideBar.foreground", foreground);
  const widget = color("editorWidget.background", surface);
  // Dialogs and menus sit on sidebar-colored controls, so they need a distinct surface.
  const raised =
    widget.toLowerCase() === surface.toLowerCase()
      ? `color-mix(in srgb, ${foreground} 6%, ${surface})`
      : widget;
  const raisedForeground = color("editorWidget.foreground", foreground);
  const primary = base("button.background");
  const hover = color("list.hoverBackground", `color-mix(in srgb, ${foreground} 8%, ${surface})`);
  const border = color(
    "contrastBorder",
    color(
      "panel.border",
      color("widget.border", `color-mix(in srgb, ${foreground} 12%, transparent)`),
    ),
  );
  const description = color(
    "descriptionForeground",
    `color-mix(in srgb, ${foreground} 65%, ${background})`,
  );
  const selection = color("list.activeSelectionBackground", hover);
  const selectionForeground = color("list.activeSelectionForeground", surfaceForeground);
  const menu = color("menu.background", raised);
  const menuForeground = color("menu.foreground", raisedForeground);
  const variables = {
    background,
    foreground,
    surface,
    "surface-foreground": surfaceForeground,
    sidebar: surface,
    "sidebar-foreground": surfaceForeground,
    "surface-raised": raised,
    "surface-raised-foreground": raisedForeground,
    "surface-hover": hover,
    "hover-foreground": color("list.hoverForeground", surfaceForeground),
    muted: `color-mix(in srgb, ${foreground} 5%, ${surface})`,
    "muted-foreground": description,
    primary,
    "primary-foreground": base("button.foreground"),
    "primary-hover": color("button.hoverBackground", primary),
    secondary: color("button.secondaryBackground", hover),
    "secondary-foreground": color("button.secondaryForeground", foreground),
    "secondary-hover": color("button.secondaryHoverBackground", raised),
    "input-background": color("input.background", surface),
    "input-foreground": color("input.foreground", foreground),
    "input-border": color("input.border", border),
    "input-placeholder": color("input.placeholderForeground", description),
    link: color("textLink.foreground", primary),
    "link-hover": color("textLink.activeForeground", primary),
    selection,
    "selection-foreground": selectionForeground,
    menu,
    "menu-foreground": menuForeground,
    "menu-selection": color(
      "menu.selectionBackground",
      `color-mix(in srgb, ${menuForeground} 12%, ${menu})`,
    ),
    "menu-selection-foreground": color("menu.selectionForeground", menuForeground),
    border,
    focus: color("focusBorder", primary),
    disabled: color("disabledForeground", description),
    danger: base("errorForeground"),
    success: base("testing.iconPassed"),
    warning: base("editorWarning.foreground"),
    info: base("editorInfo.foreground"),
    "line-number": color("editorLineNumber.foreground", description),
    "code-selection": color(
      "editor.selectionBackground",
      `color-mix(in srgb, ${primary} 14%, transparent)`,
    ),
    tint: `color-mix(in srgb, ${primary} 14%, ${surface})`,
    "tint-foreground": surfaceForeground,
    overlay: "#0009",
    "shadow-color": base("widget.shadow"),
  };
  const syntax: ThemeRegistration | undefined =
    theme.tokenColors || theme.settings ? { ...theme, type: kind } : undefined;
  return { kind, variables, syntax };
}
