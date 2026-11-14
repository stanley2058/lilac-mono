import { Cpu } from "lucide-react";
import { useImageFailure } from "../image-retry";

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
  const [failed, fail] = useImageFailure<true>();
  const logo = logos[provider];
  if ((!logo && provider !== "vercel") || failed)
    return <Cpu aria-hidden="true" className={className} />;
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
          onError={() => fail(true)}
        />
      ) : (
        <svg viewBox="0 0 24 21" className="size-[84%]" fill="currentColor">
          <path d="M12 0 24 21H0Z" />
        </svg>
      )}
    </span>
  );
}

const providerCodes: Record<string, string> = {
  codex: "CX",
  openai: "OA",
  "claude-code": "CC",
  anthropic: "AN",
};

/** Shows the provider logo with its short code, so OpenAI and Codex stay distinct. */
export function ProviderTabIcon({
  provider,
  size = "md",
}: {
  provider: string;
  size?: "sm" | "md";
}) {
  const code = providerCodes[provider];
  const box = size === "sm" ? "size-4" : "size-5";
  return (
    <span aria-hidden="true" className={`relative inline-flex ${box} items-center justify-center`}>
      <ProviderIcon provider={provider} className={box} />
      {code ? (
        <span className="absolute -right-1 -bottom-1 rounded-sm bg-popover px-0.5 font-mono text-provider-code leading-none font-medium text-popover-foreground">
          {code}
        </span>
      ) : null}
    </span>
  );
}
