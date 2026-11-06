import { useSyntaxTheme } from "../theme/theme";
import { CodeBlock } from "./CodeBlock";
import { Result, type Result as ResultType } from "better-result";
import { RichRenderFailed } from "./rich-render-error";
import { memo, useEffect, useState } from "react";
import {
  createCssVariablesTheme,
  createHighlighterCore,
  type ThemedToken,
  type ThemeRegistration,
} from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
import { syntaxLanguages } from "./syntax-languages";

const highlighter = createHighlighterCore({
  themes: [
    createCssVariablesTheme({
      name: "native",
      variablePrefix: "--syntax-",
      variableDefaults: {
        foreground: "var(--ui-foreground)",
        background: "transparent",
        "token-constant": "var(--ui-primary)",
        "token-string": "var(--ui-foreground)",
        "token-comment": "var(--ui-muted-foreground)",
        "token-keyword": "var(--ui-primary)",
        "token-parameter": "var(--ui-foreground)",
        "token-function": "var(--ui-primary)",
        "token-string-expression": "var(--ui-foreground)",
        "token-punctuation": "var(--ui-muted-foreground)",
        "token-link": "var(--ui-primary)",
      },
    }),
  ],
  langs: syntaxLanguages,
  engine: createJavaScriptRegexEngine(),
});
const cache = new Map<string, Promise<ThemedToken[][]>>();
const themeIds = new WeakMap<ThemeRegistration, string>();
let nextThemeId = 0;

function syntaxThemeId(theme?: ThemeRegistration): string {
  if (!theme) return "native";
  const cached = themeIds.get(theme);
  if (cached) return cached;
  const id = `imported-${++nextThemeId}`;
  themeIds.set(theme, id);
  return id;
}

const MAX_SOURCE = 128 * 1024;

export function highlightCode(
  source: string,
  language: string,
  theme?: ThemeRegistration,
): Promise<ThemedToken[][]> {
  if (source.length > MAX_SOURCE) return renderTokens(source, "text", theme);
  const key = `${syntaxThemeId(theme)}\u0000${language}\u0000${source}`;
  const previous = cache.get(key);
  if (previous) return previous;
  const task = renderTokens(source, language, theme);
  cache.set(key, task);
  if (cache.size > 64) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  return task;
}

async function renderTokens(
  source: string,
  language: string,
  theme?: ThemeRegistration,
): Promise<ThemedToken[][]> {
  if (source.length > MAX_SOURCE || ["", "text", "plaintext", "txt"].includes(language))
    return source.split("\n").map((content) => [{ content, offset: 0 }]);
  const instance = await highlighter;
  let resolved = language.toLowerCase();
  if (!instance.getLoadedLanguages().includes(resolved)) {
    const { bundledLanguagesInfo } = await import("shiki/langs");
    const entry = bundledLanguagesInfo.find(
      (item) => item.id === resolved || item.aliases?.includes(resolved),
    );
    if (!entry) return source.split("\n").map((content) => [{ content, offset: 0 }]);
    await instance.loadLanguage(entry.import);
    resolved = entry.id;
  }
  const id = syntaxThemeId(theme);
  if (theme && !instance.getLoadedThemes().includes(id))
    await instance.loadTheme({ ...theme, name: id });
  return instance.codeToTokens(source, { lang: resolved, theme: id }).tokens;
}

export function loadCodeTokens(
  source: string,
  language: string,
  theme?: ThemeRegistration,
): Promise<ResultType<ThemedToken[][], RichRenderFailed>> {
  return Result.tryPromise({
    try: () => highlightCode(source, language, theme),
    catch: () => new RichRenderFailed({ message: "Code highlighting is unavailable" }),
  });
}

export default memo(function HighlightedCode({
  source,
  language,
}: {
  source: string;
  language: string;
}) {
  const theme = useSyntaxTheme();
  const [rendered, setRendered] = useState<{
    source: string;
    language: string;
    tokens: ThemedToken[][];
    theme?: ThemeRegistration;
  } | null>(null);
  useEffect(() => {
    let active = true;
    async function render() {
      const result = await loadCodeTokens(source, language, theme);
      if (!active) return;
      result.match({
        ok: (tokens) => setRendered({ source, language, tokens, theme }),
        err: () => setRendered(null),
      });
    }
    void render();
    return () => {
      active = false;
    };
  }, [source, language, theme]);
  if (rendered?.source !== source || rendered.language !== language || rendered.theme !== theme)
    return <CodeBlock source={source} language={language} />;
  return (
    <CodeBlock source={source} language={language}>
      {rendered.tokens.map((line, lineIndex) => (
        <span key={lineIndex}>
          {line.map((token, tokenIndex) => (
            <span
              key={tokenIndex}
              style={{
                color: token.color,
                backgroundColor: token.bgColor,
                fontStyle: token.fontStyle && token.fontStyle & 1 ? "italic" : undefined,
                fontWeight: token.fontStyle && token.fontStyle & 2 ? "bold" : undefined,
                textDecoration: token.fontStyle && token.fontStyle & 4 ? "underline" : undefined,
              }}
            >
              {token.content}
            </span>
          ))}
          {lineIndex < rendered.tokens.length - 1 ? "\n" : null}
        </span>
      ))}
    </CodeBlock>
  );
});
