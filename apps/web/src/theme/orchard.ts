import type { ThemeRegistration } from "shiki/core";

type OrchardPalette = {
  foreground: string;
  comment: string;
  punctuation: string;
  keyword: string;
  property: string;
  string: string;
  constant: string;
  function: string;
  type: string;
};

function tokenColors(palette: OrchardPalette): ThemeRegistration["tokenColors"] {
  return [
    {
      scope: ["comment", "punctuation.definition.comment"],
      settings: { foreground: palette.comment, fontStyle: "italic" },
    },
    {
      scope: ["string", "punctuation.definition.string"],
      settings: { foreground: palette.string },
    },
    { scope: ["meta.template.expression"], settings: { foreground: palette.foreground } },
    {
      scope: ["punctuation.definition.template-expression"],
      settings: { foreground: palette.keyword },
    },
    { scope: ["constant", "support.constant"], settings: { foreground: palette.constant } },
    { scope: ["keyword", "storage"], settings: { foreground: palette.keyword } },
    {
      scope: [
        "keyword.operator",
        "punctuation.separator",
        "punctuation.terminator",
        "punctuation.accessor",
        "punctuation.definition.block",
        "punctuation.definition.dictionary",
        "punctuation.definition.array",
        "punctuation.definition.typeparameters",
        "punctuation.definition.parameters",
        "punctuation.definition.sequence",
        "punctuation.definition.mapping",
        "punctuation.definition.logical-expression",
        "punctuation.definition.block.sequence.item.yaml",
        "meta.brace",
      ],
      settings: { foreground: palette.punctuation },
    },
    {
      scope: [
        "keyword.operator.new",
        "keyword.operator.expression",
        "keyword.operator.logical-word",
        "keyword.operator.typeof",
        "keyword.operator.instanceof",
      ],
      settings: { foreground: palette.keyword },
    },
    {
      scope: [
        "entity.name.type",
        "entity.name.class",
        "entity.other.inherited-class",
        "support.type",
        "support.class",
      ],
      settings: { foreground: palette.type },
    },
    {
      scope: ["entity.name.function", "support.function"],
      settings: { foreground: palette.function },
    },
    { scope: ["entity.name.tag"], settings: { foreground: palette.keyword } },
    {
      scope: [
        "entity.name.tag.yaml",
        "support.type.property-name",
        "punctuation.support.type.property-name",
        "variable.other.property",
        "variable.object.property",
        "meta.object-literal.key",
        "support.variable.property",
      ],
      settings: { foreground: palette.property },
    },
    { scope: ["variable.other.alias.yaml"], settings: { foreground: palette.property } },
    {
      scope: [
        "variable.other.normal.shell",
        "punctuation.definition.variable.shell",
        "variable.parameter",
        "variable.other.object",
        "variable.other.constant",
      ],
      settings: { foreground: palette.foreground },
    },
    { scope: ["markup.heading"], settings: { foreground: palette.keyword, fontStyle: "bold" } },
    { scope: ["markup.bold"], settings: { foreground: palette.foreground, fontStyle: "bold" } },
    { scope: ["markup.italic"], settings: { foreground: palette.foreground, fontStyle: "italic" } },
    { scope: ["markup.inline.raw", "markup.inserted"], settings: { foreground: palette.string } },
    { scope: ["markup.deleted"], settings: { foreground: palette.keyword } },
  ];
}

export const orchardSyntax = {
  dark: tokenColors({
    foreground: "#eeeaf1",
    comment: "#9a93a3",
    punctuation: "#a9a1b1",
    keyword: "#c5a8e0",
    property: "#94b8e0",
    string: "#a9c99b",
    constant: "#e8b08c",
    function: "#e3d08f",
    type: "#86c8bd",
  }),
  light: tokenColors({
    foreground: "#27212d",
    comment: "#6c6476",
    punctuation: "#5e5668",
    keyword: "#7647a0",
    property: "#2d6098",
    string: "#47763a",
    constant: "#a2531f",
    function: "#7f6410",
    type: "#1d7369",
  }),
};
