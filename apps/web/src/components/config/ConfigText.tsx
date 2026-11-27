import { Fragment } from "react";

function Inline({ text }: { text: string }) {
  const parts = text.split(/(`[^`\n]+`)/gu);
  return (
    <>
      {parts.map((part, index) =>
        part.startsWith("`") && part.endsWith("`") && part.length > 2 ? (
          <code key={index} className="rounded-sm bg-surface px-1 font-mono text-[0.85em]">
            {part.slice(1, -1)}
          </code>
        ) : (
          <Fragment key={index}>{part}</Fragment>
        ),
      )}
    </>
  );
}

/** Schema help text with `code` spans and blank-line paragraphs. Other Markdown stays literal. */
export function ConfigText({ text }: { text: string }) {
  const paragraphs = text.split(/\n{2,}/u);
  if (paragraphs.length === 1) return <Inline text={text} />;
  return (
    <span className="grid gap-2">
      {paragraphs.map((paragraph, index) => (
        <span key={index}>
          <Inline text={paragraph} />
        </span>
      ))}
    </span>
  );
}
