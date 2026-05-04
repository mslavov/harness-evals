import type { AssertionResult } from '../assertions/types.js';
import type { CostReport, CostRollup, CostSummary, UsageReport } from './types.js';

const NO_CURRENCY = '__unspecified__';
const COST_FIELDS = [
  'inputTokens',
  'outputTokens',
  'cachedInputTokens',
  'reasoningTokens',
  'totalTokens',
  'toolCalls',
  'requests',
] as const;

type CostField = typeof COST_FIELDS[number];

export interface CostDimensions {
  stepId?: string;
  stepKey?: string;
  originalStepId?: string;
  stepIndex?: number;
  testCaseId?: string;
  scenarioId?: string;
  agentName?: string;
  runId?: string;
  provider?: string;
  model?: string;
  source?: string;
}

export interface CostReportEntry extends CostDimensions {
  report?: CostReport;
}

export interface CostSummaryInput extends CostDimensions {
  entries: readonly CostReportEntry[];
  metadata?: Record<string, unknown>;
}

interface Bucket {
  fields: Partial<Record<CostField, number>>;
  costsByCurrency: Map<string, number>;
}

interface RollupAccumulator {
  additive: Bucket;
  latestCumulative?: Bucket;
  reports: number;
  availableReports: number;
  missingReports: number;
  cumulative: boolean;
}

export function missingCostReport(reason = 'not_reported', dimensions: CostDimensions = {}): CostReport {
  return {
    available: false,
    usage: [],
    byProvider: {},
    byModel: {},
    metadata: pruneRecord({
      missing: true,
      missingReason: reason,
      dimensions: compactDimensions(dimensions),
    }),
  };
}

export function normalizeCostReport(
  report: CostReport | undefined,
  dimensions: CostDimensions = {},
  missingReason = 'not_reported',
): CostReport {
  if (!report || report.available === false || !hasCostReportData(report)) {
    return missingCostReport(missingReason, dimensions);
  }

  const usage = report.usage?.filter(hasUsageData).map(cloneUsage);
  const byProvider = cloneRollups(report.byProvider) ?? deriveProviderRollups(report, dimensions);
  const byModel = cloneRollups(report.byModel) ?? deriveModelRollups(report, dimensions);
  const rollup = rollupFromReport({ ...report, usage, byProvider, byModel });
  const metadata = pruneRecord({
    ...(report.metadata ?? {}),
    dimensions: pruneRecord({
      ...readRecord(report.metadata?.dimensions),
      ...compactDimensions(dimensions),
    }),
    missingTotalCost: report.totalCost === undefined && rollup.totalCost === undefined ? true : undefined,
  });

  return {
    available: true,
    currency: report.currency,
    totalCost: report.totalCost ?? rollup.totalCost,
    totalTokens: report.totalTokens ?? rollup.totalTokens,
    usage: usage && usage.length > 0 ? usage : undefined,
    byProvider,
    byModel,
    metadata,
  };
}

export function mergeCostReports(reports: Array<CostReport | undefined>, dimensions: CostDimensions = {}): CostReport | undefined {
  const present = reports
    .filter((report): report is CostReport => Boolean(report))
    .map((report) => normalizeCostReport(report, dimensions));
  const available = present.filter((report) => report.available !== false && hasCostReportData(report));
  if (available.length === 0) return undefined;

  const summary = buildCostSummary({
    ...dimensions,
    entries: available.map((report, index) => ({ ...dimensions, stepKey: `source-${index}`, report })),
    metadata: { sourceReports: available.length },
  });
  const usage = available.flatMap((report) => report.usage ?? []);

  return {
    available: summary.available,
    currency: summary.currency,
    totalCost: summary.totalCost,
    totalTokens: summary.rollup.totalTokens,
    usage: usage.length > 0 ? usage : undefined,
    byProvider: summary.byProvider,
    byModel: summary.byModel,
    metadata: pruneRecord({
      ...summary.metadata,
      dimensions: compactDimensions(dimensions),
      sourceReports: available.length,
      cumulative: summary.metadata?.cumulative,
      costByCurrency: readRecord(summary.rollup.metadata?.costByCurrency),
    }),
  };
}

