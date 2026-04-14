function isCard(value) {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    typeof value.name === "string" &&
    typeof value.type === "string" &&
    typeof value.meaning_up === "string" &&
    typeof value.meaning_rev === "string"
  );
}

function isDeck(value) {
  return Array.isArray(value) && value.every((item) => isCard(item));
}

export async function execute(args) {
  const requested = typeof args[0] === "number" ? Math.trunc(args[0]) : 1;
  if (!Number.isFinite(requested) || requested < 1 || requested > 5) {
    throw new Error("tarot count must be a number between 1 and 5.");
  }

  const raw = await Bun.file(new URL("./cards.json", import.meta.url)).json();
  if (!isDeck(raw)) {
    throw new Error("tarot cards.json is invalid.");
  }

  const deck = [...raw];
  const cards = [];

  for (let i = 0; i < Math.min(requested, deck.length); i += 1) {
    const index = Math.floor(Math.random() * deck.length);
    const card = deck.splice(index, 1)[0];
    const orientation = Math.random() < 0.5 ? "upright" : "reversed";
    cards.push({
      name: card.name,
      type: card.type,
      orientation,
      meaning: orientation === "upright" ? card.meaning_up : card.meaning_rev,
    });
  }

  return {
    type: "json",
    value: {
      count: cards.length,
      cards,
    },
  };
}
