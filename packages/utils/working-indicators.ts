export const DEFAULT_WORKING_INDICATORS = [
  "Alchemizing",
  "Aromatizing",
  "Assembling",
  "Bleeping",
  "Blooming",
  "Blooping",
  "Blossoming",
  "Bouqueting",
  "Brainstorming",
  "Bubbling",
  "Calibrating",
  "Carbonating",
  "Cascading",
  "Catalyzing",
  "Compiling",
  "Composing",
  "Crystallizing",
  "Daydreaming",
  "Dazzling",
  "Decanting",
  "Deducing",
  "Defragmenting",
  "Distilling",
  "Doodling",
  "Effervescing",
  "Embroidering",
  "Extrapolating",
  "Fascinating",
  "Fathoming",
  "Fermenting",
  "Fiddling",
  "Finessing",
  "Fizzing",
  "Flourishing",
  "Formulating",
  "Gallivanting",
  "Gesticulating",
  "Glimmering",
  "Harmonizing",
  "Humming",
  "Illuminating",
  "Infusing",
  "Investigating",
  "Juggling",
  "Lavenderizing",
  "Materializing",
  "Meandering",
  "Nebulizing",
  "Orchestrating",
  "Origami-ing",
  "Parsing",
  "Perambulating",
  "Perfuming",
  "Permutating",
  "Petalling",
  "Philosophizing",
  "Photosynthesizing",
  "Phytomerizing",
  "Ping-ponging",
  "Pinging",
  "Pirouetting",
  "Plucking",
  "Polishing",
  "Pollinating",
  "Pruning",
  "Radiating",
  "Recalibrating",
  "Resonating",
  "Reverberating",
  "Rummaging",
  "Sashaying",
  "Scenting",
  "Scrutinizing",
  "Shimmering",
  "Sifting",
  "Sparkling",
  "Spiraling",
  "Sprinkling",
  "Sprouting",
  "Steeping",
  "Sublimating",
  "Synchronizing",
  "Tessellating",
  "Tiptoeing",
  "Tuning",
  "Twiddling",
  "Twinkling",
  "Unscrambling",
  "Waltzing",
  "Weaving",
  "Whispering",
  "Whittling",
  "Whizzing",
  "Zesting",
] as const;

export const WORKING_SPINNER_FRAMES = ["⣷", "⣯", "⣟", "⡿", "⢿", "⣻", "⣽", "⣾"] as const;
export const WORKING_SPINNER_TICK_MS = 250;

export function cloneDefaultWorkingIndicators(): string[] {
  return [...DEFAULT_WORKING_INDICATORS];
}

export function createWorkingIndicatorQueue(
  indicators: readonly string[],
  random: () => number = Math.random,
): string[] {
  if (indicators.length <= 1) return [...indicators];

  const queue = [...indicators];
  for (let index = queue.length - 1; index > 0; index -= 1) {
    const otherIndex = Math.floor(random() * (index + 1));
    const current = queue[index];
    const other = queue[otherIndex];
    if (current === undefined || other === undefined) continue;
    queue[index] = other;
    queue[otherIndex] = current;
  }
  return queue;
}

export function formatWorkingStatus(input: {
  readonly nowMs: number;
  readonly startedAtMs: number;
  readonly indicator: string;
}): string {
  const elapsedMs = Math.max(0, input.nowMs - input.startedAtMs);
  const elapsedSec = Math.floor(elapsedMs / 1_000);
  const frameIndex =
    Math.floor(elapsedMs / WORKING_SPINNER_TICK_MS) % WORKING_SPINNER_FRAMES.length;
  const spinner = WORKING_SPINNER_FRAMES[frameIndex] ?? WORKING_SPINNER_FRAMES[0];
  const indicator = input.indicator.trim().length > 0 ? input.indicator.trim() : "Working";
  return `${spinner} ${indicator}... ${elapsedSec}s`;
}