export function buildStepCostReport(input: {
  adapterCost?: CostReport;
  assertions: readonly AssertionResult[];
  dimensions: CostDimensions;
}): CostReport {
  const adapter = normalizeCostReport(input.adapterCost, input.dimensions, 'adapter_not_reported');
  const judge = costReportFromJudgeAssertions(input.assertions, { ...input.dimensions, source: 'judge' });

  if (adapter.available !== false || judge) {
    const merged = mergeCostReports([adapter.available === false ? undefined : adapter, judge], input.dimensions);
    if (merged) {
      merged.metadata = pruneRecord({
        ...(merged.metadata ?? {}),
        adapterCostAvailable: adapter.available !== false,
        includesJudgeCosts: Boolean(judge),
        adapterCostMissingReason: adapter.available === false ? adapter.metadata?.missingReason : undefined,
      });
      return merged;
    }
  }

  return adapter;
}

export function costReportFromJudgeAssertions(
  assertions: readonly AssertionResult[],
  dimensions: CostDimensions = {},
): CostReport | undefined {
  const reports: CostReport[] = [];

  for (const assertion of assertions) {
    if (assertion.type !== 'llmJudge') continue;
    const metadata = readRecord(assertion.metadata);
    const usage = readRecord(metadata?.usage);
    const cost = readRecord(metadata?.cost);
    if (!usage && !cost) continue;

    const provider = readString(usage?.provider) ?? readString(metadata?.provider) ?? dimensions.provider;
    const model = readString(usage?.model) ?? readString(metadata?.model) ?? dimensions.model;
    const currency = readString(usage?.currency) ?? readString(cost?.currency);
    const totalCost = numberOrUndefined(usage?.totalCost)
      ?? numberOrUndefined(readRecord(usage?.cost)?.total)
      ?? numberOrUndefined(readRecord(usage?.cost)?.totalCost)
      ?? numberOrUndefined(cost?.totalCost)
      ?? numberOrUndefined(cost?.total);
    const usageReport = provider && model ? pruneRecord({
      provider,
      model,
      inputTokens: numberOrUndefined(usage?.inputTokens) ?? numberOrUndefined(usage?.input),
      outputTokens: numberOrUndefined(usage?.outputTokens) ?? numberOrUndefined(usage?.output),
      cachedInputTokens: numberOrUndefined(usage?.cachedInputTokens) ?? numberOrUndefined(usage?.cacheRead),
      reasoningTokens: numberOrUndefined(usage?.reasoningTokens),
      totalTokens: numberOrUndefined(usage?.totalTokens),
      toolCalls: numberOrUndefined(usage?.toolCalls),
      requests: numberOrUndefined(usage?.requests) ?? 1,
      totalCost,
      currency,
      metadata: pruneRecord({ source: 'judge', assertionId: assertion.id }),
    }) as unknown as UsageReport : undefined;

    const report = normalizeCostReport({
      currency,
      totalCost,
      usage: usageReport ? [usageReport] : undefined,
      metadata: pruneRecord({
        source: 'judge',
        assertionId: assertion.id,
        cumulative: readBoolean(metadata?.cumulative) || readBoolean(usage?.cumulative) || undefined,
      }),
    }, { ...dimensions, source: 'judge' });

    if (report.available !== false && hasCostReportData(report)) reports.push(report);
  }

  return mergeCostReports(reports, { ...dimensions, source: 'judge' });
}

