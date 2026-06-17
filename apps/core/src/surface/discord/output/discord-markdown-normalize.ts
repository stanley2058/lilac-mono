type FenceState = {
  marker: "`" | "~";
  markerLength: number;
};

function parseFenceOpener(line: string): FenceState | null {
  const match = /^(?: {0,3})(`{3,}|~{3,})(.*)$/u.exec(line);
  if (!match) return null;

  const markerRun = match[1] ?? "```";
  const marker = markerRun[0] === "~" ? "~" : "`";
  const info = match[2] ?? "";
  if (marker === "`" && info.includes("`")) return null;

  return {
    marker,
    markerLength: markerRun.length,
  };
}

function parseFenceCloser(line: string, fence: FenceState): boolean {
  const match = /^(?: {0,3})(`{3,}|~{3,})[ \t]*$/u.exec(line);
  const markerRun = match?.[1];
  if (!markerRun || markerRun[0] !== fence.marker) return false;
  return markerRun.length >= fence.markerLength;
}

function splitLineEnding(line: string): { body: string; ending: string } {
  if (line.endsWith("\r\n")) {
    return { body: line.slice(0, -2), ending: "\r\n" };
  }
  if (line.endsWith("\n")) {
    return { body: line.slice(0, -1), ending: "\n" };
  }
  return { body: line, ending: "" };
}

export function normalizeDiscordBlockquotes(markdown: string): string {
  if (!markdown.includes(">")) return markdown;

  let out = "";
  let pos = 0;
  let fence: FenceState | null = null;

  while (pos < markdown.length) {
    const newline = markdown.indexOf("\n", pos);
    const rawLine = newline === -1 ? markdown.slice(pos) : markdown.slice(pos, newline + 1);
    const { body, ending } = splitLineEnding(rawLine);

    if (fence !== null) {
      out += body + ending;
      if (parseFenceCloser(body, fence)) fence = null;
      pos += rawLine.length;
      continue;
    }

    const opener = parseFenceOpener(body);
    if (opener !== null) {
      fence = opener;
      out += body + ending;
      pos += rawLine.length;
      continue;
    }

    out += /^ {0,3}>$/u.test(body) ? `${body} ${ending}` : body + ending;
    pos += rawLine.length;
  }

  return out;
}
