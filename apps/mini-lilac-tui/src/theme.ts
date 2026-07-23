import { RGBA, SyntaxStyle, type StyleDefinitionInput, type TerminalColors } from "@opentui/core";

export interface ThemeColors {
  readonly background: string;
  readonly panel: string;
  readonly raised: string;
  readonly selection: string;
  readonly toolBackground: string;
  readonly border: string;
  readonly text: string;
  readonly selectedText: string;
  readonly muted: string;
  readonly accent: string;
  readonly success: string;
  readonly warning: string;
  readonly danger: string;
  readonly tool: string;
  readonly model: string;
  readonly syntaxType: string;
  readonly syntaxOperator: string;
  readonly syntaxBuiltin: string;
  readonly syntaxPunctuation: string;
}

export const COLORS: ThemeColors = {
  background: "#0d1011",
  panel: "#151a1b",
  raised: "#1a2122",
  selection: "#223031",
  toolBackground: "#181b22",
  border: "#303a3b",
  text: "#d7dedb",
  selectedText: "#0d1011",
  muted: "#7d8987",
  accent: "#70d6c4",
  success: "#91d39b",
  warning: "#d9b96f",
  danger: "#e17e74",
  tool: "#d3a0c5",
  model: "#9eb8df",
  syntaxType: "#9eb8df",
  syntaxOperator: "#d3a0c5",
  syntaxBuiltin: "#e5a36f",
  syntaxPunctuation: "#87918f",
};

export function createTerminalTheme(colors: TerminalColors): ThemeColors {
  const background = colors.defaultBackground ?? colors.palette[0];
  const text = colors.defaultForeground ?? colors.palette[7];
  if (background === null || background === undefined || text === null || text === undefined) {
    return COLORS;
  }

  const accent = colors.palette[6] ?? COLORS.accent;
  const success = colors.palette[2] ?? COLORS.success;
  const warning = colors.palette[3] ?? COLORS.warning;
  const danger = colors.palette[1] ?? COLORS.danger;
  const tool = colors.palette[5] ?? COLORS.tool;
  const model = colors.palette[4] ?? COLORS.model;
  const light = luminance(background) > 0.5;

  return {
    background: "transparent",
    panel: blend(background, text, light ? 0.05 : 0.06),
    raised: blend(background, text, light ? 0.09 : 0.1),
    selection: blend(background, accent, light ? 0.12 : 0.18),
    toolBackground: blend(background, tool, light ? 0.07 : 0.1),
    border: blend(background, text, light ? 0.24 : 0.28),
    text,
    selectedText: background,
    muted: blend(background, text, light ? 0.58 : 0.56),
    accent,
    success,
    warning,
    danger,
    tool,
    model,
    syntaxType: colors.palette[12] ?? model,
    syntaxOperator: tool,
    syntaxBuiltin: colors.palette[9] ?? danger,
    syntaxPunctuation: blend(background, text, light ? 0.68 : 0.64),
  };
}

function blend(background: string, foreground: string, amount: number): string {
  const bg = RGBA.fromHex(background);
  const fg = RGBA.fromHex(foreground);
  const channel = (base: number, overlay: number) =>
    Math.round((base + (overlay - base) * amount) * 255)
      .toString(16)
      .padStart(2, "0");
  return `#${channel(bg.r, fg.r)}${channel(bg.g, fg.g)}${channel(bg.b, fg.b)}`;
}

function luminance(color: string): number {
  const value = RGBA.fromHex(color);
  return 0.299 * value.r + 0.587 * value.g + 0.114 * value.b;
}

function markdownSyntaxStyles(colors: ThemeColors) {
  const comment = { fg: colors.muted, italic: true } satisfies StyleDefinitionInput;
  const string = { fg: colors.success } satisfies StyleDefinitionInput;
  const number = { fg: colors.warning } satisfies StyleDefinitionInput;
  const keyword = { fg: colors.danger, italic: true } satisfies StyleDefinitionInput;
  const callable = { fg: colors.accent } satisfies StyleDefinitionInput;
  const type = { fg: colors.syntaxType, bold: true } satisfies StyleDefinitionInput;
  const variable = { fg: colors.text } satisfies StyleDefinitionInput;
  const operator = { fg: colors.syntaxOperator } satisfies StyleDefinitionInput;
  const punctuation = { fg: colors.syntaxPunctuation } satisfies StyleDefinitionInput;
  const builtin = { fg: colors.syntaxBuiltin } satisfies StyleDefinitionInput;

  return {
    default: { fg: colors.text },
    conceal: { fg: colors.muted },
    "markup.heading": { fg: colors.text, bold: true },
    "markup.heading.1": { fg: colors.text, bold: true },
    "markup.heading.2": { fg: colors.text, bold: true },
    "markup.heading.3": { fg: colors.text, bold: true },
    "markup.heading.4": { fg: colors.text, bold: true },
    "markup.heading.5": { fg: colors.text, bold: true },
    "markup.heading.6": { fg: colors.text, bold: true },
    "markup.strong": { fg: colors.text, bold: true },
    "markup.bold": { fg: colors.text, bold: true },
    "markup.italic": { fg: colors.warning, italic: true },
    "markup.strikethrough": { fg: colors.muted, dim: true },
    "markup.list": { fg: colors.accent },
    "markup.quote": { fg: colors.warning, dim: true },
    "markup.raw": { fg: colors.success },
    "markup.raw.block": { fg: colors.text },
    "markup.raw.inline": { fg: colors.success },
    "markup.link": { fg: colors.accent, underline: true },
    "markup.link.label": { fg: colors.accent },
    "markup.link.url": { fg: colors.muted, underline: true },
    comment,
    "comment.documentation": comment,
    string,
    symbol: string,
    character: string,
    "character.special": string,
    "string.escape": keyword,
    "string.regexp": keyword,
    number,
    boolean: number,
    constant: number,
    keyword,
    "keyword.return": keyword,
    "keyword.conditional": keyword,
    "keyword.repeat": keyword,
    "keyword.coroutine": keyword,
    "keyword.import": keyword,
    "keyword.modifier": keyword,
    "keyword.exception": keyword,
    "keyword.directive": keyword,
    "keyword.type": type,
    "keyword.function": callable,
    operator,
    "keyword.operator": operator,
    "keyword.conditional.ternary": operator,
    function: callable,
    "function.call": callable,
    "function.method": callable,
    "function.method.call": callable,
    constructor: callable,
    type,
    class: type,
    module: type,
    variable,
    "variable.parameter": variable,
    "variable.member": variable,
    parameter: variable,
    property: variable,
    "variable.builtin": builtin,
    "type.builtin": builtin,
    "function.builtin": builtin,
    "module.builtin": builtin,
    "constant.builtin": builtin,
    "variable.super": builtin,
    punctuation,
    "punctuation.bracket": punctuation,
    "punctuation.delimiter": operator,
    "punctuation.special": operator,
    tag: callable,
    attribute: number,
    label: type,
  } satisfies Record<string, StyleDefinitionInput>;
}

export const MARKDOWN_SYNTAX_STYLES = markdownSyntaxStyles(COLORS);

export function createMarkdownSyntaxStyle(colors: ThemeColors = COLORS): SyntaxStyle {
  return SyntaxStyle.fromStyles(markdownSyntaxStyles(colors));
}