export function buildCostSummary(input: CostSummaryInput): CostSummary {
  const overall = createAccumulator();
  const providerAccumulators = new Map<string, RollupAccumulator>();
  const modelAccumulators = new Map<string, RollupAccumulator>();
  const agentAccumulators = new Map<string, RollupAccumulator>();
  const scenarioAccumulators = new Map<string, RollupAccumulator>();
  const testCaseAccumulators = new Map<string, RollupAccumulator>();
  const runAccumulators = new Map<string, RollupAccumulator>();
  const steps: Record<string, CostReport> = {};
  let cumulative = false;

  for (const [index, entry] of input.entries.entries()) {
    const dimensions = { ...input, ...entry };
    const report = normalizeCostReport(entry.report, dimensions);
    const stepKey = entry.stepKey ?? entry.stepId ?? `step-${index}`;
    steps[stepKey] = report;

    const reportCumulative = isCumulativeReport(report);
    cumulative ||= reportCumulative;
    const reportRollup = rollupFromReport(report);
    addRollup(overall, reportRollup, report.currency ?? reportRollup.currency, reportCumulative, report.available !== false);

    addDimensionRollup(agentAccumulators, entry.agentName ?? input.agentName, reportRollup, report, reportCumulative);
    addDimensionRollup(scenarioAccumulators, entry.scenarioId ?? input.scenarioId, reportRollup, report, reportCumulative);
    addDimensionRollup(testCaseAccumulators, entry.testCaseId ?? input.testCaseId, reportRollup, report, reportCumulative);
    addDimensionRollup(runAccumulators, entry.runId ?? input.runId, reportRollup, report, reportCumulative);

    for (const [provider, rollup] of Object.entries(providerRollups(report, dimensions))) {
      addDimensionRollup(providerAccumulators, provider, rollup, report, reportCumulative);
    }
    for (const [model, rollup] of Object.entries(modelRollups(report, dimensions))) {
      addDimensionRollup(modelAccumulators, model, rollup, report, reportCumulative);
    }
  }

  const rollup = finalizeAccumulator(overall);
  return {
    available: overall.availableReports > 0,
    currency: rollup.currency,
    totalCost: rollup.totalCost,
    rollup,
    byProvider: finalizeAccumulatorMap(providerAccumulators),
    byModel: finalizeAccumulatorMap(modelAccumulators),
    byAgent: finalizeAccumulatorMap(agentAccumulators),
    byScenario: finalizeAccumulatorMap(scenarioAccumulators),
    byTestCase: finalizeAccumulatorMap(testCaseAccumulators),
    byRun: finalizeAccumulatorMap(runAccumulators),
    steps,
    metadata: pruneRecord({
      ...(input.metadata ?? {}),
      dimensions: compactDimensions(input),
      stepCount: input.entries.length,
      availableSteps: overall.availableReports,
      missingSteps: overall.missingReports,
      cumulative: cumulative || undefined,
      costByCurrency: readRecord(rollup.metadata?.costByCurrency),
      currencyStatus: rollup.metadata?.currencyStatus,
    }),
  };
}

export function totalCostForScoring(cost: CostReport | undefined): number | undefined {
  if (!cost || cost.available === false) return undefined;
  if (typeof cost.totalCost === 'number' && Number.isFinite(cost.totalCost)) return cost.totalCost;
  const rollup = rollupFromReport(cost);
  return typeof rollup.totalCost === 'number' && Number.isFinite(rollup.totalCost) ? rollup.totalCost : undefined;
}

export function totalTokensForScoring(cost: CostReport | undefined): number | undefined {
  if (!cost || cost.available === false) return undefined;
  const rollup = rollupFromReport(cost);
  return typeof rollup.totalTokens === 'number' && Number.isFinite(rollup.totalTokens) ? rollup.totalTokens : undefined;
}

export function isCumulativeReport(report: CostReport | undefined): boolean {
  const metadata = readRecord(report?.metadata);
  return readBoolean(metadata?.cumulative)
    || readBoolean(metadata?.isCumulative)
    || metadata?.accounting === 'cumulative'
    || metadata?.costAccounting === 'cumulative'
    || metadata?.totalType === 'cumulative';
}

function addDimensionRollup(
  accumulators: Map<string, RollupAccumulator>,
  key: string | undefined,
  rollup: CostRollup,
  report: CostReport,
  cumulative: boolean,
): void {
  if (!key) return;
  addRollup(getAccumulator(accumulators, key), rollup, rollup.currency ?? report.currency, cumulative, report.available !== false);
}

function providerRollups(report: CostReport, dimensions: CostDimensions): Record<string, CostRollup> {
  const direct = cloneRollups(report.byProvider);
  if (direct) return direct;
  return deriveProviderRollups(report, dimensions);
}

function modelRollups(report: CostReport, dimensions: CostDimensions): Record<string, CostRollup> {
  const direct = cloneRollups(report.byModel);
  if (direct) return direct;
  return deriveModelRollups(report, dimensions);
}

