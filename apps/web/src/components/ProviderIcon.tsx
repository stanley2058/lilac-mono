import { Cpu, Triangle } from "lucide-react";

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

export function ProviderIcon({
  provider,
  className = "size-4",
}: {
  provider: string;
  className?: string;
}) {
  const logo = {
    codex: "openai",
    "claude-code": "anthropic",
    openai: "openai",
    anthropic: "anthropic",
    xai: "xai",
    openrouter: "openrouter",
    groq: "groq",
    cerebras: "cerebras",
  }[provider];
  if (provider === "vercel")
    return <Triangle aria-hidden="true" className={className} fill="currentColor" />;
  if (!logo) return <Cpu aria-hidden="true" className={className} />;
  return (
    <img
      src={`/providers/${logo}.svg`}
      alt=""
      className={`${className} object-contain ${logo === "anthropic" ? "" : "dark:invert"}`}
    />
  );
}
