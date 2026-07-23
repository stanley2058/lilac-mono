export type ReasoningSummary = {
  readonly title: string | null;
  readonly body: string;
};

export function parseReasoningSummary(text: string): ReasoningSummary {
  const content = text.trim();
  const match = content.match(/^\*\*([^*\n]+)\*\*(?:\r?\n\r?\n|$)/u);
  if (!match) return { title: null, body: content };
  return {
    title: match[1]?.trim() || null,
    body: content.slice(match[0].length).trimEnd(),
  };
}
