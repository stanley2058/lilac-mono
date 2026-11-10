import type {
  ConversationThreadAutoInjectQueryPlan,
  ConversationThreadSearchResult,
} from "./thread-service";

const RECIPROCAL_RANK_K = 10;

const RANKING_STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "for",
  "from",
  "he",
  "her",
  "his",
  "in",
  "is",
  "it",
  "of",
  "on",
  "or",
  "she",
  "that",
  "the",
  "their",
  "to",
  "was",
  "with",
]);

type SearchEntry = ConversationThreadSearchResult["results"][number];

export type AutoInjectRankingSearchResult = {
  searchIndex: number;
  result: ConversationThreadSearchResult;
};

export type AutoInjectRankingBreakdown = {
  reciprocalRank: number;
  weightedAnchorCoverage: number;
  domainCoverage: number;
  targetCoverage: number;
  situationCoverage: number;
  askPhraseCoverage: number;
  specificityGate: number;
};

export type RankedAutoInjectThread = {
  result: SearchEntry;
  searchIndex: number;
  rank: number;
  rawScore: number;
  confidence: number;
  selection: "recall-floor" | "confidence";
  breakdown: AutoInjectRankingBreakdown;
};

export type RankedAutoInjectCandidate = Omit<RankedAutoInjectThread, "selection">;

export type AutoInjectRankingResult = {
  selected: RankedAutoInjectThread[];
  highestRejectedByConfidence: RankedAutoInjectCandidate | null;
};

type InverseDocumentFrequency = {
  weight(token: string): number;
};

function rankingTokens(input: string): Set<string> {
  const tokens = input
    .toLowerCase()
    .match(/[\p{L}\p{N}]+/gu)
    ?.filter((token) => token.length > 1 && !RANKING_STOP_WORDS.has(token));
  return new Set(tokens ?? []);
}

function buildInverseDocumentFrequency(documents: readonly string[]): InverseDocumentFrequency {
  const documentFrequencies = new Map<string, number>();
  for (const document of documents) {
    for (const token of rankingTokens(document)) {
      documentFrequencies.set(token, (documentFrequencies.get(token) ?? 0) + 1);
    }
  }
  const documentCount = Math.max(1, documents.length);
  return {
    weight: (token) =>
      Math.log((documentCount + 1) / ((documentFrequencies.get(token) ?? 0) + 1)) + 1,
  };
}

function weightedQueryCoverage(
  queryPhrases: readonly string[],
  candidatePhrases: readonly string[],
  idf: InverseDocumentFrequency,
): number {
  const candidateTokens = rankingTokens(candidatePhrases.join(" "));
  let bestCoverage = 0;
  for (const phrase of queryPhrases) {
    const queryTokens = rankingTokens(phrase);
    let totalWeight = 0;
    let matchedWeight = 0;
    for (const token of queryTokens) {
      const weight = idf.weight(token);
      totalWeight += weight;
      if (candidateTokens.has(token)) matchedWeight += weight;
    }
    if (totalWeight > 0) bestCoverage = Math.max(bestCoverage, matchedWeight / totalWeight);
  }
  return bestCoverage;
}

function normalizedReciprocalRank(input: {
  result: SearchEntry;
  rank: number;
  queryCount: number;
}): number {
  const attributions = input.result.queryAttribution;
  if (!attributions || attributions.length === 0) {
    return (RECIPROCAL_RANK_K + 1) / (RECIPROCAL_RANK_K + input.rank);
  }
  const sum = attributions.reduce(
    (total, attribution) =>
      total + (RECIPROCAL_RANK_K + 1) / (RECIPROCAL_RANK_K + attribution.rank),
    0,
  );
  return sum / Math.max(1, input.queryCount);
}

/** A thread yields one result per subject, so results are ranked and excluded per entry. */
function entryId(result: SearchEntry): string {
  return result.entryId ?? result.threadId;
}

function candidateDocument(result: SearchEntry): string {
  return [
    result.title,
    result.brief,
    ...(result.topics ?? []),
    ...(result.retrievalHints ?? []),
    ...(result.aboutness?.domains ?? []),
    ...(result.aboutness?.situations ?? []),
    ...(result.aboutness?.complaintTargets ?? []),
    ...(result.aboutness?.entities ?? []),
    ...(result.aboutness?.userWouldAskForThisAs ?? []),
  ].join(" ");
}

