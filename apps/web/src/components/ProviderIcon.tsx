import { Cpu } from "lucide-react";

export function providerName(provider: string): string {
  return (
    {
      codex: "Codex",
      "claude-code": "Claude Code",
      anthropic: "Anthropic",
      openai: "OpenAI",
      vercel: "Vercel",
      xai: "xAI",
      groq: "Groq",
      cerebras: "Cerebras",
      openrouter: "OpenRouter",
      "openai-compatible": "OpenAI compatible",
    }[provider] ?? provider
  );
}

const logos: Record<string, string> = {
  codex: "openai",
  "claude-code": "anthropic",
  openai: "openai",
  anthropic: "anthropic",
  xai: "xai",
  openrouter: "openrouter",
  groq: "groq",
  cerebras: "cerebras",
};

/** Logo files are cropped to their marks; the inset matches the padding inside Lucide glyphs. */
export function ProviderIcon({
  provider,
  className = "size-4",
}: {
  provider: string;
  className?: string;
}) {
  const logo = logos[provider];
  if (!logo && provider !== "vercel") return <Cpu aria-hidden="true" className={className} />;
  return (
    <span
      aria-hidden="true"
      className={`inline-flex shrink-0 items-center justify-center ${className}`}
    >
      {logo ? (
        <img
          src={`/providers/${logo}.svg`}
          alt=""
          className={`size-[84%] object-contain ${logo === "anthropic" ? "" : "dark:invert"}`}
        />
      ) : (
        <svg viewBox="0 0 24 21" className="size-[84%]" fill="currentColor">
          <path d="M12 0 24 21H0Z" />
        </svg>
      )}
    </span>
  );
}
