import { useState } from "react";
import type { CatalogModelChoice, ModelReasoning } from "@stanley2058/lilac-client-protocol";
import { ModelSelectorView } from "./ModelSelector";

const models: CatalogModelChoice[] = [
  {
    id: "codex/gpt-6-astra",
    provider: "codex",
    model: "gpt-6-astra",
    label: "GPT-6 Astra",
    legacy: false,
    reasoning: ["provider-default", "low", "medium", "high", "max"],
  },
  {
    id: "codex/gpt-6.1-sol",
    provider: "codex",
    model: "gpt-6.1-sol",
    label: "GPT-6.1 Sol",
    legacy: false,
    reasoning: ["provider-default", "low", "medium", "high", "max"],
  },
  {
    id: "codex/gpt-5.4",
    provider: "codex",
    model: "gpt-5.4",
    label: "GPT-5.4",
    legacy: true,
    reasoning: ["provider-default", "low", "high"],
  },
  {
    id: "openai/gpt-6-astra",
    provider: "openai",
    model: "gpt-6-astra",
    label: "GPT-6 Astra",
    legacy: false,
    reasoning: ["provider-default"],
  },
  {
    id: "claude-code/claude-opus-5-5",
    provider: "claude-code",
    model: "claude-opus-5-5",
    label: "Claude Opus 5.5",
    legacy: false,
    reasoning: ["provider-default", "low", "medium", "high", "max"],
  },
  {
    id: "anthropic/claude-opus-5-5",
    provider: "anthropic",
    model: "claude-opus-5-5",
    label: "Claude Opus 5.5",
    legacy: false,
    reasoning: ["provider-default"],
  },
  {
    id: "vercel/anthropic/claude-opus-5.5",
    provider: "vercel",
    model: "anthropic/claude-opus-5.5",
    label: "Claude Opus 5.5",
    legacy: false,
    reasoning: ["provider-default", "low", "high"],
  },
];
export function ModelSelectorDemo() {
  const [selected, setSelected] = useState({
    model: models[0]!.id,
    reasoning: "medium" as ModelReasoning,
  });
  const [favorites, setFavorites] = useState([
    models[0]!.id,
    models[1]!.id,
    models[3]!.id,
    models[4]!.id,
    models[5]!.id,
  ]);
  return (
    <ModelSelectorView
      models={models}
      providers={["codex", "openai", "claude-code", "anthropic", "vercel"]}
      favorites={favorites}
      modelId={selected.model}
      reasoning={selected.reasoning}
      disabled={false}
      onChange={(model, reasoning) =>
        setSelected({ model, reasoning: reasoning ?? "provider-default" })
      }
      onFavorite={(id) =>
        setFavorites((current) =>
          current.includes(id) ? current.filter((entry) => entry !== id) : [...current, id],
        )
      }
    />
  );
}
