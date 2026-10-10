export const WORKING_INDICATOR_INTERVAL_MS = 4_000;
export const FALLBACK_WORKING_INDICATORS: readonly string[] = ["Working"];

function hash(text: string): number {
  let value = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    value ^= text.charCodeAt(index);
    value = Math.imul(value, 0x01000193);
  }
  return value >>> 0;
}

export function workingIndicatorBucket(elapsedMs: number): number {
  return Math.floor(Math.max(0, elapsedMs) / WORKING_INDICATOR_INTERVAL_MS);
}

// Every client derives the same word from the turn and elapsed time, so a reload or another
// device shows the word the turn settled on without storing it. Nonzero steps keep consecutive
// words distinct.
export function workingIndicatorAt(words: readonly string[], seed: string, bucket: number): string {
  if (words.length === 0) return FALLBACK_WORKING_INDICATORS[0]!;
  let index = hash(`${seed}:0`) % words.length;
  if (words.length === 1) return words[index]!;
  for (let step = 1; step <= bucket; step += 1)
    index = (index + 1 + (hash(`${seed}:${step}`) % (words.length - 1))) % words.length;
  return words[index]!;
}

// The live word follows this browser's clock while the settled word follows server timestamps, so
// skew or a late settle event can disagree by a bucket. Turns watched live settle on the bucket they
// last showed; others use the server duration.
const lastShownBuckets = new Map<string, number>();

export function rememberShownWorkingIndicator(seed: string, bucket: number): void {
  lastShownBuckets.set(seed, bucket);
}

export function settledWorkingIndicatorBucket(seed: string, durationMs: number): number {
  return lastShownBuckets.get(seed) ?? workingIndicatorBucket(durationMs);
}

export function pastTense(word: string): string {
  const match = /ing$/i.exec(word);
  if (!match) return word;
  const stem = word.slice(0, match.index);
  const suffix = match[0] === "ING" ? "ED" : "ed";
  return /e$/i.test(stem) ? `${stem}${suffix.slice(1)}` : `${stem}${suffix}`;
}