function rankCandidate(input: {
  result: SearchEntry;
  rank: number;
  searchIndex: number;
  plan: ConversationThreadAutoInjectQueryPlan["searches"][number];
  idf: InverseDocumentFrequency;
}): RankedAutoInjectCandidate {
  const candidateAboutness = input.result.aboutness;
  const domainCoverage = weightedQueryCoverage(
    input.plan.aboutness.domains,
    [...(candidateAboutness?.domains ?? []), ...(input.result.topics ?? [])],
    input.idf,
  );
  const targetCoverage = weightedQueryCoverage(
    input.plan.aboutness.targets,
    [
      ...(candidateAboutness?.complaintTargets ?? []),
      ...(candidateAboutness?.situations ?? []),
      ...(input.result.retrievalHints ?? []),
    ],
    input.idf,
  );
  const situationCoverage = weightedQueryCoverage(
    input.plan.aboutness.situations,
    [
      ...(candidateAboutness?.situations ?? []),
      ...(input.result.retrievalHints ?? []),
      ...(input.result.topics ?? []),
    ],
    input.idf,
  );
  const askPhraseCoverage = weightedQueryCoverage(
    [
      ...input.plan.queries,
      ...input.plan.aboutness.userWouldAskForThisAs,
      input.plan.aboutness.intentSummary,
    ],
    [
      ...(candidateAboutness?.userWouldAskForThisAs ?? []),
      ...(input.result.retrievalHints ?? []),
      input.result.title,
    ],
    input.idf,
  );
  const weightedAnchorCoverage =
    domainCoverage * 0.15 +
    targetCoverage * 0.35 +
    situationCoverage * 0.3 +
    askPhraseCoverage * 0.2;
  const reciprocalRank = normalizedReciprocalRank({
    result: input.result,
    rank: input.rank,
    queryCount: input.plan.queries.length,
  });
  const specificCoverage = Math.max(targetCoverage, situationCoverage, askPhraseCoverage);
  let specificityGate: number;
  if (specificCoverage < 0.2) specificityGate = 0.15;
  else if (specificCoverage < 0.35) specificityGate = 0.45;
  else specificityGate = 1;
  const confidence = (reciprocalRank * 0.5 + weightedAnchorCoverage * 0.5) * specificityGate;

  return {
    result: input.result,
    searchIndex: input.searchIndex,
    rank: input.rank,
    rawScore: input.result.score ?? 0,
    confidence,
    breakdown: {
      reciprocalRank,
      weightedAnchorCoverage,
      domainCoverage,
      targetCoverage,
      situationCoverage,
      askPhraseCoverage,
      specificityGate,
    },
  };
}

function compareRankedCandidates(
  left: RankedAutoInjectCandidate,
  right: RankedAutoInjectCandidate,
): number {
  if (left.confidence !== right.confidence) return right.confidence - left.confidence;
  if (left.rawScore !== right.rawScore) return right.rawScore - left.rawScore;
  if (left.searchIndex !== right.searchIndex) return left.searchIndex - right.searchIndex;
  return left.rank - right.rank;
}

export function rankAutoInjectedThreadSearchResults(input: {
  plan: ConversationThreadAutoInjectQueryPlan;
  searches: readonly AutoInjectRankingSearchResult[];
  corpusDocuments?: readonly string[];
  excludedEntryIds?: ReadonlySet<string>;
  limit: number;
  expansionMinConfidence: number;
}): AutoInjectRankingResult {
  const candidates = input.searches.flatMap(({ searchIndex, result }) =>
    result.results
      .filter((entry) => !input.excludedEntryIds?.has(entryId(entry)))
      .map((entry, index) => ({ searchIndex, result: entry, rank: index + 1 })),
  );
  if (candidates.length === 0 || input.limit <= 0) {
    return { selected: [], highestRejectedByConfidence: null };
  }

  const corpusDocuments =
    input.corpusDocuments && input.corpusDocuments.length > 0
      ? input.corpusDocuments
      : candidates.map((candidate) => candidateDocument(candidate.result));
  const idf = buildInverseDocumentFrequency(corpusDocuments);
  const bestByEntryId = new Map<string, RankedAutoInjectCandidate>();
  for (const candidate of candidates) {
    const plan = input.plan.searches[candidate.searchIndex];
    if (!plan) continue;
    const ranked = rankCandidate({ ...candidate, plan, idf });
    const existing = bestByEntryId.get(entryId(candidate.result));
    if (!existing || compareRankedCandidates(ranked, existing) < 0) {
      bestByEntryId.set(entryId(candidate.result), ranked);
    }
  }

  const ranked = [...bestByEntryId.values()].sort(compareRankedCandidates);
  const floor = ranked[0];
  if (!floor) return { selected: [], highestRejectedByConfidence: null };
  const selected: RankedAutoInjectThread[] = [{ ...floor, selection: "recall-floor" }];
  let highestRejectedByConfidence: RankedAutoInjectCandidate | null = null;
  for (const candidate of ranked.slice(1)) {
    if (candidate.confidence < input.expansionMinConfidence) {
      highestRejectedByConfidence ??= candidate;
      continue;
    }
    if (selected.length >= input.limit) continue;
    selected.push({ ...candidate, selection: "confidence" });
  }
  return { selected, highestRejectedByConfidence };
}