function deriveProviderRollups(report: CostReport, dimensions: CostDimensions): Record<string, CostRollup> {
  const derived = deriveUsageRollups(report.usage, 'provider');
  if (Object.keys(derived).length > 0) return attributeSingleReportCost(report, derived);
  return dimensions.provider ? { [dimensions.provider]: rollupFromReport(report) } : {};
}

function deriveModelRollups(report: CostReport, dimensions: CostDimensions): Record<string, CostRollup> {
  const derived = deriveUsageRollups(report.usage, 'model');
  if (Object.keys(derived).length > 0) return attributeSingleReportCost(report, derived);
  return dimensions.model ? { [dimensions.model]: rollupFromReport(report) } : {};
}

function deriveUsageRollups(usage: UsageReport[] | undefined, key: 'provider' | 'model'): Record<string, CostRollup> {
  if (!usage || usage.length === 0) return {};
  const accumulators = new Map<string, RollupAccumulator>();
  for (const item of usage) {
    const group = item[key];
    if (!group) continue;
    addRollup(getAccumulator(accumulators, group), rollupFromUsage(item), item.currency, isCumulativeUsage(item), true);
  }
  return finalizeAccumulatorMap(accumulators);
}

function attributeSingleReportCost(report: CostReport, rollups: Record<string, CostRollup>): Record<string, CostRollup> {
  const keys = Object.keys(rollups);
  if (keys.length !== 1 || report.totalCost === undefined || rollups[keys[0]].totalCost !== undefined) return rollups;
  return {
    ...rollups,
    [keys[0]]: {
      ...rollups[keys[0]],
      currency: report.currency ?? rollups[keys[0]].currency,
      totalCost: report.totalCost,
    },
  };
}

function rollupFromUsage(usage: UsageReport): CostRollup {
  return pruneRecord({
    currency: usage.currency,
    totalCost: numberOrUndefined(usage.totalCost),
    inputTokens: numberOrUndefined(usage.inputTokens),
    outputTokens: numberOrUndefined(usage.outputTokens),
    cachedInputTokens: numberOrUndefined(usage.cachedInputTokens),
    reasoningTokens: numberOrUndefined(usage.reasoningTokens),
    totalTokens: numberOrUndefined(usage.totalTokens),
    toolCalls: numberOrUndefined(usage.toolCalls),
    requests: numberOrUndefined(usage.requests),
  }) as unknown as CostRollup;
}

function rollupFromReport(report: CostReport): CostRollup {
  const costRollup = report.totalCost === undefined ? costFromRollups(report.byProvider) ?? costFromRollups(report.byModel) : undefined;
  return pruneRecord({
    currency: report.currency ?? costRollup?.currency,
    totalCost: report.totalCost ?? costRollup?.totalCost,
    inputTokens: sumField(report, 'inputTokens'),
    outputTokens: sumField(report, 'outputTokens'),
    cachedInputTokens: sumField(report, 'cachedInputTokens'),
    reasoningTokens: sumField(report, 'reasoningTokens'),
    totalTokens: report.totalTokens ?? sumField(report, 'totalTokens'),
    toolCalls: sumField(report, 'toolCalls'),
    requests: sumField(report, 'requests'),
    metadata: costRollup?.metadata,
  }) as unknown as CostRollup;
}

function costFromRollups(rollups: Record<string, CostRollup> | undefined): CostRollup | undefined {
  if (!rollups || Object.keys(rollups).length === 0) return undefined;
  const accumulator = createAccumulator();
  for (const rollup of Object.values(rollups)) addRollup(accumulator, rollup, rollup.currency, false, hasRollupData(rollup));
  const result = finalizeAccumulator(accumulator);
  return result.totalCost === undefined && !result.metadata?.costByCurrency ? undefined : result;
}

function sumField(report: CostReport, field: CostField): number | undefined {
  const usageValues = report.usage?.map((usage) => numberOrUndefined(usage[field]));
  const usageSum = sumDefined(usageValues ?? []);
  if (usageSum !== undefined) return usageSum;
  const providerSum = sumDefined(Object.values(report.byProvider ?? {}).map((rollup) => numberOrUndefined(rollup[field])));
  if (providerSum !== undefined) return providerSum;
  return sumDefined(Object.values(report.byModel ?? {}).map((rollup) => numberOrUndefined(rollup[field])));
}

