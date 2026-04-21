function isCard(value) {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    typeof value.name === "string" &&
    typeof value.type === "string" &&
    typeof value.meaning_up === "string" &&
    typeof value.meaning_rev === "string" &&
    typeof value.desc === "string"
  );
}

function isDeck(value) {
  return Array.isArray(value) && value.every((item) => isCard(item));
}

const SPREADS = {
  single: {
    key: "single",
    label: "Single Card",
    description: "A simple one-card draw for general guidance.",
    positions: [{ key: "card", label: "Card", interpretation: "Core message or guiding energy." }],
  },
  "past-present-future": {
    key: "past-present-future",
    label: "Past, Present, Future",
    description: "A classic three-card spread for movement across time.",
    positions: [
      { key: "past", label: "Past", interpretation: "What has shaped the situation so far." },
      { key: "present", label: "Present", interpretation: "What is active or most important now." },
      { key: "future", label: "Future", interpretation: "Where the current path may be leading." },
    ],
  },
  "situation-obstacle-advice": {
    key: "situation-obstacle-advice",
    label: "Situation, Obstacle, Advice",
    description: "A practical spread for decision-making and next steps.",
    positions: [
      {
        key: "situation",
        label: "Situation",
        interpretation: "The heart of the current situation.",
      },
      {
        key: "obstacle",
        label: "Obstacle",
        interpretation: "The main friction, fear, or blockage.",
      },
      {
        key: "advice",
        label: "Advice",
        interpretation: "The most helpful attitude or action to take next.",
      },
    ],
  },
  "mind-body-spirit": {
    key: "mind-body-spirit",
    label: "Mind, Body, Spirit",
    description: "A balanced spread for checking in across inner and outer life.",
    positions: [
      { key: "mind", label: "Mind", interpretation: "Your thoughts, beliefs, or mental state." },
      {
        key: "body",
        label: "Body",
        interpretation: "Your physical reality, habits, or material needs.",
      },
      {
        key: "spirit",
        label: "Spirit",
        interpretation: "Your deeper values, intuition, or emotional truth.",
      },
    ],
  },
};

function pickSpread(rawMode) {
  if (typeof rawMode !== "string" || rawMode.trim().length === 0) {
    return SPREADS.single;
  }

  const normalized = rawMode.trim().toLowerCase();
  const spread = SPREADS[normalized];
  if (spread) return spread;

  throw new Error(
    "tarot mode must be one of: single, past-present-future, situation-obstacle-advice, mind-body-spirit.",
  );
}

function buildAssistantGuidance(spread) {
  const positions = spread.positions
    .map((position) => `- ${position.label}: ${position.interpretation}`)
    .join("\n");

  return [
    `Give a concise tarot reading for the '${spread.label}' spread.`,
    "Use any extra user prompt in the conversation as the reading focus.",
    "Explain each card in its spread position, then synthesize the spread into clear practical guidance.",
    "Keep the tone grounded and reflective. Do not claim certainty or supernatural authority.",
    "Spread positions:",
    positions,
  ].join("\n");
}

export async function execute(args) {
  const spread = pickSpread(args[0]);

  const raw = await Bun.file(new URL("./cards.json", import.meta.url)).json();
  if (!isDeck(raw)) {
    throw new Error("tarot cards.json is invalid.");
  }

  const deck = [...raw];
  const cards = [];

  for (const position of spread.positions) {
    if (deck.length === 0) break;

    const index = Math.floor(Math.random() * deck.length);
    const card = deck.splice(index, 1)[0];
    const orientation = Math.random() < 0.5 ? "upright" : "reversed";

    cards.push({
      position: position.key,
      position_label: position.label,
      position_interpretation: position.interpretation,
      name: card.name,
      type: card.type,
      orientation,
      meaning: orientation === "upright" ? card.meaning_up : card.meaning_rev,
      desc: card.desc,
    });
  }

  return {
    type: "json",
    value: {
      spread: {
        key: spread.key,
        label: spread.label,
        description: spread.description,
      },
      cards,
      assistant_guidance: buildAssistantGuidance(spread),
    },
  };
}
