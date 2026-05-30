export interface ReportEntry {
  caseId: string;
  category: string;
  description: string;
  pinnedBeliefs: string[];
  relevantBeliefs: string[];
  retrievedQuestions: string[];
  retrievalPrecision: number | null;
  retrievalRecall: number | null;
  pinnedCoverage: number | null;
  passed: boolean;
  failures: string[];
  retrievalLatencyMs: number;
}

export interface ReportEntryBase {
  category: string;
  retrievalLatencyMs: number;
  retrievalPrecision: number | null;
  retrievalRecall: number | null;
  passed: boolean;
}

export interface ReportSummaryOptions {
  provider: string;
  entries: ReportEntryBase[];
  caseCount: number;
  turnCount?: number;
  ingestion?: {
    beliefCount: number;
    totalMs: number;
    meanPerBeliefMs: number;
    perBelief: { beliefId: string; latencyMs: number }[];
  };
}

export interface CategoryBreakdown {
  category: string;
  caseCount: number;
  passed: number;
  failed: number;
  meanPrecision: number | null;
  meanRecall: number | null;
}

export interface PassTypeBreakdown {
  activeRetrieval: number;
  structural: number;
  triviallyEmpty: number;
}

export interface RetrievalSummary {
  meanLatencyMs: number;
  p50LatencyMs: number;
  p95LatencyMs: number;
  caseCount: number;
  turnCount?: number;
  meanPrecision: number | null;
  meanRecall: number | null;
  totalPassed: number;
  totalCases: number;
  passRate: number | null;
  activeRetrievalPasses: number;
  passTypes: PassTypeBreakdown;
  categories: CategoryBreakdown[];
}

const STRUCTURAL_CATEGORIES = new Set([
  "Scope disambiguation",
  "Supersession chain exclusion",
  "Type routing and open questions",
  "Budget eviction and capacity",
  "Cross-user isolation",
  "Ranking stability",
  "Persona prelude content",
]);

function classifyPass(entry: ReportEntryBase): keyof PassTypeBreakdown {
  if (entry.retrievalPrecision !== null && entry.retrievalPrecision > 0) {
    return "activeRetrieval";
  }
  if (STRUCTURAL_CATEGORIES.has(entry.category)) {
    return "structural";
  }
  return "triviallyEmpty";
}

export function buildRetrievalSummary(
  opts: ReportSummaryOptions,
): RetrievalSummary {
  const { entries } = opts;

  const latencies = entries.map((r) => r.retrievalLatencyMs);
  const sorted = [...latencies].sort((a, b) => a - b);
  const meanLatency =
    latencies.length > 0
      ? Math.round(
          (latencies.reduce((s, v) => s + v, 0) / latencies.length) * 100,
        ) / 100
      : 0;
  const p50 = sorted[Math.ceil(0.5 * sorted.length) - 1] ?? 0;
  const p95 = sorted[Math.ceil(0.95 * sorted.length) - 1] ?? 0;

  const precisionValues = entries
    .map((r) => r.retrievalPrecision)
    .filter((v): v is number => v !== null);
  const recallValues = entries
    .map((r) => r.retrievalRecall)
    .filter((v): v is number => v !== null);

  const meanPrecision =
    precisionValues.length > 0
      ? Math.round(
          (precisionValues.reduce((s, v) => s + v, 0) /
            precisionValues.length) *
            10000,
        ) / 10000
      : null;

  const meanRecall =
    recallValues.length > 0
      ? Math.round(
          (recallValues.reduce((s, v) => s + v, 0) / recallValues.length) *
            10000,
        ) / 10000
      : null;

  const totalPassed = entries.filter((r) => r.passed).length;
  const totalCases = entries.length;

  const passTypes: PassTypeBreakdown = {
    activeRetrieval: 0,
    structural: 0,
    triviallyEmpty: 0,
  };
  for (const entry of entries) {
    if (!entry.passed) continue;
    passTypes[classifyPass(entry)]++;
  }

  const categoryMap = new Map<string, ReportEntryBase[]>();
  for (const entry of entries) {
    const cat = entry.category;
    if (!categoryMap.has(cat)) categoryMap.set(cat, []);
    categoryMap.get(cat)!.push(entry);
  }

  const categories: CategoryBreakdown[] = [...categoryMap.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .map(([category, caseEntries]) => {
      const passed = caseEntries.filter((e) => e.passed).length;
      const failed = caseEntries.length - passed;

      const catPrecision = caseEntries
        .map((e) => e.retrievalPrecision)
        .filter((v): v is number => v !== null);
      const catRecall = caseEntries
        .map((e) => e.retrievalRecall)
        .filter((v): v is number => v !== null);

      return {
        category,
        caseCount: caseEntries.length,
        passed,
        failed,
        meanPrecision:
          catPrecision.length > 0
            ? Math.round(
                (catPrecision.reduce((s, v) => s + v, 0) /
                  catPrecision.length) *
                  10000,
              ) / 10000
            : null,
        meanRecall:
          catRecall.length > 0
            ? Math.round(
                (catRecall.reduce((s, v) => s + v, 0) / catRecall.length) *
                  10000,
              ) / 10000
            : null,
      };
    });

  const summary: RetrievalSummary = {
    meanLatencyMs: meanLatency,
    p50LatencyMs: p50,
    p95LatencyMs: p95,
    caseCount: opts.caseCount,
    meanPrecision,
    meanRecall,
    totalPassed,
    totalCases,
    passRate:
      totalCases > 0
        ? Math.round((totalPassed / totalCases) * 10000) / 10000
        : null,
    activeRetrievalPasses: passTypes.activeRetrieval,
    passTypes,
    categories,
  };

  if (opts.turnCount !== undefined) summary.turnCount = opts.turnCount;

  return summary;
}

export function buildReportPayload(
  opts: ReportSummaryOptions,
  cases: unknown,
): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    provider: opts.provider,
    retrieval: buildRetrievalSummary(opts),
    cases,
  };
  if (opts.ingestion) payload.ingestion = opts.ingestion;
  return payload;
}