function createAccumulator(): RollupAccumulator {
  return {
    additive: { fields: {}, costsByCurrency: new Map() },
    reports: 0,
    availableReports: 0,
    missingReports: 0,
    cumulative: false,
  };
}

function getAccumulator(map: Map<string, RollupAccumulator>, key: string): RollupAccumulator {
  const existing = map.get(key);
  if (existing) return existing;
  const created = createAccumulator();
  map.set(key, created);
  return created;
}

function addRollup(
  accumulator: RollupAccumulator,
  rollup: CostRollup,
  currency: string | undefined,
  cumulative: boolean,
  available: boolean,
): void {
  accumulator.reports += 1;
  if (!available || !hasRollupData(rollup)) {
    accumulator.missingReports += 1;
    return;
  }
  accumulator.availableReports += 1;

  const bucket = bucketFromRollup(rollup, currency);
  if (cumulative) {
    accumulator.latestCumulative = bucket;
    accumulator.cumulative = true;
    return;
  }
  mergeBucket(accumulator.additive, bucket);
}

function finalizeAccumulator(accumulator: RollupAccumulator): CostRollup {
  const merged: Bucket = { fields: {}, costsByCurrency: new Map() };
  mergeBucket(merged, accumulator.additive);
  if (accumulator.latestCumulative) mergeBucket(merged, accumulator.latestCumulative);

  const rollup = bucketToRollup(merged);
  const metadata = pruneRecord({
    ...(rollup.metadata ?? {}),
    reports: accumulator.reports || undefined,
    availableReports: accumulator.availableReports || undefined,
    missingReports: accumulator.missingReports || undefined,
    cumulative: accumulator.cumulative || undefined,
  });
  return Object.keys(metadata).length > 0 ? { ...rollup, metadata } : rollup;
}

function finalizeAccumulatorMap(map: Map<string, RollupAccumulator>): Record<string, CostRollup> {
  return Object.fromEntries([...map.entries()].map(([key, accumulator]) => [key, finalizeAccumulator(accumulator)]));
}

function bucketFromRollup(rollup: CostRollup, currency: string | undefined): Bucket {
  const bucket: Bucket = { fields: {}, costsByCurrency: new Map() };
  for (const field of COST_FIELDS) {
    const value = numberOrUndefined(rollup[field]);
    if (value !== undefined) bucket.fields[field] = value;
  }
  const totalCost = numberOrUndefined(rollup.totalCost);
  if (totalCost !== undefined) addCurrencyCost(bucket, currency, totalCost);
  const costByCurrency = readRecord(rollup.metadata?.costByCurrency);
  if (costByCurrency) {
    for (const [entryCurrency, value] of Object.entries(costByCurrency)) {
      const total = numberOrUndefined(value);
      if (total !== undefined) addCurrencyCost(bucket, entryCurrency === 'unspecified' ? undefined : entryCurrency, total);
    }
  }
  return bucket;
}

function mergeBucket(target: Bucket, source: Bucket): void {
  for (const field of COST_FIELDS) {
    const value = source.fields[field];
    if (value !== undefined) target.fields[field] = (target.fields[field] ?? 0) + value;
  }
  for (const [currency, totalCost] of source.costsByCurrency.entries()) {
    target.costsByCurrency.set(currency, (target.costsByCurrency.get(currency) ?? 0) + totalCost);
  }
}

function bucketToRollup(bucket: Bucket): CostRollup {
  const metadata: Record<string, unknown> = {};
  const costEntries = [...bucket.costsByCurrency.entries()].filter(([, total]) => Number.isFinite(total));
  let currency: string | undefined;
  let totalCost: number | undefined;

  if (costEntries.length === 1) {
    const [key, total] = costEntries[0];
    totalCost = total;
    currency = key === NO_CURRENCY ? undefined : key;
  } else if (costEntries.length > 1) {
    metadata.currencyStatus = 'mixed';
    metadata.costByCurrency = Object.fromEntries(costEntries.map(([key, total]) => [key === NO_CURRENCY ? 'unspecified' : key, total]));
  }

  return pruneRecord({
    currency,
    totalCost,
    inputTokens: bucket.fields.inputTokens,
    outputTokens: bucket.fields.outputTokens,
    cachedInputTokens: bucket.fields.cachedInputTokens,
    reasoningTokens: bucket.fields.reasoningTokens,
    totalTokens: bucket.fields.totalTokens,
    toolCalls: bucket.fields.toolCalls,
    requests: bucket.fields.requests,
    metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
  }) as unknown as CostRollup;
}

function addCurrencyCost(bucket: Bucket, currency: string | undefined, totalCost: number): void {
  const key = currency ?? NO_CURRENCY;
  bucket.costsByCurrency.set(key, (bucket.costsByCurrency.get(key) ?? 0) + totalCost);
}

function hasCostReportData(report: CostReport): boolean {
  if (numberOrUndefined(report.totalCost) !== undefined || numberOrUndefined(report.totalTokens) !== undefined) return true;
  if (report.usage?.some(hasUsageData)) return true;
  if (Object.values(report.byProvider ?? {}).some(hasRollupData)) return true;
  if (Object.values(report.byModel ?? {}).some(hasRollupData)) return true;
  return false;
}

function hasUsageData(usage: UsageReport): boolean {
  return COST_FIELDS.some((field) => numberOrUndefined(usage[field]) !== undefined)
    || numberOrUndefined(usage.totalCost) !== undefined
    || Boolean(usage.metadata && Object.keys(usage.metadata).length > 0);
}

function hasRollupData(rollup: CostRollup): boolean {
  return COST_FIELDS.some((field) => numberOrUndefined(rollup[field]) !== undefined)
    || numberOrUndefined(rollup.totalCost) !== undefined
    || Boolean(readRecord(rollup.metadata?.costByCurrency));
}

function cloneUsage(usage: UsageReport): UsageReport {
  return {
    provider: usage.provider,
    model: usage.model,
    inputTokens: numberOrUndefined(usage.inputTokens),
    outputTokens: numberOrUndefined(usage.outputTokens),
    cachedInputTokens: numberOrUndefined(usage.cachedInputTokens),
    reasoningTokens: numberOrUndefined(usage.reasoningTokens),
    totalTokens: numberOrUndefined(usage.totalTokens),
    toolCalls: numberOrUndefined(usage.toolCalls),
    requests: numberOrUndefined(usage.requests),
    totalCost: numberOrUndefined(usage.totalCost),
    currency: usage.currency,
    metadata: usage.metadata ? { ...usage.metadata } : undefined,
  };
}

function cloneRollups(rollups: Record<string, CostRollup> | undefined): Record<string, CostRollup> | undefined {
  if (!rollups || Object.keys(rollups).length === 0) return undefined;
  return Object.fromEntries(Object.entries(rollups).map(([key, rollup]) => [key, { ...rollup, metadata: rollup.metadata ? { ...rollup.metadata } : undefined }]));
}

function isCumulativeUsage(usage: UsageReport): boolean {
  const metadata = readRecord(usage.metadata);
  return readBoolean(metadata?.cumulative)
    || readBoolean(metadata?.isCumulative)
    || metadata?.accounting === 'cumulative'
    || metadata?.costAccounting === 'cumulative'
    || metadata?.totalType === 'cumulative';
}

function compactDimensions(dimensions: CostDimensions): Record<string, unknown> {
  return pruneRecord({
    stepId: dimensions.stepId,
    originalStepId: dimensions.originalStepId,
    stepIndex: dimensions.stepIndex,
    testCaseId: dimensions.testCaseId,
    scenarioId: dimensions.scenarioId,
    agentName: dimensions.agentName,
    runId: dimensions.runId,
    provider: dimensions.provider,
    model: dimensions.model,
    source: dimensions.source,
  });
}

function pruneRecord<T extends Record<string, unknown>>(record: T): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined));
}

function sumDefined(values: Array<number | undefined>): number | undefined {
  const present = values.filter((value): value is number => value !== undefined);
  return present.length > 0 ? present.reduce((total, value) => total + value, 0) : undefined;
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function readBoolean(value: unknown): boolean {
  return value === true;
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
